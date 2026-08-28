import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import { EntryRouteShadowTracker } from "../src/execution/entry-route-shadow.js";
import type { ExecutionPlan } from "../src/execution/planner.js";

test("route shadow consumes queue ahead causally and scales a partial maker markout", () => {
  const tracker = new EntryRouteShadowTracker([1_000]);
  assert.equal(tracker.start({
    decisionId: "decision", symbol: "BTC/USD", side: 1, family: "CONTINUATION", createdMs: 1_000,
    selectedStyle: "maker", makerPlan: plan("maker", 2, 100), takerPlan: plan("taker", .5, 101),
    makerQueueAheadQty: 2,
  }), true);
  tracker.observeTrade({ id: "queue", symbol: "BTC/USD", px: 100, qty: 1, aggressor: -1,
    exchangeTsMs: 1_400, receiveTsMs: 1_500 });
  tracker.observeTrade({ id: "partial", symbol: "BTC/USD", px: 100, qty: 2, aggressor: -1,
    exchangeTsMs: 1_500, receiveTsMs: 1_600 });

  const marks = tracker.mark("BTC/USD", {
    ...book(101, 102, 2_000), bids: [{ px: 101, qty: .5 }, { px: 100, qty: 10 }],
  }, 2_000);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]?.makerFilledQty, 1);
  assert.equal(marks[0]?.makerFillFraction, .5);
  assert.equal(marks[0]?.makerFillLatencyMs, 600);
  assert.equal(marks[0]?.makerExecutableExitPx, 100.5);
  assert.equal(marks[0]?.takerExecutableExitPx, 101);
  assert.ok(Math.abs((marks[0]?.makerNetBps ?? 0) - 24) < 1e-9);
  assert.ok(Math.abs((marks[0]?.takerNetBps ?? 0) + 10) < 1e-9);
  assert.equal(tracker.size(), 0);
});

test("unfilled maker policy is preserved as zero while missed executable taker alpha is recorded", () => {
  const tracker = new EntryRouteShadowTracker([1_000]);
  tracker.start({
    decisionId: "miss", symbol: "BTC/USD", side: 1, family: "CONTINUATION", createdMs: 1_000,
    selectedStyle: "maker", makerPlan: plan("maker", 1, 100), takerPlan: plan("taker", .25, 101),
    makerQueueAheadQty: 10,
  });
  const mark = tracker.mark("BTC/USD", book(102, 103, 2_000), 2_000)[0]!;
  assert.equal(mark.makerFillFraction, 0);
  assert.equal(mark.makerNetBps, null);
  assert.ok((mark.takerNetBps ?? 0) > 0);
  assert.equal(mark.missedTakerAlphaBps, mark.takerNetBps);
});

function plan(style: "maker" | "taker", qty: number, entryPx: number): ExecutionPlan {
  return {
    clientOrderId: `${style}-order`, decisionId: "decision", riskApprovalId: `${style}-risk`, symbol: "BTC/USD",
    side: 1, qty, limitPx: entryPx, style, timeInForce: style === "maker" ? "gtc" : "ioc",
    createdMs: 1_000, expiresMs: 2_500, originatingSequence: 1n, featureHash: "features",
    strategyVersion: "test", modelVersion: "none",
    expectedCost: { roundTripBps: style === "maker" ? 2 : 10, spreadBps: 0,
      feeBps: style === "maker" ? 2 : 10, impactBps: 0, latencyBps: 0,
      adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0,
      ...(style === "taker" ? { entryVwap: entryPx, worstEntryPx: entryPx } : {}) },
    risk: { qty, riskBudget: 100, maximumLossPerUnit: 1, modeledMaximumLoss: qty,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "notional" },
    fillProbability: style === "maker" ? .4 : 1, expectedValue: 1, reduceOnlyIntent: false,
    entryFamily: "CONTINUATION", executionPath: style === "maker" ? "MAKER_TAKER" : "TAKER_TAKER",
  };
}

function book(bid: number, ask: number, receiveTsMs: number): BookState {
  return { symbol: "BTC/USD", bids: [{ px: bid, qty: 10 }], asks: [{ px: ask, qty: 10 }],
    exchangeTsMs: receiveTsMs - 1, receiveTsMs, sequence: 2n, valid: true, sourceReset: false };
}
