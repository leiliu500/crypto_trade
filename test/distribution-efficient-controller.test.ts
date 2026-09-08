import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionMarket, DISTRIBUTION_LOOKBACK_MS, DISTRIBUTION_FLOW_WARM_MS } from "../src/distribution/market.js";
import { executableDistributionDecision } from "../src/distribution/planner.js";
import { EFFICIENT_TRAINING_SPEC } from "../src/distribution/efficient-trainer.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS, DISTRIBUTION_SPEC as S,
  distributionEntryProfile, type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, START = Date.UTC(2026, 8, 1);
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true,
}]));
const candidate = () => new DistributionController(costs, { ...assets }, distributionEntryProfile(true), { efficientTraining: true });
function book(atMs: number, symbol = "BTC/USD", bid = 100, ask = 100.01): BookState {
  return { symbol, bids: [{ px: bid, qty: 1 }], asks: [{ px: ask, qty: 1 }],
    receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: true };
}
function ready(t: TestContext): void {
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => ({ symbol: b.symbol, atMs: b.receiveTsMs,
    ready: true, reason: "READY", features: Array<number>(12).fill(0) }));
}
function advance(controller: DistributionController, first: number, last: number): DistributionSample[] {
  const rows: DistributionSample[] = [];
  for (let at = first; at <= last; at += 1000) rows.push(...controller.onBook(book(at)).samples);
  return rows;
}
function labels(rows: DistributionSample[]) { return [...rows].sort((a, b) => a.id.localeCompare(b.id)); }
function legacyState(days = 3, perDay = 16, profitable = false) {
  const state = new DistributionController(costs, { ...assets }, distributionEntryProfile(true)).exportState();
  for (let day = 0; day < days; day++) for (let index = 0; index < perDay; index++) for (const action of ACTIONS) {
    const atMs = START + day * DAY + index * S.proposalIntervalMs;
    const netBps = profitable && action.id === "long-5m" ? 60 : -30;
    state.samples.push({ id: `BTC/USD:${action.id}:${atMs}`, symbol: "BTC/USD", actionId: action.id,
      signalAtMs: atMs, completedAtMs: atMs + 2000, features: Array<number>(12).fill(0),
      outcomes: SCENARIOS.map(s => ({ scenario: s.id, status: "FILLED", netBps, grossBps: netBps + 20,
        filledFraction: 1, entryAtMs: atMs + s.latencyMs, exitAtMs: atMs + 2000, reason: "FIXTURE_OBSERVED_OUTCOME" })) });
  }
  return state;
}
const cutoff = (state: ReturnType<typeof legacyState>) => Math.max(...state.samples.map(row => row.completedAtMs));

test("efficient training is explicitly paper-trial-only and the default controller retains legacy behavior", t => {
  ready(t);
  assert.throws(() => new DistributionController(costs, assets, distributionEntryProfile(), { efficientTraining: true }), /EFFICIENT|PROFILE|PAPER/i);
  assert.throws(() => new DistributionController(costs, assets, distributionEntryProfile(true, true)), /EFFICIENT|PROFILE|TRAINING/i);
  const legacy = new DistributionController(costs, assets, distributionEntryProfile(true));
  const explicit = new DistributionController(costs, assets, distributionEntryProfile(true), { efficientTraining: false });
  for (const at of [0, 250, 1000, 2000]) assert.deepEqual(legacy.onBook(book(at)), explicit.onBook(book(at)));
  assert.deepEqual(legacy.exportState(), explicit.exportState());
  assert.equal(legacy.stats(2000).trainingMode, "LEGACY_PANEL");
  assert.equal(legacy.stats(2000).trainingIntervalMs, S.proposalIntervalMs);
  const enabled = candidate(), stats = enabled.stats(2000);
  assert.equal(stats.trainingMode, "INDEPENDENT_HORIZONS");
  assert.equal(stats.trainingPolicyVersion, EFFICIENT_TRAINING_SPEC.version);
  assert.equal(stats.trainingIntervalMs, null);
  assert.equal(stats.minimumSamples, 48); assert.equal(stats.minimumEffectiveSamples, 32);
  assert.equal(stats.minimumTrainingDays, 3); assert.equal(stats.evaluationIntervalMs, 1000);
});

test("completed five-minute outcomes affect the same fresh entry evaluation before longer horizons finish", t => {
  ready(t);
  const controller = candidate();
  advance(controller, 0, 301_000);
  assert.equal(controller.stats(301_000).learning.acceptedSamples, 0);
  const result = controller.onBook(book(302_000));
  assert.deepEqual(result.samples.map(row => row.actionId), ["long-5m", "short-5m"]);
  assert.ok(result.samples.every(row => row.outcomes.every(outcome => outcome.status === "FILLED")));
  assert.ok(result.decision);
  assert.equal(result.decision.estimates.find(row => row.actionId === "long-5m")!.samples, 1);
  assert.equal(result.decision.estimates.find(row => row.actionId === "long-15m")!.samples, 0);
  assert.equal(result.decision.actionId, null); assert.equal(result.decision.paperReady, false);
  assert.equal(controller.stats(302_000).learning.acceptedSamples, 2);
  assert.equal(controller.stats(302_000).pendingTrainingActions, 4);
  controller.invalidate(308_000, "DISCONNECT");
  assert.equal(controller.exportState().samples.length, 2, "later invalid paths cannot discard already completed short labels");
});

test("training completion is observed between evaluation quotes without waiting for another entry decision", t => {
  ready(t);
  const controller = candidate(); advance(controller, 0, 301_000);
  assert.equal(controller.onBook(book(301_250)).decision, null);
  const done = controller.onBook(book(301_750));
  assert.equal(done.decision, null); assert.equal(done.samples.length, 2);
  assert.equal(controller.stats(301_750).learning.acceptedSamples, 2);
  assert.equal(controller.onBook(book(302_000)).decision!.estimates[0]!.samples, 1);
});

test("live controller uses six/sixteen/thirty-one-minute clocks without overlapping action training", t => {
  ready(t);
  const controller = candidate(), rows = advance(controller, 0, 1_862_000);
  const stats = controller.stats(1_862_000).efficientTraining!;
  assert.deepEqual(stats.byAction.filter(row => row.symbol === "BTC/USD").map(row => [row.actionId, row.started]), [
    ["long-5m", 6], ["short-5m", 6], ["long-15m", 2], ["short-15m", 2], ["long-30m", 2], ["short-30m", 2],
  ]);
  for (const action of ACTIONS) {
    const own = rows.filter(row => row.actionId === action.id);
    for (let i = 1; i < own.length; i++) {
      assert.equal(own[i]!.signalAtMs - own[i - 1]!.signalAtMs, action.horizonMs + 60_000);
      assert.ok(own[i]!.signalAtMs >= own[i - 1]!.completedAtMs);
    }
  }
  assert.equal(stats.learning.rejectedSamples, 0);
});

test("legacy full panels migrate without changing any labels or entry thresholds", t => {
  ready(t);
  for (const state of [legacyState(), legacyState(3, 16, true), legacyState(2, 24, true)]) {
    const now = cutoff(state), legacy = new DistributionController(costs, assets, distributionEntryProfile(true));
    const enabled = candidate();
    legacy.restoreState(state, now); assert.equal(enabled.restoreState(state, now), state.samples.length);
    assert.deepEqual(labels(enabled.exportState().samples), labels(state.samples));
    const a = legacy.onBook(book(now + 1000)).decision!, b = enabled.onBook(book(now + 1000)).decision!;
    assert.deepEqual(b.estimates, a.estimates, "training collection changes must preserve eligibility on identical historical evidence");
    assert.equal(b.actionId, a.actionId); assert.equal(b.paperReady, a.paperReady);
  }
  const sparse = legacyState(3, 16, true); sparse.samples.splice(-6);
  const controller = candidate(); controller.restoreState(sparse, cutoff(sparse));
  const decision = controller.onBook(book(cutoff(sparse) + 1000)).decision!;
  assert.equal(decision.reason, "INSUFFICIENT_SAMPLES"); assert.equal(decision.actionId, null);
});

test("a genuinely eligible efficient paper decision requires its matching canonical execution profile", t => {
  ready(t);
  const state = legacyState(3, 16, true), controller = candidate(), now = cutoff(state) + 1000;
  controller.restoreState(state, now - 1000);
  const quote = book(now), decision = controller.onBook(quote).decision!;
  assert.equal(decision.actionId, "long-5m"); assert.equal(decision.paperReady, true);
  assert.equal(decision.selectionPolicyVersion, distributionEntryProfile(true, true).selectionPolicyVersion);
  assert.ok(executableDistributionDecision(decision, quote, now, distributionEntryProfile(true, true)));
  assert.equal(executableDistributionDecision(decision, quote, now, distributionEntryProfile(true)), null);
  assert.equal(executableDistributionDecision(decision, quote, now + 1001, distributionEntryProfile(true, true)), null);
});

test("uneven action checkpoints round-trip and preserve horizon clocks after pending work is discarded", t => {
  ready(t);
  const source = candidate(); advance(source, 0, 302_000);
  const saved = source.exportState();
  assert.deepEqual(saved.samples.map(row => row.actionId).sort(), ["long-5m", "short-5m"]);
  assert.ok(saved.efficientTraining); assert.ok(saved.efficientTraining.pendingOrigins.length > 0);
  const restored = candidate(); assert.equal(restored.restoreState(saved, 302_000), 2);
  assert.deepEqual(labels(restored.exportState().samples), labels(saved.samples));
  assert.deepEqual(restored.exportState().efficientTraining!.nextOrigins, saved.efficientTraining.nextOrigins);
  assert.equal(restored.stats(302_000).pendingTrainingActions, 0);
  restored.onBook(book(359_999)); assert.equal(restored.stats(359_999).pendingTrainingActions, 0);
  restored.onBook(book(360_000)); assert.equal(restored.stats(360_000).pendingTrainingActions, 2);
  const started = restored.stats(360_000).efficientTraining!.byAction.filter(row => row.symbol === "BTC/USD");
  assert.ok(started.filter(row => row.actionId.endsWith("-5m")).every(row => row.pendingSignalAtMs === 360_000));
  assert.ok(started.filter(row => !row.actionId.endsWith("-5m")).every(row => row.pendingSignalAtMs === null));
  assert.throws(() => new DistributionController(costs, assets, distributionEntryProfile(true)).restoreState(saved, 302_000), /EFFICIENT|TRAINING|CHECKPOINT/i);
});

test("malformed future or overlapping efficient checkpoints are rejected atomically", t => {
  ready(t);
  const controller = candidate(); advance(controller, 0, 302_000);
  const original = controller.exportState();
  const mutations: Array<(state: typeof original) => void> = [
    state => { state.samples[0]!.completedAtMs = 400_001; },
    state => {
      const overlap = structuredClone(state.samples[0]!);
      overlap.signalAtMs++; overlap.completedAtMs++;
      overlap.id = `${overlap.symbol}:${overlap.actionId}:${overlap.signalAtMs}`;
      for (const outcome of overlap.outcomes) { if (outcome.entryAtMs !== null) outcome.entryAtMs++; outcome.exitAtMs++; }
      state.samples.push(overlap);
    },
    state => { state.samples[0]!.outcomes[0]!.status = "INVALID"; },
    state => { const clocks = state.efficientTraining!.nextOrigins; clocks[Object.keys(clocks)[0]!] = -1; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(original); mutate(bad);
    assert.throws(() => controller.restoreState(bad, 400_000), /EFFICIENT|CHECKPOINT|TRAINING|SCHEDUL/i);
    assert.deepEqual(controller.exportState(), original, "failed restore cannot alter labels, scheduler or pending selections");
  }
});

test("switching legacy paper training to efficient training clears old selected-policy validation", t => {
  ready(t);
  const state = legacyState(3, 16, true), legacy = new DistributionController(costs, assets, distributionEntryProfile(true));
  const at = cutoff(state) + 1000; legacy.restoreState(state, at - 1000);
  assert.equal(legacy.onBook(book(at)).decision!.actionId, "long-5m");
  legacy.onBook(book(at + 250)); legacy.onBook(book(at + 750));
  for (const delta of [1000, 1250, 1750]) legacy.onBook(book(at + delta, "BTC/USD", 101, 101.01));
  const saved = legacy.exportState(); assert.equal(saved.validationSelections.length, 1);
  const enabled = candidate(); enabled.restoreState(saved, at + 2000);
  assert.deepEqual(labels(enabled.exportState().samples), labels(saved.samples));
  assert.equal(enabled.stats(at + 2000).validation.selections, 0);
  assert.equal(enabled.exportState().selectionPolicyVersion, distributionEntryProfile(true, true).selectionPolicyVersion);
});

test("efficient collection preserves the established short-disconnect price-history recovery", () => {
  const market = new DistributionMarket(), end = START + DISTRIBUTION_LOOKBACK_MS;
  for (let at = START; at <= end; at += 1000) for (const symbol of S.symbols) market.onBook(book(at, symbol));
  const controller = candidate(); controller.restoreMarketHistory(market.exportHistory(), end);
  const warm = end + DISTRIBUTION_FLOW_WARM_MS;
  for (let at = end; at <= warm; at += 1000) for (const symbol of S.symbols) controller.onBook(book(at, symbol));
  assert.ok(controller.currentDecision("BTC/USD"));
  const before = controller.exportMarketHistory(); controller.invalidate(warm + 500, "PUBLIC_STREAM_DOWN");
  assert.deepEqual(controller.exportMarketHistory(), before);
  assert.equal(controller.stats(warm + 500).pendingTrainingActions, 0);
  const resumed = warm + 2000;
  for (let at = resumed; at < resumed + DISTRIBUTION_FLOW_WARM_MS; at += 1000)
    for (const symbol of S.symbols) assert.equal(controller.onBook(book(at, symbol)).decision, null);
  for (const symbol of S.symbols) assert.ok(controller.onBook(book(resumed + DISTRIBUTION_FLOW_WARM_MS, symbol)).decision);
  assert.ok(controller.stats(resumed + DISTRIBUTION_FLOW_WARM_MS).markets.every(row => row.remainingMs === 0));
});
