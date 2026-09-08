import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RecordedEvent } from "../src/backtest/replay.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { StreamingHorizonAssessment, type HorizonResearchPanel } from "../src/distribution/horizon-assessment.js";
import { horizonVolatility30mBps, HorizonResearchCollector, replayHorizonResearch } from "../src/distribution/horizon-replay.js";
import { HORIZON_RESEARCH_SPEC as H } from "../src/distribution/horizon-spec.js";

const ORIGIN = 2_000_000;
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, {
  symbol, minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: .001, maximumOrderQty: 100, shortable: true,
}]));
const book = (atMs: number, symbol = "BTC/USD", mid = 100): BookState => ({ symbol,
  bids: [{ px: mid - .005, qty: 100 }], asks: [{ px: mid + .005, qty: 100 }],
  receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs + 1), sourceReset: true, valid: true });
function quote(atMs: number, symbol = "BTC/USD", mid = 100): RecordedEvent {
  const b = book(atMs, symbol, mid);
  return { kind: "BOOK", delta: { symbol, bids: [...b.bids], asks: [...b.asks], reset: true,
    receiveTsMs: atMs, exchangeTsMs: atMs, sourceId: `${symbol}:${atMs}` } };
}
function trade(atMs: number, symbol = "BTC/USD"): RecordedEvent {
  return { kind: "TRADE", trade: { id: `${symbol}:${atMs}`, symbol, px: 100.005, qty: .1,
    aggressor: 1, receiveTsMs: atMs, exchangeTsMs: atMs } };
}
const options = { trainingStartMs: ORIGIN, laterStartMs: ORIGIN + 1_000_000,
  cutoffMs: ORIGIN + 4_000_000, includePanels: true };

/** Synthetic ready context isolates path handling; the real-market integration
 * below separately exercises price/flow history and peer synchronization. */
function readyMarket(t: TestContext, seen?: BookState[]): void {
  const last = new Map<string, BookState>();
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => {
    last.set(b.symbol, b); seen?.push(b);
    return { symbol: b.symbol, atMs: b.receiveTsMs, ready: true, reason: "READY", features: Array<number>(12).fill(0) };
  });
  t.mock.method(DistributionMarket.prototype, "exportHistory", () => ({ version: "btc-eth-market-history-v1",
    symbols: [...last.values()].map(b => ({ symbol: b.symbol, lastBookAtMs: b.receiveTsMs,
      samples: [{ atMs: b.receiveTsMs - H.volatilityLookbackMs, mid: 100 },
        { atMs: b.receiveTsMs, mid: (b.bids[0]!.px + b.asks[0]!.px) / 2 }] })) }));
}

test("horizon volatility uses observed elapsed intervals before clipping and admits zero volatility", () => {
  const now = H.volatilityLookbackMs;
  const path = [{ atMs: 0, mid: 100 }, { atMs: 600_000, mid: 101 }, { atMs: now, mid: 99 }];
  const expected = Math.sqrt((Math.log(101 / 100) ** 2 / 600_000 + Math.log(99 / 101) ** 2 / 1_200_000) / 2 * now) * 10_000;
  const original = structuredClone(path), actual = horizonVolatility30mBps(path, now, 99);
  assert.ok(Math.abs(actual - expected) < 1e-10); assert.ok(actual > 100, "raw volatility exceeds the clipped feature's 100bp scale");
  assert.deepEqual(path, original, "volatility calculation cannot modify observed history");
  assert.equal(horizonVolatility30mBps([{ atMs: 0, mid: 100 }, { atMs: now, mid: 100 }], now, 100), 0);
  const appended = horizonVolatility30mBps([{ atMs: 0, mid: 100 }, { atMs: 600_000, mid: 101 }], now, 99);
  assert.equal(appended, actual, "the current observed quote is appended exactly once");
});

test("horizon volatility rejects future, reversed, duplicate or incomplete history and mismatched current prices", () => {
  const now = H.volatilityLookbackMs, valid = [{ atMs: 0, mid: 100 }, { atMs: now, mid: 101 }];
  for (const bad of [[], [...valid, { atMs: now + 1, mid: 200 }], [...valid].reverse(),
    [valid[0]!, valid[0]!, valid[1]!], [{ atMs: 0, mid: 0 }, valid[1]!], [{ atMs: NaN, mid: 100 }, valid[1]!]]) {
    assert.throws(() => horizonVolatility30mBps(bad, now, 101), /INVALID_HORIZON_VOLATILITY_HISTORY/);
  }
  assert.throws(() => horizonVolatility30mBps([{ atMs: 1, mid: 100 }, valid[1]!], now, 101), /HORIZON_VOLATILITY_WARMUP/);
  assert.throws(() => horizonVolatility30mBps(valid, now, 102), /HORIZON_VOLATILITY_PRICE_MISMATCH/);
});

test("real book and trade warmup launches 26 frozen policies and completes 1m paths before longer deadlines", async () => {
  function* events(): Iterable<RecordedEvent> {
    for (let atMs = 0; atMs <= H.volatilityLookbackMs; atMs += 1000) {
      for (const symbol of Object.keys(costs)) yield quote(atMs, symbol);
      if (atMs % 5000 === 0) for (const symbol of Object.keys(costs)) yield trade(atMs, symbol);
    }
    for (let atMs = H.volatilityLookbackMs + 250; atMs <= H.volatilityLookbackMs + 65_000; atMs += 250) {
      for (const symbol of Object.keys(costs)) yield quote(atMs, symbol);
    }
  }
  const report = await replayHorizonResearch(events(), costs, assets, {
    trainingStartMs: 0, laterStartMs: 2_000_000, cutoffMs: 3_000_000, includePanels: true,
  });
  assert.equal(report.collection.origins, 2); assert.equal(report.panels!.length, 2);
  assert.ok(report.quality.trades > 0); assert.equal(report.collection.maximumPendingCases, 156);
  for (const panel of report.panels!) {
    assert.equal(panel.signalAtMs, H.volatilityLookbackMs); assert.equal(panel.volatility30mBps, 0);
    assert.equal(panel.paths.length, 26); assert.ok(panel.paths.every(p => p.outcomes.length === 3));
    const oneMinute = panel.paths.find(p => p.action.id === "horizon-fixed-control-long-1m")!;
    const base = oneMinute.outcomes.find(o => o.scenario === "base-250ms")!;
    const slow = oneMinute.outcomes.find(o => o.scenario === "latency-750ms-depth-half")!;
    assert.equal(base.status, "FILLED"); assert.equal(base.reason, "DEADLINE");
    assert.equal(base.entryAtMs, panel.signalAtMs + 250); assert.equal(base.exitAtMs, panel.signalAtMs + 60_500);
    assert.equal(slow.entryAtMs, panel.signalAtMs + 750); assert.equal(slow.exitAtMs, panel.signalAtMs + 61_500);
    assert.ok(base.netBps! < 0, "a real filled flat-price path still pays spread and fees");
    const thirty = panel.paths.find(p => p.action.id === "horizon-legacy-long-30m")!;
    assert.ok(thirty.outcomes.every(o => o.status === "INVALID" && o.reason === "REPLAY_END" && o.netBps === null));
  }
  assert.equal(report.brokerOrdersSubmitted, 0); assert.equal(report.deploymentReady, false);
  assert.equal(report.profitabilityEstablished, false);
  assert.equal(report.assessment.completeCommonTrainingPanels, 0,
    "completed short actions cannot bypass the common complete-panel comparison");
  assert.equal(report.assessment.invalidOrMissingTrainingPanels, 2);
});

test("future execution prices cannot rewrite the volatility barriers frozen at a common origin", t => {
  readyMarket(t);
  const outcomes: HorizonResearchPanel[] = [];
  const collector = new HorizonResearchCollector(costs, assets, ORIGIN, panel => outcomes.push(panel));
  collector.onBook(book(ORIGIN));
  for (const delta of [250, 750]) collector.onBook(book(ORIGIN + delta));
  for (const delta of [1000, 1250, 1750]) collector.onBook(book(ORIGIN + delta, "BTC/USD", 110));
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.volatility30mBps, 0);
  for (const path of outcomes[0]!.paths.filter(p => p.action.family === "VOLATILITY")) {
    assert.equal(path.action.volatility30mBps, 0); assert.equal(path.action.referenceSigmaBps, 0);
    assert.equal(path.action.stopLossBps, 10); assert.equal(path.action.takeProfitNetBps, 20);
    assert.ok(path.outcomes.every(o => o.status === "FILLED"));
  }
});

test("training paths are purged before selection locks and later sampling preserves the 31m clock", async t => {
  readyMarket(t);
  const boundary = ORIGIN + 50_000, next = ORIGIN + H.proposalIntervalMs, order: string[] = [];
  const observe = StreamingHorizonAssessment.prototype.observePanel, lock = StreamingHorizonAssessment.prototype.lockSelection;
  t.mock.method(StreamingHorizonAssessment.prototype, "observePanel", function (this: StreamingHorizonAssessment, panel: HorizonResearchPanel) {
    order.push(panel.signalAtMs < boundary ? "TRAINING" : "LATER"); return observe.call(this, panel);
  });
  t.mock.method(StreamingHorizonAssessment.prototype, "lockSelection", function (this: StreamingHorizonAssessment) {
    order.push("LOCK"); return lock.call(this);
  });
  const events = [quote(ORIGIN), quote(ORIGIN + 250), quote(ORIGIN + 750), quote(boundary, "BTC/USD", 110),
    quote(boundary - 1, "ETH/USD"), quote(next), quote(next + 250), quote(next + 750),
    quote(next + 1000, "BTC/USD", 110), quote(next + 1250, "BTC/USD", 110), quote(next + 1750, "BTC/USD", 110)];
  const report = await replayHorizonResearch(events, costs, assets, { ...options, laterStartMs: boundary });
  assert.deepEqual(order.slice(0, 3), ["TRAINING", "LOCK", "LATER"]);
  assert.equal(report.quality.latePreBoundaryEvents, 1);
  assert.equal(report.panels!.length, 2); assert.equal(report.panels![1]!.signalAtMs, next);
  const purged = report.panels![0]!;
  assert.equal(purged.completedAtMs, boundary);
  assert.ok(purged.paths.every(p => p.outcomes.every(o => o.status === "INVALID" && o.reason === "TRAINING_BOUNDARY" && o.netBps === null)));
  assert.equal(report.assessment.boundaryPurgedTrainingPanels, 1);
  assert.equal(report.assessment.trainingPanelsAfterLock, 0);
  assert.equal(report.assessment.completeCommonLaterPanels, 1);
});

test("raw replay retains cross-stream recorder order, skips duplicates, and invalidates true reversals", async t => {
  const seen: BookState[] = []; readyMarket(t, seen);
  const repeated = quote(ORIGIN + 250);
  const events = [quote(ORIGIN), repeated, repeated, trade(ORIGIN + 300), quote(ORIGIN + 290, "ETH/USD"),
    quote(ORIGIN + 750), quote(ORIGIN + 500)];
  const report = await replayHorizonResearch(events, costs, assets, options);
  assert.equal(report.quality.duplicates, 1); assert.equal(report.quality.crossStreamReceiveRegressions, 1);
  assert.equal(report.quality.timestampReversals, 1);
  assert.deepEqual(seen.map(b => [b.symbol, b.receiveTsMs]), [["BTC/USD", ORIGIN], ["BTC/USD", ORIGIN + 250],
    ["ETH/USD", ORIGIN + 290], ["BTC/USD", ORIGIN + 750]]);
  assert.ok(report.panels!.every(p => p.paths.every(path => path.outcomes.every(o => o.status === "INVALID" && o.netBps === null))));
});

test("missing recorded paths remain unknown and a backward disconnect cannot precede already observed fills", async t => {
  readyMarket(t);
  const gap: RecordedEvent = { kind: "RECORDER_GAP", receiveTsMs: ORIGIN + 1000, droppedEvents: 5, droppedBytes: 100 };
  const missing = await replayHorizonResearch([quote(ORIGIN), quote(ORIGIN + 250), quote(ORIGIN + 750), gap], costs, assets, options);
  assert.equal(missing.quality.recorderDroppedEvents, 5);
  assert.ok(missing.panels![0]!.paths.every(p => p.outcomes.every(o => o.status === "INVALID" && o.netBps === null)));
  const disconnected = await replayHorizonResearch([quote(ORIGIN), quote(ORIGIN + 250),
    { kind: "DISCONNECT", stream: "public", receiveTsMs: ORIGIN + 100 }], costs, assets, options);
  const panel = disconnected.panels![0]!;
  assert.equal(disconnected.quality.crossStreamReceiveRegressions, 1);
  assert.ok(panel.completedAtMs >= ORIGIN + 250);
  assert.ok(panel.paths.every(p => p.outcomes.every(o => o.exitAtMs <= panel.completedAtMs && o.netBps === null)));
});

test("quotes beyond the cutoff cannot complete a path or manufacture a later-period observation", async t => {
  readyMarket(t);
  const report = await replayHorizonResearch([quote(ORIGIN), quote(ORIGIN + 250), quote(ORIGIN + 750),
    quote(ORIGIN + 2000, "BTC/USD", 110)], costs, assets,
  { ...options, laterStartMs: ORIGIN + 900, cutoffMs: ORIGIN + 1000 });
  assert.equal(report.quality.futureExcluded, 1); assert.equal(report.quality.lastMs, ORIGIN + 750);
  assert.equal(report.assessment.laterPanels, 0);
  assert.equal(report.panels![0]!.completedAtMs, ORIGIN + 750);
  assert.ok(report.panels![0]!.paths.every(p => p.outcomes.every(o => o.status === "INVALID" && o.netBps === null)));
});

test("missing arrival quotes and gaps in an open path are invalid rather than zero-return nonfills", async t => {
  readyMarket(t);
  const missingEntry = await replayHorizonResearch([quote(ORIGIN), quote(ORIGIN + 1001)], costs, assets, options);
  assert.ok(missingEntry.panels![0]!.paths.every(p => p.outcomes.every(o => o.status === "INVALID"
    && o.reason === "MISSING_ENTRY_ARRIVAL_QUOTE" && o.netBps === null)));
  const openGap = await replayHorizonResearch([quote(ORIGIN), quote(ORIGIN + 250), quote(ORIGIN + 750),
    quote(ORIGIN + 6000)], costs, assets, options);
  assert.ok(openGap.panels![0]!.paths.every(p => p.outcomes.every(o => o.status === "INVALID"
    && o.reason === "QUOTE_GAP" && o.netBps === null)));
  assert.equal(openGap.assessment.completeCommonTrainingPanels, 0);
});
