import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { RegimeDistributionModel, REGIME_DISTRIBUTION_SPEC } from "../src/distribution/regime-model.js";
import { EfficientDistributionTrainer } from "../src/distribution/efficient-trainer.js";
import { executableDistributionDecision } from "../src/distribution/planner.js";
import { mergeDistributionTraining } from "../src/distribution/training-import.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS, DISTRIBUTION_SPEC as S,
  distributionEntryProfile, type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, START = Date.UTC(2026, 8, 1);
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true,
}]));
const profile = () => distributionEntryProfile(true, true, true);
const candidate = () => new DistributionController(costs, { ...assets }, profile(), { efficientTraining: true, regimeModel: true });
const previous = () => new DistributionController(costs, { ...assets }, distributionEntryProfile(true, true), { efficientTraining: true });
function book(atMs: number, bid = 100, ask = 100.01): BookState {
  return { symbol: "BTC/USD", bids: [{ px: bid, qty: 1 }], asks: [{ px: ask, qty: 1 }],
    receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: true };
}
function ready(t: TestContext): void {
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => ({ symbol: b.symbol, atMs: b.receiveTsMs,
    ready: true, reason: "READY", features: Array<number>(12).fill(0) }));
}
function seed() {
  const state = new DistributionController(costs, { ...assets }, distributionEntryProfile(true)).exportState();
  for (let day = 0; day < 3; day++) for (let index = 0; index < 24; index++) for (const action of ACTIONS) {
    const atMs = START + day * DAY + index * S.proposalIntervalMs, netBps = action.id === "long-5m" ? 60 : -30;
    state.samples.push({ id: `BTC/USD:${action.id}:${atMs}`, symbol: "BTC/USD", actionId: action.id,
      signalAtMs: atMs, completedAtMs: atMs + 2000, features: Array<number>(12).fill(0),
      outcomes: SCENARIOS.map(s => ({ scenario: s.id, status: "FILLED", netBps, grossBps: netBps + 20,
        filledFraction: 1, entryAtMs: atMs + s.latencyMs, exitAtMs: atMs + 2000, reason: "FIXTURE_OBSERVED_OUTCOME" })) });
  }
  return state;
}
const labels = (rows: DistributionSample[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const cutoff = (state: ReturnType<typeof seed>) => Math.max(...state.samples.map(row => row.completedAtMs));

test("regime prediction requires its explicit paper and efficient options and matching execution profile", t => {
  ready(t);
  assert.throws(() => distributionEntryProfile(false, true, true), /PAPER|EFFICIENT|REGIME/);
  assert.throws(() => distributionEntryProfile(true, false, true), /EFFICIENT|REGIME/);
  assert.throws(() => new DistributionController(costs, assets, distributionEntryProfile(true), { regimeModel: true }), /EFFICIENT|REGIME/);
  assert.throws(() => new DistributionController(costs, assets, profile(), { efficientTraining: true }), /PROFILE|OPTION|REGIME/);
  const state = seed(), now = cutoff(state) + 1000, controller = candidate();
  controller.restoreState(state, now - 1000);
  const quote = book(now), decision = controller.onBook(quote).decision!;
  assert.equal(decision.selectionPolicyVersion, profile().selectionPolicyVersion);
  assert.equal(decision.actionId, "long-5m"); assert.equal(decision.paperReady, true);
  assert.ok(executableDistributionDecision(decision, quote, now, profile()));
  assert.equal(executableDistributionDecision(decision, quote, now, distributionEntryProfile(true, true)), null);
  assert.equal(controller.stats(now).predictionModelVersion, REGIME_DISTRIBUTION_SPEC.version);
  assert.equal(controller.stats(now).minimumSamples, 48);
  assert.equal(controller.stats(now).minimumEffectiveSamples, 32);
  assert.equal(controller.stats(now).minimumTrainingDays, 3);
});

test("migrated labels feed the actual regime estimator and the default trainer remains the original estimator", t => {
  ready(t);
  const state = seed(), at = cutoff(state), source = previous(); source.restoreState(state, at);
  const saved = source.exportState(), controller = candidate(); controller.restoreState(saved, at);
  const direct = new RegimeDistributionModel(), legacy = new ConditionalDistributionModel();
  for (const row of saved.samples) { assert.equal(direct.observe(row), true); assert.equal(legacy.observe(row), true); }
  const now = at + 1000, features = Array<number>(12).fill(0), decision = controller.onBook(book(now)).decision!;
  const actual = decision.estimates.find(row => row.actionId === "long-5m")!;
  assert.deepEqual(actual, direct.estimate("BTC/USD", "long-5m", features, now, 3));
  assert.notEqual(actual.meanNetBps, legacy.estimate("BTC/USD", "long-5m", features, now, 3).meanNetBps,
    "cost-aware regime estimates must not silently route to the original net-shrink model");
  const defaultTrainer = new EfficientDistributionTrainer(costs, assets, saved.samples, at);
  const regimeTrainer = new EfficientDistributionTrainer(costs, assets, saved.samples, at, { regimeModel: true });
  assert.deepEqual(defaultTrainer.estimate("BTC/USD", "long-5m", features, now), legacy.estimate("BTC/USD", "long-5m", features, now, 3));
  assert.deepEqual(regimeTrainer.estimate("BTC/USD", "long-5m", features, now), actual);
  assert.deepEqual(regimeTrainer.exportSamples(), defaultTrainer.exportSamples());
  assert.deepEqual(regimeTrainer.exportSchedulerState(), defaultTrainer.exportSchedulerState());
});

test("regime live learning retains short outcomes immediately and preserves independent training clocks", t => {
  ready(t);
  const controller = candidate();
  for (let at = 0; at <= 301_000; at += 1000) controller.onBook(book(at));
  assert.equal(controller.stats(301_000).learning.acceptedSamples, 0);
  const result = controller.onBook(book(301_750));
  assert.equal(result.decision, null);
  assert.deepEqual(result.samples.map(row => row.actionId), ["long-5m", "short-5m"]);
  assert.equal(controller.stats(301_750).learning.acceptedSamples, 2);
  const saved = controller.exportState(), restored = candidate(); restored.restoreState(saved, 301_750);
  assert.deepEqual(labels(restored.exportState().samples), labels(saved.samples));
  assert.deepEqual(restored.exportState().efficientTraining!.nextOrigins, saved.efficientTraining!.nextOrigins);
  restored.onBook(book(359_999)); assert.equal(restored.stats(359_999).pendingTrainingActions, 0);
  restored.onBook(book(360_000)); assert.equal(restored.stats(360_000).pendingTrainingActions, 2);
  assert.ok(restored.stats(360_000).efficientTraining!.byAction.filter(row => row.symbol === "BTC/USD"
    && !row.actionId.endsWith("-5m")).every(row => row.pendingSignalAtMs === null));
});

test("switching either direction preserves labels and scheduler clocks while clearing the old selected-policy validation", t => {
  ready(t);
  for (const [makeSource, makeTarget] of [[previous, candidate], [candidate, previous]] as const) {
    const state = seed(), at = cutoff(state) + 1000, source = makeSource(); source.restoreState(state, at - 1000);
    assert.equal(source.onBook(book(at)).decision!.actionId, "long-5m");
    source.onBook(book(at + 250)); source.onBook(book(at + 750));
    for (const delta of [1000, 1250, 1750]) source.onBook(book(at + delta, 101, 101.01));
    const saved = source.exportState(); assert.equal(saved.validationSelections.length, 1);
    const restored = makeTarget(); assert.equal(restored.restoreState(saved, at + 2000), saved.samples.length);
    const exported = restored.exportState();
    assert.deepEqual(labels(exported.samples), labels(saved.samples));
    assert.deepEqual(exported.efficientTraining!.nextOrigins, saved.efficientTraining!.nextOrigins);
    assert.notEqual(exported.selectionPolicyVersion, saved.selectionPolicyVersion);
    assert.equal(exported.validationSelections.length, 0); assert.equal(exported.pendingSelections.length, 0);
    assert.equal(restored.stats(at + 2000).validation.selections, 0);
  }
});

test("a failed regime checkpoint migration cannot mutate the active bank or scheduler", t => {
  ready(t);
  const state = seed(), at = cutoff(state), controller = candidate(); controller.restoreState(state, at);
  controller.onBook(book(at + 1000));
  const original = controller.exportState();
  for (const corrupt of [
    (value: typeof original) => { value.samples[0]!.completedAtMs = at + 10_000; },
    (value: typeof original) => { value.efficientTraining!.nextOrigins["BTC/USD:300000"] = 0; },
  ]) {
    const invalid = structuredClone(original); corrupt(invalid);
    assert.throws(() => controller.restoreState(invalid, at + 2000), /CHECKPOINT|EFFICIENT|TRAINING|CLOCK/);
    assert.deepEqual(controller.exportState(), original);
  }
});

test("legacy historical import into a migrated regime bank is idempotent and preserves the active predictor and clocks", t => {
  ready(t);
  for (const missingFirstPanel of [false, true]) {
    const full = seed(), historicalEnd = cutoff(full), at = historicalEnd + 1000, now = at + 2000;
    const partial = structuredClone(full);
    if (missingFirstPanel) partial.samples.splice(0, ACTIONS.length);
    const old = previous(); old.restoreState(partial, historicalEnd);
    const active = candidate(); active.restoreState(old.exportState(), historicalEnd);
    assert.equal(active.onBook(book(at)).decision!.actionId, "long-5m");
    active.onBook(book(at + 250)); active.onBook(book(at + 750));
    for (const delta of [1000, 1250, 1750]) active.onBook(book(at + delta, 101, 101.01));
    const current = active.exportState(), before = structuredClone(current);
    assert.equal(current.validationSelections.length, 1);
    const artifact = { ...full, trainingBackfill: { version: `${S.version}:training-backfill-v1`, cutoffMs: now,
      trainingOnly: true, prospectiveSelectionsCreated: 0, brokerOrdersSubmitted: 0,
      profitabilityEstablished: false, deploymentReady: false, spec: S, costs, assets,
      instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
      inputFiles: [{ path: "/synthetic-regime-historical-fixture.jsonl", bytes: 1, sha256: "0".repeat(64) }],
      quality: { firstMs: START, lastMs: historicalEnd }, retainedSamples: full.samples.length,
      retainedPanels: full.samples.length / ACTIONS.length } };
    const result = mergeDistributionTraining(current, artifact, costs, assets, now, profile());
    assert.equal(result.report.addedSamples, missingFirstPanel ? ACTIONS.length : 0);
    assert.equal(result.report.prospectiveValidationReset, missingFirstPanel);
    assert.equal(result.report.validation.selections, missingFirstPanel ? 0 : 1);
    assert.equal(result.report.brokerOrdersSubmitted, 0);
    assert.equal(result.state.selectionPolicyVersion, profile().selectionPolicyVersion);
    assert.ok("efficientTraining" in result.state);
    assert.deepEqual(result.state.efficientTraining, before.efficientTraining);
    assert.deepEqual(labels(result.state.samples), labels(full.samples));
    assert.deepEqual(current, before, "the merge cannot mutate the live state document");
    if (!missingFirstPanel) assert.deepEqual(result.state, before);
    const repeat = mergeDistributionTraining(result.state, artifact, costs, assets, now, profile());
    assert.equal(repeat.report.addedSamples, 0); assert.deepEqual(repeat.state, result.state);
    const restored = candidate(); assert.equal(restored.restoreState(result.state, now), full.samples.length);
    assert.equal(restored.stats(now).predictionModelVersion, REGIME_DISTRIBUTION_SPEC.version);
  }
});
