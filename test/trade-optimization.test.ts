import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTradeOptimization, type OptimizationOrder,
  type OptimizationRouteShadowMark } from "../src/analysis/trade-optimization.js";

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

test("realized deployment evidence is matched to calibrated entry cohorts and uses net returns", () => {
  const firstEntry = { ...maker("entry-a", 0, .8, 1), configurationVersion: "stable-v1",
    regime: "TREND_UP", edgeSource: "CALIBRATED", edgeEffectiveSampleCount: 150,
    economicHorizonMs: 900_000, researchOnly: false };
  const secondEntry = { ...maker("entry-b", 8 * DAY, .8, 1), configurationVersion: "stable-v1",
    regime: "TREND_UP", edgeSource: "CALIBRATED", edgeEffectiveSampleCount: 150,
    economicHorizonMs: 900_000, researchOnly: false };
  const orders = [firstEntry, secondEntry,
    exit("a", 0, 1, .5, "PROFIT_FLOOR", 12, 10),
    exit("b", 8 * DAY, 2, 1, "PROFIT_FLOOR", 14, 12)];
  const report = analyzeTradeOptimization(orders, safeguards(2));
  assert.equal(report.realizedPerformance.closedTrades, 2);
  assert.equal(report.realizedPerformance.cleanMatchedTrades, 2);
  assert.equal(report.realizedPerformance.totalPnl, 3);
  assert.equal(report.realizedPerformance.meanNetReturnBps, 11);
  assert.equal(report.realizedPerformance.deploymentReady, true);
  assert.equal(report.realizedPerformance.deployableGroups.length, 1);

  const research = analyzeTradeOptimization([
    { ...firstEntry, edgeSource: "ANALYTIC", researchOnly: true },
    { ...secondEntry, edgeSource: "ANALYTIC", researchOnly: true },
    ...orders.slice(2),
  ], safeguards(2));
  assert.equal(research.realizedPerformance.dataReady, true);
  assert.equal(research.realizedPerformance.deploymentReady, false);
  assert.equal(research.realizedPerformance.deployableGroups.length, 0);
});

test("route shadows compare executable taker markout with zero for missed maker fills", () => {
  const shadows = [
    routeShadow("a", 0, null, 8),
    routeShadow("b", 8 * DAY, 2, 12),
    { ...routeShadow("delayed", 8 * DAY, null, 100), markDelayMs: 1_001 },
    { ...routeShadow("dirty", 9 * DAY, null, 100), telemetryDroppedRecords: 1 },
  ];
  const report = analyzeTradeOptimization([], safeguards(2), shadows);
  assert.equal(report.entryRouteShadow.marks, 4);
  assert.equal(report.entryRouteShadow.cleanMarks, 3);
  assert.equal(report.entryRouteShadow.excludedUncleanMarks, 1);
  assert.equal(report.entryRouteShadow.excludedInvalidOrDelayedCleanMarks, 1);
  assert.equal(report.entryRouteShadow.decisionHorizon.samples, 2);
  assert.equal(report.entryRouteShadow.decisionHorizon.makerFills, 1);
  assert.equal(report.entryRouteShadow.decisionHorizon.meanMakerPolicyNetBps, 1);
  assert.equal(report.entryRouteShadow.decisionHorizon.meanTakerNetBps, 10);
  assert.ok((report.entryRouteShadow.decisionHorizon.lower95TakerNetBps ?? 0) > 0);
  assert.equal(report.entryRouteShadow.decisionHorizon.meanTakerMinusMakerBps, 9);
  assert.equal(report.entryRouteShadow.dataReady, true);
  assert.equal(report.entryRouteShadow.deploymentReady, true);
  assert.ok((report.entryRouteShadow.decisionHorizon.lower95TakerMinusMakerBps ?? 0) > 0);
});

test("route profitability includes taker-only candidates with no-trade as the alternative", () => {
  const shadows = [
    { ...routeShadow("a", 0, null, 8), makerAvailable: false },
    { ...routeShadow("b", 8 * DAY, null, 12), makerAvailable: false },
  ];
  const report = analyzeTradeOptimization([], safeguards(2), shadows);
  assert.equal(report.entryRouteShadow.decisionHorizon.samples, 2);
  assert.equal(report.entryRouteShadow.pairedMakerTakerMarks, 0);
  assert.equal(report.entryRouteShadow.excludedNoExecutableTakerMarks, 0);
  assert.equal(report.entryRouteShadow.deploymentReady, true);
});

test("a taker route cannot deploy merely because it loses less than the maker alternative", () => {
  const shadows = [routeShadow("a", 0, -20, -1), routeShadow("b", 8 * DAY, -20, -2)];
  const report = analyzeTradeOptimization([], safeguards(2), shadows);
  assert.ok((report.entryRouteShadow.decisionHorizon.lower95TakerMinusMakerBps ?? 0) > 0);
  assert.ok((report.entryRouteShadow.decisionHorizon.lower95TakerNetBps ?? 0) < 0);
  assert.equal(report.entryRouteShadow.dataReady, true);
  assert.equal(report.entryRouteShadow.deploymentReady, false);
});

test("maker-only economic-horizon marks remain visible and require calibrated evidence", () => {
  const shadows = [
    { ...routeShadow("a", 0, 8, 0), takerAvailable: false, takerNetBps: null },
    { ...routeShadow("b", 8 * DAY, 12, 0), takerAvailable: false, takerNetBps: null },
  ];
  const report = analyzeTradeOptimization([], safeguards(2), shadows);
  assert.equal(report.entryRouteShadow.economicHorizon.samples, 0);
  assert.equal(report.entryRouteShadow.makerOnly.economicHorizon.samples, 2);
  assert.equal(report.entryRouteShadow.makerOnly.economicHorizon.fills, 2);
  assert.equal(report.entryRouteShadow.makerOnly.economicHorizon.meanPolicyNetBps, 10);
  assert.equal(report.entryRouteShadow.makerOnly.deploymentReady, true);

  const analytical = analyzeTradeOptimization([], safeguards(2), shadows.map((mark) => ({
    ...mark, edgeSource: "ANALYTIC", edgeEffectiveSampleCount: 0,
  })));
  assert.equal(analytical.entryRouteShadow.makerOnly.dataReady, true);
  assert.equal(analytical.entryRouteShadow.makerOnly.deploymentReady, false);
  assert.match(analytical.entryRouteShadow.makerOnly.reason ?? "", /calibrated/i);
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
  maximumPnlBps = -1, finalPnlBps = -2): OptimizationOrder {
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
        { atMs: openedMs + 15 * 60_000, currentPx: 98, unrealizedPnl: actualPnl,
          unrealizedPnlBps: finalPnlBps, changePnl: -.1, kind: "close" },
      ],
    },
  };
}

function routeShadow(decisionId: string, signalAtMs: number, makerNetBps: number | null,
  takerNetBps: number): OptimizationRouteShadowMark {
  return {
    runId: "clean", telemetryDroppedRecords: 0, decisionId, symbol: "BTC/USD", side: 1,
    family: "CONTINUATION", configurationVersion: "test", regime: "TREND_UP", regimePass: true,
    edgeSource: "CALIBRATED", edgeEffectiveSampleCount: 100, economicHorizonMs: 30_000,
    signalAtMs, horizonMs: 30_000, markDelayMs: 10,
    makerAvailable: true, takerAvailable: true,
    makerFillFraction: makerNetBps === null ? 0 : 1, makerNetBps, takerNetBps,
  };
}
