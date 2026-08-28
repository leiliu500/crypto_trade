import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTradeOptimization, type OptimizationOrder } from "../src/analysis/trade-optimization.js";

const DAY = 86_400_000;

test("maker-fill calibration excludes contaminated runs and requires discrimination before deployment", () => {
  const orders = [
    maker("high-fill", 0, .9, 1),
    maker("high-fill-2", 3 * DAY, .8, .5),
    maker("low-miss", 6 * DAY, .2, 0),
    maker("low-miss-2", 8 * DAY, .1, 0),
    { ...maker("dirty", 9 * DAY, .99, 1), telemetryDroppedRecords: 1 },
    { ...maker("pending", 10 * DAY, .9, 0), status: "NEW" },
  ];
  const report = analyzeTradeOptimization(orders, safeguards(4));
  assert.equal(report.makerFill.attempts, 4);
  assert.equal(report.makerFill.anyFilled, 2);
  assert.equal(report.makerFill.excludedUncleanAttempts, 1);
  assert.equal(report.makerFill.pendingAttempts, 1);
  assert.equal(report.makerFill.rocAuc, 1);
  assert.equal(report.makerFill.dataReady, true);
  assert.equal(report.makerFill.deploymentReady, true);
  assert.ok(report.makerFill.fittedHazardInterceptOffset !== null);
  assert.equal(report.dataQuality.excludedOrdersFromRunsWithDropsOrNoHealth, 1);
});

test("ten-minute timeout shadow stays below the active fifteen-minute exit and uses only unproductive trades", () => {
  const orders = [
    exit("improved-a", 0, -10, -2, "UNPRODUCTIVE_TIME_STOP"),
    exit("improved-b", 8 * DAY, -5, -1, "UNPRODUCTIVE_TIME_STOP"),
    exit("productive", 9 * DAY, 2, 1, "PROFIT_FLOOR", 3),
    { ...exit("dirty", 10 * DAY, -10, -1, "UNPRODUCTIVE_TIME_STOP"), telemetryDroppedRecords: 4 },
  ];
  const report = analyzeTradeOptimization(orders, safeguards(2));
  assert.equal(report.unproductiveExitShadow.closedTrades, 3);
  assert.equal(report.unproductiveExitShadow.eligibleTrades, 2);
  assert.equal(report.unproductiveExitShadow.excludedUncleanTrades, 1);
  assert.equal(report.unproductiveExitShadow.actualTotalPnl, -15);
  assert.equal(report.unproductiveExitShadow.counterfactualTotalPnl, -3);
  assert.equal(report.unproductiveExitShadow.totalPnlDelta, 12);
  assert.equal(report.unproductiveExitShadow.counterfactualWins, 2);
  assert.equal(report.unproductiveExitShadow.dataReady, true);
  assert.equal(report.unproductiveExitShadow.deploymentReady, true);
  assert.ok((report.unproductiveExitShadow.lower95AveragePnlDelta ?? 0) > 0);
  const insufficient = analyzeTradeOptimization(orders, safeguards(3));
  assert.equal(insufficient.unproductiveExitShadow.reason, "Only 2 clean 10-minute unproductive trades; 3 required");
});

function safeguards(minimumSamples: number) {
  return { minimumDurationMs: 7 * DAY, minimumSamples, shadowUnproductiveExitMs: 10 * 60_000,
    activeUnproductiveExitMs: 15 * 60_000 };
}

function maker(clientOrderId: string, createdMs: number, fillProbability: number, filledQty: number): OptimizationOrder {
  return {
    clientOrderId, runId: "clean", telemetryDroppedRecords: 0, symbol: "BTC/USD", side: 1, style: "maker",
    status: filledQty > 0 ? "FILLED" : "CANCELED", requestedQty: 1, filledQty, fillProbability,
    reduceOnlyIntent: false, createdMs, updatedMs: createdMs + 1_000, entryFamily: "PULLBACK_RECOVERY",
    cancellationReason: filledQty > 0 ? null : "SIGNAL_INVALIDATED", exitReason: null, livePosition: null,
  };
}

function exit(clientOrderId: string, openedMs: number, actualPnl: number, pnlAt10m: number, exitReason: string,
  maximumPnlBps = -1): OptimizationOrder {
  const target = openedMs + 10 * 60_000;
  return {
    clientOrderId, runId: "clean", telemetryDroppedRecords: 0, symbol: "ETH/USD", side: -1, style: "taker",
    status: "FILLED", requestedQty: 1, filledQty: 1, fillProbability: 1, reduceOnlyIntent: true,
    createdMs: openedMs + 15 * 60_000, updatedMs: openedMs + 15 * 60_000 + 1_000,
    entryFamily: null, cancellationReason: null, exitReason,
    livePosition: {
      openedMs, closedAtMs: openedMs + 15 * 60_000, realizedPnl: actualPnl, entryOrderId: `entry-${clientOrderId}`,
      pnlHistory: [
        { atMs: openedMs + 1_000, currentPx: 100, unrealizedPnl: -.1, unrealizedPnlBps: maximumPnlBps, changePnl: null, kind: "mark" },
        { atMs: target, currentPx: 99, unrealizedPnl: pnlAt10m, unrealizedPnlBps: maximumPnlBps, changePnl: -.1, kind: "mark" },
        { atMs: openedMs + 15 * 60_000, currentPx: 98, unrealizedPnl: actualPnl, unrealizedPnlBps: -2, changePnl: -.1, kind: "close" },
      ],
    },
  };
}
