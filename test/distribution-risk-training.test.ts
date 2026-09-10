import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { loadConfig } from "../src/config.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { readRiskTrainingSourceHashes } from "../src/distribution/risk-training-source.js";
import { packRiskTrainingOrigins, readRiskTrainingOrigins, MAXIMUM_DECODED_ORIGIN_BYTES } from "../src/distribution/risk-training-origins.js";
import type { RecordedEvent } from "../src/backtest/replay.js";
import { LocalOrderBook } from "../src/core/order-book.js";
import { FeatureEngine } from "../src/core/features.js";
import { BookPressureTracker, DeterministicFeatureExtensions } from "../src/strategy/deterministic-features.js";
import { DistributionController } from "../src/distribution/controller.js";
import { buildDistributionTraining, prepareDistributionTraining } from "../src/distribution/training-backfill.js";
import { createRiskBoundedTrainingContext, RISK_TRAINING_VERSION, RiskTrainingFeaturePath, trainingContextHash } from "../src/distribution/risk-training-context.js";
import { mergeDistributionTraining } from "../src/distribution/training-import.js";
import { DISTRIBUTION_ENTRY_PROFILES, DISTRIBUTION_SPEC } from "../src/distribution/spec.js";

// Synthetic constant-price fixtures test accounting/parity only. They are not
// research performance or executable profitability evidence.
const cfg = loadConfig({ TRADING_MODE: "paper", DISTRIBUTIONAL_ENGINE_ENABLED: "true" });
const context = createRiskBoundedTrainingContext(cfg.symbolConfigs, cfg.distributionalSizingPolicy!, 100_000);
const profile = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT;
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol,
  { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 100, shortable: true }]));
const start = Date.UTC(2026, 8, 5), cutoff = start + 3_603_000;
const controller = () => new DistributionController(costs, structuredClone(assets), profile,
  { efficientTraining: true, sizingPolicy: context.sizingPolicy });
function book(atMs: number, symbol = "BTC/USD", depth = 100): Extract<RecordedEvent, { kind: "BOOK" }> {
  return { kind: "BOOK", delta: { symbol, sourceId: `${symbol}:${atMs}`, reset: true,
    exchangeTsMs: atMs, receiveTsMs: atMs, bids: [{ px: 100, qty: depth }], asks: [{ px: 100.01, qty: depth }] } };
}
function* events() {
  for (let now = start; now <= cutoff; now += 1000) { yield book(now); yield book(now, "ETH/USD"); }
}
let prepared: ReturnType<typeof buildDistributionTraining> | undefined;
const fixture = () => prepared ??= buildDistributionTraining(events(), costs, assets, { cutoffMs: cutoff, riskContext: context });
async function artifact() {
  const built = await fixture(), sourceCodeHashes = readRiskTrainingSourceHashes();
  return { ...structuredClone(built.state), trainingBackfill: { ...structuredClone(built.report),
    inputFiles: [{ path: "synthetic-events.jsonl", bytes: 1000, sha256: "b".repeat(64) }],
    instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
    sourceCodeHashes, sourceCodeSha256: trainingContextHash(sourceCodeHashes) } };
}

test("sizing features match live book and trade update order including causal trade-clock advancement", () => {
  const path = new RiskTrainingFeaturePath(context), own = cfg.symbolConfigs["BTC/USD"]!;
  const raw = new LocalOrderBook("BTC/USD"), base = new FeatureEngine(own.feature);
  const extension = new DeterministicFeatureExtensions(own.deterministicExtension), pressure = new BookPressureTracker(own.feature.depthLevels);
  for (let i = 0; i < 40; i++) {
    const event = book(start + i * 1000), update = raw.apply(event.delta);
    assert.ok(update.accepted && update.state);
    const expectedBase = base.onBook(update.state, update.flow)!;
    const expected = extension.update(expectedBase, pressure.update(update.state));
    const actual = path.onBook(update.state, update.flow)!;
    assert.deepEqual(actual.features, expected);
    const trade = { id: String(i), symbol: "BTC/USD", exchangeTsMs: event.delta.receiveTsMs + 200,
      receiveTsMs: event.delta.receiveTsMs + 200, px: 100.01, qty: .5, aggressor: 1 as const };
    path.onTrade(trade, raw.snapshot()); base.onTrade(trade);
    const eventBook = { ...raw.snapshot(), receiveTsMs: trade.receiveTsMs };
    extension.update(base.onBook(eventBook)!, pressure.update(eventBook));
  }
});

test("risk-sized raw replay preserves current policy, learns independent complete actions, and records recomputable quantities", async () => {
  const built = await fixture();
  assert.equal(built.report.version, RISK_TRAINING_VERSION);
  assert.equal(built.state.selectionPolicyVersion, profile.selectionPolicyVersion);
  assert.equal("sizingPolicyId" in built.state && built.state.sizingPolicyId, context.sizingPolicyId);
  assert.ok(built.state.samples.length > 12, "independent short horizons mature before a full panel");
  assert.ok(built.state.samples.every(s => s.sizingPolicyId === context.sizingPolicyId
    && s.outcomes.length === 3 && s.outcomes.every(o => o.status === "FILLED" && o.netBps! < 0)));
  assert.ok(built.report.origins!.every(o => o.requestedQty * o.referenceAsk > 12));
  assert.equal(built.report.origins!.length, new Set(built.state.samples.map(s => `${s.symbol}:${s.signalAtMs}`)).size);
  assert.deepEqual(built.state.validationSelections, []); assert.deepEqual(built.state.pendingSelections, []);
  assert.equal(built.report.brokerOrdersSubmitted, 0); assert.equal(built.report.profitabilityEstablished, false);
  assert.equal(built.report.observedFundingCashIncluded, false);
  assert.equal(controller().restoreState(built.state, cutoff), built.state.samples.length);
  await assert.rejects(buildDistributionTraining([book(cutoff + 1000)], costs, assets,
    { cutoffMs: cutoff + 1000, initialState: built.state }), /CANNOT_STRIP_RISK_SIZING/);
});

test("v2 importer accepts only matching current sizing and feature provenance; import adds labels without permission", async () => {
  const source = await artifact(), live = controller().exportState();
  const merged = mergeDistributionTraining(live, source, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes());
  assert.equal(merged.report.addedSamples, source.samples.length);
  assert.equal(merged.report.brokerOrdersSubmitted, 0);
  assert.equal(merged.report.prospectiveValidationReset, true);
  assert.equal(merged.report.validation.ready, false);
  assert.equal(controller().restoreState(merged.state, cutoff), source.samples.length);
  const repeated = mergeDistributionTraining(merged.state, source, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes());
  assert.equal(repeated.report.addedSamples, 0); assert.equal(repeated.report.prospectiveValidationReset, false);
  const changed = structuredClone(context); changed.symbols["BTC/USD"]!.feature.volatilityTauMs += 1;
  assert.throws(() => mergeDistributionTraining(live, source, costs, assets, cutoff, profile, changed, readRiskTrainingSourceHashes()), /PROVENANCE/);
  const changedPolicy = structuredClone(context); changedPolicy.sizingPolicy.maximumEquityFraction *= .5;
  assert.throws(() => mergeDistributionTraining(live, source, costs, assets, cutoff, profile, changedPolicy, readRiskTrainingSourceHashes()), /HASH_MISMATCH/);
  assert.throws(() => mergeDistributionTraining(live, source, costs, assets, cutoff, profile), /FIXED_SIZE_BACKFILL_INCOMPATIBLE/);
  const legacy = new DistributionController(costs, assets).exportState();
  assert.throws(() => mergeDistributionTraining(live, legacy, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /FIXED_SIZE_BACKFILL_INCOMPATIBLE/);
  assert.deepEqual(live.samples, [], "isolated merge does not mutate live bank");
});

test("v2 importer rejects forged quantity despite recomputed origin hashes, future labels, and selection claims", async () => {
  const live = controller().exportState();
  const quantity = await artifact();
  const origin = quantity.trainingBackfill.origins![0]!; origin.requestedQty *= 2;
  const { originSha256: _ignored, ...body } = origin; origin.originSha256 = trainingContextHash(body);
  quantity.trainingBackfill.originsSha256 = trainingContextHash(quantity.trainingBackfill.origins);
  assert.throws(() => mergeDistributionTraining(live, quantity, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /QUANTITY_MISMATCH/);
  const future = await artifact(); future.samples[0]!.completedAtMs = cutoff + 1000;
  assert.throws(() => mergeDistributionTraining(live, future, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /COVERAGE/);
  const missing = await artifact(); missing.trainingBackfill.origins!.pop();
  assert.throws(() => mergeDistributionTraining(live, missing, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /ORIGIN_AUDIT/);
  const selection = await artifact(); (selection.validationSelections as unknown[]).push({ fabricated: true });
  assert.throws(() => mergeDistributionTraining(live, selection, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /PROVENANCE/);
  const old = await artifact(); old.trainingBackfill.version = `${DISTRIBUTION_SPEC.version}:training-backfill-v1`;
  assert.throws(() => mergeDistributionTraining(live, old, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /PROVENANCE/);
  const staleCode = await artifact(); staleCode.trainingBackfill.sourceCodeHashes[0]!.sha256 = "0".repeat(64);
  staleCode.trainingBackfill.sourceCodeSha256 = trainingContextHash(staleCode.trainingBackfill.sourceCodeHashes);
  assert.throws(() => mergeDistributionTraining(live, staleCode, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes()), /SOURCE_CODE_MISMATCH/);
  assert.throws(() => mergeDistributionTraining(live, quantity, costs, assets, cutoff, profile, context), /SOURCE_CODE_MISMATCH/);
});

test("actual engine imports current v2 labels before account reconciliation with zero equity and creates no orders", async () => {
  const engineCfg = loadConfig({ TRADING_MODE: "paper", DISTRIBUTIONAL_ENGINE_ENABLED: "true",
    DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "true", DISTRIBUTIONAL_EFFICIENT_TRAINING_ENABLED: "true",
    DISTRIBUTIONAL_SIZING_MODE: "RISK_BOUNDED", CONTINUOUS_RECORDING_ENABLED: "false" });
  const engine = new TradingEngine(engineCfg, { now: () => cutoff, distributionalAssets: assets });
  assert.equal((engine as unknown as { equity: number }).equity, 0);
  assert.equal((engine as unknown as { started: boolean }).started, false);
  const source = await artifact();
  const { origins, ...metadata } = source.trainingBackfill;
  const wire = { ...source, trainingBackfill: { ...metadata, originsPacked: packRiskTrainingOrigins(origins!) } };
  const first = engine.importDistributionalTraining(wire, assets);
  assert.equal(first.addedSamples, source.samples.length); assert.equal(first.brokerOrdersSubmitted, 0);
  assert.equal(engine.importDistributionalTraining(wire, assets).addedSamples, 0);
  assert.equal(engine.exportDistributionalState()!.sizingPolicyId, context.sizingPolicyId);
  assert.equal(engine.exportDistributionalState()!.samples.length, source.samples.length);
  assert.equal((engine as unknown as { equity: number }).equity, 0);
  assert.equal((engine as unknown as { started: boolean }).started, false);
});

test("resuming risk labels cannot relabel stale execution source code or overlapping receipt history", async () => {
  const source = await artifact();
  const resumed = await buildDistributionTraining([book(cutoff + 1000), book(cutoff + 1000, "ETH/USD")],
    costs, assets, { cutoffMs: cutoff + 1000, riskContext: context, initialState: source });
  assert.equal(resumed.state.samples.length, source.samples.length);
  assert.equal(resumed.report.restoredSamples, source.samples.length);
  assert.deepEqual(resumed.state.validationSelections, []);
  const stale = structuredClone(source); stale.trainingBackfill.sourceCodeHashes[0]!.sha256 = "0".repeat(64);
  stale.trainingBackfill.sourceCodeSha256 = trainingContextHash(stale.trainingBackfill.sourceCodeHashes);
  await assert.rejects(buildDistributionTraining([book(cutoff + 1000)], costs, assets,
    { cutoffMs: cutoff + 1000, riskContext: context, initialState: stale }), /RESUME_PROVENANCE_MISMATCH/);
  await assert.rejects(buildDistributionTraining([book(cutoff - 1)], costs, assets,
    { cutoffMs: cutoff + 1000, riskContext: context, initialState: source }), /RECEIPT_FLOOR|OVERLAPS_REPLAY_HISTORY/);
});

test("risk artifact publication requires source hashes and excludes future/private events without inventing labels", async t => {
  const directory = await mkdtemp(join(tmpdir(), "risk-training-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "events.jsonl.gz"), out = join(directory, "sized.json");
  const rows = [book(start), book(start, "ETH/USD"), book(start + 10_000)];
  const bytes = gzipSync(rows.map(e => JSON.stringify(e)).join("\n") + "\n"); await writeFile(input, bytes);
  await assert.rejects(prepareDistributionTraining([input], out, costs, assets,
    { cutoffMs: start + 1000, riskContext: context }), /SOURCE_CODE_HASHES_REQUIRED/);
  const result = await prepareDistributionTraining([input], out, costs, assets, { cutoffMs: start + 1000,
    riskContext: context, sourceCodeHashes: readRiskTrainingSourceHashes() });
  assert.equal(result.report.futureEventsExcluded, 1); assert.equal(result.state.samples.length, 0);
  assert.equal(result.report.inputFiles[0]!.sha256, createHash("sha256").update(bytes).digest("hex"));
  const value = JSON.parse(await readFile(out, "utf8"));
  assert.equal(value.trainingBackfill.riskContextSha256, trainingContextHash(context));
  assert.equal(value.sizingPolicyId, context.sizingPolicyId);
  assert.equal(Object.hasOwn(value.trainingBackfill, "origins"), false);
  assert.deepEqual(readRiskTrainingOrigins(value.trainingBackfill), []);
  assert.equal(mergeDistributionTraining(controller().exportState(), value, costs, assets, start + 1000, profile, context, readRiskTrainingSourceHashes()).report.addedSamples, 0);
});

test("packed origins preserve every book, feature, label and hash and import/resume without changing source identities", async () => {
  const source = await artifact(), packed = structuredClone(source);
  const rawOrigins = source.trainingBackfill.origins!;
  const provenance = packed.trainingBackfill as unknown as Record<string, unknown>;
  provenance.originsPacked = packRiskTrainingOrigins(rawOrigins); delete provenance.origins;
  assert.deepEqual(readRiskTrainingOrigins(provenance), rawOrigins);
  assert.equal(trainingContextHash(readRiskTrainingOrigins(provenance)), source.trainingBackfill.originsSha256);
  assert.equal(provenance.sourceCodeSha256, source.trainingBackfill.sourceCodeSha256);
  const live = controller().exportState();
  const rawMerge = mergeDistributionTraining(live, source, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes());
  const packedMerge = mergeDistributionTraining(live, packed, costs, assets, cutoff, profile, context, readRiskTrainingSourceHashes());
  assert.deepEqual(packedMerge, rawMerge);
  const resumed = await buildDistributionTraining([book(cutoff + 1000), book(cutoff + 1000, "ETH/USD")],
    costs, assets, { cutoffMs: cutoff + 1000, riskContext: context, initialState: packed });
  assert.deepEqual(resumed.state.samples, source.samples);
});

test("packed origin decoding rejects conflicts, unknown formats, malformed encodings, corrupt/truncated gzip and bounded expansion", async () => {
  const origins = (await artifact()).trainingBackfill.origins!, encoded = packRiskTrainingOrigins(origins);
  const decode = (value: unknown) => readRiskTrainingOrigins({ originsPacked: value });
  assert.throws(() => readRiskTrainingOrigins({ origins, originsPacked: encoded }), /REPRESENTATION/);
  assert.throws(() => readRiskTrainingOrigins({}), /REPRESENTATION/);
  assert.throws(() => decode({ ...encoded, encoding: "unknown" }), /PACKED_ORIGINS/);
  assert.throws(() => decode({ ...encoded, extra: true }), /PACKED_ORIGINS/);
  assert.throws(() => decode({ ...encoded, data: encoded.data + "\n" }), /PACKED_ORIGINS/);
  assert.throws(() => decode({ ...encoded, data: "====" }), /PACKED_ORIGINS/);
  assert.throws(() => decode({ ...encoded, decodedBytes: MAXIMUM_DECODED_ORIGIN_BYTES + 1 }), /PACKED_ORIGINS/);
  assert.throws(() => decode({ ...encoded, gzipSha256: "0".repeat(64) }), /COMPRESSED_HASH/);
  assert.throws(() => decode({ ...encoded, decodedSha256: "0".repeat(64) }), /DECODED_HASH/);
  assert.throws(() => decode({ ...encoded, decodedBytes: encoded.decodedBytes + 1 }), /DECODED_HASH_OR_SIZE/);
  assert.throws(() => decode({ ...encoded, decodedBytes: 2 }), /OVERSIZED_GZIP/);
  const truncated = Buffer.from(encoded.data, "base64").subarray(0, -4);
  assert.throws(() => decode({ ...encoded, data: truncated.toString("base64"),
    gzipSha256: createHash("sha256").update(truncated).digest("hex") }), /INVALID_OR_OVERSIZED_GZIP/);
  const corrupt = Buffer.from(encoded.data, "base64"); corrupt[0] = corrupt[0]! ^ 1;
  assert.throws(() => decode({ ...encoded, data: corrupt.toString("base64"),
    gzipSha256: createHash("sha256").update(corrupt).digest("hex") }), /INVALID_OR_OVERSIZED_GZIP/);
  const notJson = Buffer.from("x".repeat(1024)), nonJsonGzip = gzipSync(notJson);
  assert.throws(() => decode({ ...encoded, data: nonJsonGzip.toString("base64"), decodedBytes: notJson.length,
    gzipSha256: createHash("sha256").update(nonJsonGzip).digest("hex"),
    decodedSha256: createHash("sha256").update(notJson).digest("hex") }), /INVALID_JSON/);
});
