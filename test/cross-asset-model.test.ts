import assert from "node:assert/strict";
import test from "node:test";
import { DynamicBayes, studentLogDensity } from "../src/research/dynamic-bayes.js";
import { CrossAssetModel, CROSS_ASSET_SPEC, usableCrossAssetForecast,
  type CrossAssetForecast, type CrossAssetQuote } from "../src/research/cross-asset-model.js";
import { SignalEpisodeCollector } from "../src/research/signal-episodes.js";
import { policyCandidates } from "../src/research/trading-policy.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { BookState } from "../src/core/market.js";
import { replayCrossAsset } from "../src/research/cross-asset-replay.js";
import { warmCrossAssetHistory } from "../src/research/cross-asset-warmup.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { loadConfig } from "../src/config.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
test("Bayesian posterior matches an analytical update and the Student-t prior density", () => {
  const model = new DynamicBayes(1, 64);
  model.update([1], 2);
  const p = model.predict([1]);
  close(p.mean, 1); close(p.meanVariance, .6); close(p.predictiveVariance, 1.8);
  close(p.scaleSquared, 9 / 7); assert.equal(p.degreesOfFreedom, 7);
  const zero = new DynamicBayes(0, 32).predict([]);
  close(Math.exp(studentLogDensity(0, zero)), .46875);
  assert.throws(() => model.update([NaN], 2)); assert.throws(() => model.predict([]));
});

test("discounted learning adapts to changing drift while collinear features remain finite", () => {
  const fast = new DynamicBayes(3, 8), slow = new DynamicBayes(3, 128);
  for (const m of [fast, slow]) {
    for (let i = 0; i < 100; i++) m.update([1, 1, 1], 2);
    for (let i = 0; i < 20; i++) m.update([1, 1, 1], -2);
    const p = m.predict([1, 2, 2]);
    assert.ok(Number.isFinite(p.mean) && p.meanVariance >= 0 && p.predictiveVariance > p.meanVariance);
  }
  assert.ok(fast.predict([1, 1, 1]).mean < slow.predict([1, 1, 1]).mean);
});

function* quotes(hours: number, drift = 1.3): Generator<CrossAssetQuote> {
  for (let atMs = 0; atMs <= hours * 3_600_000; atMs += 4_000) {
    for (const symbol of ["BTC/USD", "ETH/USD"]) {
      const mid = (symbol === "BTC/USD" ? 100 : 50) * Math.exp(atMs / 60_000 * drift / 10_000);
      yield { symbol, atMs, bid: mid * .99995, ask: mid * 1.00005, valid: true };
    }
  }
}

test("joint forecasts are causal and training uses completed non-overlapping intervals", () => {
  const short = new CrossAssetModel(costs), long = new CrossAssetModel(costs);
  let prefix: CrossAssetForecast[] = [], latest: CrossAssetForecast[] = [];
  for (const q of quotes(8)) { const result = short.observe(q); if (result.length) latest = result; }
  for (const q of quotes(9)) {
    const result = long.observe(q);
    if (result.length && q.atMs <= 8 * 3_600_000) prefix = result;
    for (const f of result) assert.ok(f.trainedThroughMs === null || f.trainedThroughMs <= f.atMs);
  }
  assert.deepEqual(prefix, latest, "future quotes cannot rewrite past forecasts");
  assert.equal(short.stats().labelsPerSymbol, 28, "one-hour warmup then one label per 15 minutes");
  assert.equal(long.stats().labelsPerSymbol, 32);
  assert.ok(latest.every((f) => f.predictedGrossBps > 0 && Number.isFinite(f.parameterUncertaintyBps)));
  for (const f of latest) close(Object.values(f.expertWeights).reduce((a, b) => a + b, 0), 1);
});

test("flat markets never manufacture fee-covering alpha", () => {
  const model = new CrossAssetModel(costs);
  let count = 0;
  for (const q of quotes(8, 0)) for (const f of model.observe(q)) {
    count++; assert.equal(f.eligible, false); assert.ok(f.conservativeNetBps < 0);
    close(f.predictedGrossBps, 0);
  }
  assert.ok(count > 0);
});

test("historical warmup trains completed labels and requires new quotes after an incomplete-interval handoff", async () => {
  const cutoff = 8 * 3_600_000 + 1;
  const { model, bootstrap } = await warmCrossAssetHistory(quotes(8), costs, cutoff, () => cutoff + 1_000);
  assert.equal(bootstrap.labelsPerSymbol, 28); assert.equal(bootstrap.trainingReady, true);
  assert.equal(bootstrap.historyRetained, true); assert.equal(bootstrap.discardedIncompleteInterval, true);
  assert.equal(bootstrap.trainedThroughMs, cutoff - 1); assert.equal(bootstrap.invalidQuotes, 0);
  let firstLiveForecast: CrossAssetForecast | undefined;
  for (const q of quotes(9)) {
    if (q.atMs < cutoff) continue;
    const forecasts = model.observe(q); firstLiveForecast ??= forecasts[0];
    if (q.atMs <= cutoff - 1 + 900_000) assert.equal(model.stats().labelsPerSymbol, 28,
      "an unfinished historical interval must not mature using a live closing quote");
    if (q.atMs > cutoff - 1 + 960_000) break;
  }
  assert.ok(firstLiveForecast); assert.ok(firstLiveForecast.atMs > cutoff);
  assert.equal(firstLiveForecast.trainingLabels, 28); assert.equal(model.stats().labelsPerSymbol, 29);
});

test("historical warmup preserves invalid quotes and refuses future data, reversed time or stale training", async () => {
  const cutoff = 8 * 3_600_000 + 2;
  const { bootstrap, model } = await warmCrossAssetHistory([...quotes(8),
    { symbol: "BTC/USD", atMs: cutoff - 1, bid: 100, ask: 101, valid: false }], costs, cutoff, () => cutoff);
  assert.equal(bootstrap.invalidQuotes, 1); assert.equal(bootstrap.labelsPerSymbol, 28);
  assert.equal(bootstrap.historyRetained, true, "recent price features can survive a terminal shutdown marker");
  assert.equal(model.stats().invalidLabelPairs, 1, "the shutdown marker still invalidates the pending training label");
  const tooOld = await warmCrossAssetHistory([...quotes(8),
    { symbol: "BTC/USD", atMs: cutoff - 1, bid: 100, ask: 101, valid: false }], costs, cutoff, () => cutoff + 90_001);
  assert.equal(tooOld.bootstrap.historyRetained, false, "old price context cannot bypass the sampling-gap limit");
  assert.equal(tooOld.bootstrap.labelsPerSymbol, 28);
  const liveAtMs = cutoff - 2 + 60_000;
  model.observe({ symbol: "BTC/USD", atMs: cutoff + 1, bid: 0, ask: 0, valid: false });
  assert.deepEqual(model.observe({ symbol: "BTC/USD", atMs: liveAtMs, bid: 100, ask: 100.01, valid: true }), [],
    "a historical peer quote must never stand in for a fresh peer quote");
  const liveForecasts = model.observe({ symbol: "ETH/USD", atMs: liveAtMs, bid: 50, ask: 50.01, valid: true });
  assert.equal(liveForecasts.length, 2); assert.ok(liveForecasts.every(f => f.atMs === liveAtMs && f.trainingLabels === 28));
  const stale = await warmCrossAssetHistory(quotes(8), costs, cutoff, () => cutoff + 86_400_001);
  assert.equal(stale.bootstrap.trainingReady, false); assert.equal(stale.bootstrap.labelsPerSymbol, 0);
  assert.equal(stale.bootstrap.historyRetained, false);
  const q = { symbol: "BTC/USD", atMs: 1, bid: 100, ask: 101, valid: true };
  await assert.rejects(warmCrossAssetHistory([{ ...q, atMs: cutoff }], costs, cutoff, () => cutoff), /BEFORE_CUTOFF/);
  await assert.rejects(warmCrossAssetHistory([q, { ...q, atMs: 0 }], costs, cutoff, () => cutoff), /CHRONOLOGICAL/);
  await assert.rejects(warmCrossAssetHistory([{ ...q, symbol: "SOL/USD" }], costs, cutoff, () => cutoff), /SYMBOL_OUT_OF_SCOPE/);
  await assert.rejects(warmCrossAssetHistory([], costs, cutoff, () => cutoff - 1), /INVALID_HISTORY_CUTOFF/);
  const empty = await warmCrossAssetHistory([], costs, cutoff, () => cutoff);
  assert.equal(empty.bootstrap.trainingReady, false); assert.equal(empty.bootstrap.historyRetained, false);
});

test("engine installs historical learning atomically before startup without decisions or orders", async () => {
  const atMs = 8 * 3_600_000 + 1;
  const cfg = loadConfig({ TRADING_MODE: "paper", CROSS_ASSET_PAPER_ENTRIES_ENABLED: "true" });
  const engine = new TradingEngine({ ...cfg, continuousRecordingEnabled: false }, { now: () => atMs });
  const emitted: string[] = [];
  for (const type of ["decision", "orderReserved", "orderSending", "crossAssetForecast", "policyObservation"]) {
    engine.on(type, () => emitted.push(type));
  }
  const bootstrap = await engine.restoreCrossAssetHistory(quotes(8), atMs);
  assert.equal(bootstrap!.labelsPerSymbol, 28);
  for (const market of engine.state().markets) {
    assert.equal(market.policyPulse!.research!.crossAsset!.learning.labelsPerSymbol, 28);
    assert.equal(market.policyPulse!.research!.crossAsset!.forecast, null);
    assert.equal(market.policyPulse!.research!.crossAsset!.historyBootstrap!.trainingReady, true);
  }
  assert.deepEqual(emitted, []); assert.equal(engine.state().orders.length, 0);
  async function* brokenHistory() { yield { symbol: "BTC/USD", atMs: 0, bid: 100, ask: 101, valid: true }; throw new Error("HISTORY_READ_FAILED"); }
  await assert.rejects(engine.restoreCrossAssetHistory(brokenHistory(), atMs), /HISTORY_READ_FAILED/);
  assert.equal(engine.state().markets[0]!.policyPulse!.research!.crossAsset!.learning.labelsPerSymbol, 28,
    "a failed read must leave the installed model untouched");
  (engine as unknown as { started: boolean }).started = true;
  await assert.rejects(engine.restoreCrossAssetHistory([], atMs), /before the engine starts/);
  (engine as unknown as { started: boolean }).started = false;
  await engine.stop();
});

test("startup minute context spans only bounded sample gaps while training labels still reject quote outages", async () => {
  const cutoff = 8 * 3_600_000 + 1, outageMs = 7 * 3_600_000 + 20 * 60_000;
  const brief = [...quotes(8)].map(q => q.atMs === outageMs ? { ...q, valid: false } : q);
  const warmed = await warmCrossAssetHistory(brief, costs, cutoff, () => cutoff);
  assert.equal(warmed.bootstrap.labelsPerSymbol, 27, "only the interrupted label is lost; clean intervals resume after recovery");
  assert.equal(warmed.model.stats().invalidLabelPairs, 1);
  assert.equal(warmed.bootstrap.historyRetained, true, "minute price context remains available through a short outage");
  assert.equal(warmed.bootstrap.priceHistoryReady, true);
  const long = brief.filter(q => q.atMs < outageMs || q.atMs > outageMs + 120_000);
  const incomplete = await warmCrossAssetHistory(long, costs, cutoff, () => cutoff);
  assert.equal(incomplete.bootstrap.priceHistoryReady, false, "a gap over 90 seconds requires a new complete minute window");
  assert.ok(incomplete.model.stats().historySamples < 55);
  assert.equal(incomplete.bootstrap.trainingReady, true, "completed earlier learning survives a recent price-history gap");
});

test("gaps invalidate pending labels and a long outage discards stale training", () => {
  const model = new CrossAssetModel(costs);
  for (const q of quotes(8)) model.observe(q);
  const trained = model.stats().labelsPerSymbol;
  model.observe({ symbol: "BTC/USD", atMs: 8 * 3_600_000 + 1, bid: 1, ask: 2, valid: false });
  assert.equal(model.stats().invalidLabelPairs, 1); assert.ok(model.stats().historySamples >= 55);
  assert.equal(model.stats().labelsPerSymbol, trained);
  model.observe({ symbol: "BTC/USD", atMs: 40 * 3_600_000, bid: 100, ask: 101, valid: true });
  assert.equal(model.stats().labelsPerSymbol, 0); assert.equal(model.stats().trainingResets, 1);
  const unsynchronized = new CrossAssetModel(costs);
  unsynchronized.observe({ symbol: "BTC/USD", atMs: 0, bid: 100, ask: 101, valid: true });
  assert.deepEqual(unsynchronized.observe({ symbol: "ETH/USD", atMs: 3_000, bid: 50, ask: 51, valid: true }), []);
  assert.equal(unsynchronized.stats().historySamples, 0);
});

for (const interruption of ["invalid quote", "silent quote gap", "stream disconnect"] as const) {
  test(`${interruption} retains minute context but cannot bridge a training label or reuse a peer quote`, () => {
    const model = new CrossAssetModel(costs), endMs = 8 * 3_600_000;
    for (const q of quotes(8)) model.observe(q);
    if (interruption === "invalid quote") {
      assert.deepEqual(model.observe({ symbol: "ETH/USD", atMs: endMs + 2_000, bid: 0, ask: 0, valid: false }), []);
    } else if (interruption === "stream disconnect") model.invalidate(endMs + 2_000);
    let firstForecast: CrossAssetForecast | undefined;
    for (const q of quotes(9)) {
      if (q.atMs < endMs + 8_000) continue;
      const result = model.observe(q);
      if (q.atMs === endMs + 8_000 && q.symbol === "BTC/USD") assert.deepEqual(result, [],
        "recovery needs a new peer quote even though the old price context is retained");
      firstForecast ??= result[0];
      if (q.atMs <= endMs + 900_000) assert.equal(model.stats().labelsPerSymbol, 28,
        "the label opened before the interruption must never mature");
      if (q.atMs >= endMs + 960_000 && q.symbol === "ETH/USD") break;
    }
    assert.equal(firstForecast?.atMs, endMs + 60_000, "forecasts resume at the next minute sample");
    assert.equal(model.stats().invalidLabelPairs, 1);
    assert.equal(model.stats().labelsPerSymbol, 29, "a new full clean interval can train after recovery");
    assert.equal(model.stats().priceHistoryReady, true);
  });
}

test("a live price gap over 90 seconds requires new history while retaining completed learning", () => {
  const model = new CrossAssetModel(costs), endMs = 8 * 3_600_000;
  for (const q of quotes(8)) model.observe(q);
  assert.equal(model.stats(endMs + 90_001).priceHistoryReady, false, "dashboard coverage expires even before a new quote arrives");
  model.invalidate(endMs + 1_000);
  for (const symbol of ["BTC/USD", "ETH/USD"]) {
    assert.deepEqual(model.observe({ symbol, atMs: endMs + 90_001, bid: 100, ask: 101, valid: true }), []);
  }
  assert.equal(model.stats().priceHistoryReady, false);
  assert.equal(model.stats().historySamples, 0);
  assert.equal(model.stats().labelsPerSymbol, 28);
});

test("historical and live recovery produce identical learning after a brief stale quote", async () => {
  const path = [...quotes(8)].map(q => q.atMs === 7 * 3_600_000 + 20 * 60_000 ? { ...q, valid: false } : q);
  const live = new CrossAssetModel(costs);
  for (const q of path) live.observe(q);
  const { model } = await warmCrossAssetHistory(path, costs, 8 * 3_600_000 + 1, () => 8 * 3_600_000 + 1);
  assert.deepEqual(model.stats(), live.stats());
});

function forecast(side: 1 | -1, atMs: number): CrossAssetForecast {
  return { version: CROSS_ASSET_SPEC.version, symbol: "BTC/USD", atMs, side, horizonMs: 900_000,
    trainingLabels: 50, trainedThroughMs: atMs - 1000, referenceMid: 100, predictedGrossBps: side * 40,
    parameterUncertaintyBps: 2, predictiveStdBps: 20, costHurdleBps: 14, conservativeNetBps: 20,
    eligible: true, reason: "POSITIVE_RESEARCH_FORECAST", factorBeta: 1, expertWeights: { trend: 1 } };
}
for (const side of [1, -1] as const) test(`eligible joint ${side} forecast creates isolated shadow execution cases`, () => {
  const c = new SignalEpisodeCollector("test", "BTC/USD", 5, 3), atMs = 100_000;
  const b: BookState = { symbol: "BTC/USD", receiveTsMs: atMs, exchangeTsMs: atMs, sequence: 1n,
    valid: true, sourceReset: false, bids: [{ px: 99.995, qty: 1 }], asks: [{ px: 100.005, qty: 1 }] };
  const f = { symbol: "BTC/USD", receiveTsMs: atMs, stale: false, warmedUp: true, mid: 100, spreadBps: 1,
    trendFastBps: 0, trendMediumBps: 0, trendSlowBps: 0, slowTrendEfficiency: 0, ofi: 0, tfi: 0,
    velocityZ: 0, impulseBps: 0, breakoutUpBps: 0, breakoutDownBps: 0, retestCandidate: null } as DeterministicFeatures;
  const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001, maximumOrderQty: 1, shortable: true };
  const context = { healthAllowed: true, healthReasons: [], liquidityPass: true, liquidityReasons: [],
    positionOpen: true, pendingOrder: true, cooldownRemainingMs: 10000, sizing: "VENUE_NOTIONAL_ONLY" as const };
  const p = forecast(side, atMs);
  assert.equal(usableCrossAssetForecast(p, b.symbol, atMs), true);
  assert.equal(usableCrossAssetForecast({ ...p, trainedThroughMs: atMs + 1 }, b.symbol, atMs), false);
  assert.equal(usableCrossAssetForecast(p, b.symbol, atMs + 1_001), false);
  const starts = c.observe(b, f, asset, { long: context, short: context }, p);
  assert.equal(starts.length, 10, "two holding policies times five execution stresses");
  assert.ok(starts.every((o) => o.hypothesisId === CROSS_ASSET_SPEC.version && o.side === side && o.family === "CONTINUATION"));
  assert.deepEqual(policyCandidates(f), [], "the submitting breakout path receives no joint candidate");
  assert.ok(c.invalidate(atMs + 1000, "GAP").every((o) => o.status === "INVALID"));
});

test("quote replay rejects reverse time and labels results as screening only", async () => {
  const first = [...quotes(0)];
  await assert.rejects(replayCrossAsset([...first, { ...first[0]!, atMs: -1 }], costs), /CHRONOLOGICAL/);
  const r = await replayCrossAsset(first, costs);
  assert.equal(r.deploymentReady, false); assert.deepEqual(r.groups, []);
});

test("quote replay pairs stress attempts, charges both fees and preserves misses and gaps", async (t) => {
  t.mock.method(CrossAssetModel.prototype, "observe", (q: CrossAssetQuote) => [forecast(1, q.atMs)]);
  function* path(miss = false, gap = false): Generator<CrossAssetQuote> {
    for (let atMs = 0; atMs <= 907_000; atMs += 1_000) {
      const mid = atMs >= 900_000 ? 100.5 : miss && atMs >= 1000 ? 100.02 : 100;
      yield { symbol: "BTC/USD", atMs, bid: mid - .005, ask: mid + .005, valid: !gap || atMs !== 500_000 };
    }
  }
  const r = await replayCrossAsset(path(), costs);
  assert.equal(r.outcomes.length, 3); assert.ok(r.outcomes.every((o) => o.signalAtMs === 0 && o.status === "FILLED"));
  const base = r.outcomes.find((o) => o.scenario === "quotes-1s")!;
  const gross = (100.495 / 100.005 - 1) * 10_000;
  close(base.grossBps!, gross); close(base.netBps!, gross - 5 * (1 + 100.495 / 100.005) - 3);
  assert.ok(r.outcomes.find((o) => o.scenario === "fees-1.5x")!.netBps! < base.netBps!);
  const misses = await replayCrossAsset(path(true), costs);
  assert.equal(misses.outcomes.length, 3, "nonfills cannot create extra stress opportunities");
  assert.ok(misses.outcomes.every((o) => o.status === "UNFILLED" && o.netBps === 0));
  const gaps = await replayCrossAsset(path(false, true), costs);
  assert.ok(gaps.outcomes.every((o) => o.status === "INVALID" && o.netBps === null));
});

test("evaluation replay includes failing forecasts, applies the 30m cooldown and compares cost screens on shared attempts", async (t) => {
  t.mock.method(CrossAssetModel.prototype, "observe", (q: CrossAssetQuote) => [{ ...forecast(1, q.atMs),
    predictedGrossBps: 1, conservativeNetBps: -19, eligible: false, reason: "COST_OR_UNCERTAINTY" }]);
  function* path(): Generator<CrossAssetQuote> {
    for (let atMs = 0; atMs <= 2_710_000; atMs += 1000) {
      yield { symbol: "BTC/USD", atMs, bid: 99.995, ask: 100.005, valid: true };
    }
  }
  const qualified = await replayCrossAsset(path(), costs);
  assert.equal(qualified.outcomes.length, 0);
  const r = await replayCrossAsset(path(), costs, { paperEvaluation: true });
  assert.equal(r.outcomes.length, 6);
  assert.deepEqual([...new Set(r.outcomes.map(o => o.signalAtMs))], [0, 1_800_000]);
  assert.ok(r.outcomes.every(o => o.status === "FILLED" && o.reason === "POLICY_DEADLINE" && o.netBps! < 0));
  assert.equal(r.entryScreenComparison.completeAcrossStresses, 2);
  assert.ok(r.entryScreenComparison.groups.filter(g => g.screen !== "EVALUATION")
    .every(g => g.panelAttempts === 2 && g.acceptedAttempts === 0 && g.meanNetBpsPerOriginalAttempt === 0));
  const later = await replayCrossAsset(path(), costs, { paperEvaluation: true, entryStartMs: 1_800_000 });
  assert.equal(later.outcomes.length, 3); assert.ok(later.outcomes.every(o => o.signalAtMs === 1_800_000));
  await assert.rejects(replayCrossAsset([], costs, { entryStartMs: NaN }), /INVALID_ENTRY_START/);
});

for (const side of [1, -1] as const) test(`evaluation replay uses causal stop prices and excludes missing stress paths for side ${side}`, async (t) => {
  t.mock.method(CrossAssetModel.prototype, "observe", (q: CrossAssetQuote) => [forecast(side, q.atMs)]);
  function* path(gap = false): Generator<CrossAssetQuote> {
    for (let atMs = 0; atMs <= 12_000; atMs += 1000) {
      const mid = atMs < 5_000 ? 100 : atMs < 7_000 ? 100 - side * .4 : 100 - side * .6;
      yield { symbol: "BTC/USD", atMs, bid: mid - .005, ask: mid + .005, valid: !gap || atMs !== 7_000 };
    }
  }
  const r = await replayCrossAsset(path(), costs, { paperEvaluation: true });
  assert.ok(r.outcomes.every(o => o.reason === "POLICY_STOP" && o.netBps! < 0));
  const fast = r.outcomes.find(o => o.scenario === "quotes-1s")!, slow = r.outcomes.find(o => o.scenario === "latency-3s")!;
  assert.equal(fast.exitAtMs, 6_000); assert.equal(slow.exitAtMs, 8_000);
  assert.ok(slow.netBps! < fast.netBps!, "stop fills use the later execution quote, not the earlier trigger price");
  const missing = await replayCrossAsset(path(true), costs, { paperEvaluation: true });
  assert.equal(missing.entryScreenComparison.completeAcrossStresses, 0);
  assert.equal(missing.entryScreenComparison.excludedOpportunities, 1);
  assert.ok(missing.entryScreenComparison.groups.every(g => g.meanNetBpsPerOriginalAttempt === null));
});

test("evaluation replay cannot trade a midpoint forecast already consumed by the entry spread", async (t) => {
  t.mock.method(CrossAssetModel.prototype, "observe", (q: CrossAssetQuote) => [{ ...forecast(1, q.atMs),
    predictedGrossBps: .1, conservativeNetBps: -19.9, eligible: false, reason: "COST_OR_UNCERTAINTY" }]);
  const r = await replayCrossAsset([{ symbol: "BTC/USD", atMs: 0, bid: 99.995, ask: 100.005, valid: true }],
    costs, { paperEvaluation: true });
  assert.equal(r.priceRebaseRejections, 1); assert.equal(r.outcomes.length, 0);
});
