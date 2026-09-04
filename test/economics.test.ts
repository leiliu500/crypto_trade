import assert from "node:assert/strict";
import test from "node:test";
import type { BookState, Features } from "../src/core/market.js";
import { effectiveSampleCount } from "../src/calibration/effective-sample-count.js";
import { CalibratedEdgeTable } from "../src/calibration/calibrated-edge-table.js";
import { minimumFeasibleHorizonMs } from "../src/economics/feasibility-audit.js";
import { decimalRateToBps, percentToBps, validateFeeBps } from "../src/economics/fee-validation.js";
import { analyticEdges } from "../src/economics/analytic-edge.js";
import { MultiHorizonCostGate, robustCostBps } from "../src/economics/multi-horizon-cost-gate.js";
import type { ConservativeEdge, CostBreakdown, ExecutionPath } from "../src/economics/types.js";
import { DEFAULT_DETERMINISTIC_SIGNAL_CONFIG } from "../src/config/deterministic-defaults.js";
import { scaleEconomicQuantity } from "../src/risk/economic-risk-sizer.js";
import { entryRiskSigmaBps } from "../src/risk/sizing.js";
import { CostModel, exactCostBreakdown } from "../src/strategy/cost.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";

const features: Features = {
  symbol: "BTC/USD", mid: 100, spread: .01, spreadBps: 1, microprice: 100, visibleDepth: 2,
  qi1: 0, qiK: 0, persistentQiK: 0, ofi: 0, tfi: 0,
  bidCancellationRatio: 0, askCancellationRatio: 0, replenishmentPressure: 0,
  velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
  microEdgeZ: 0, velocityZ: 0, accelerationZ: 0, efficiency: .5,
  cusumUp: false, cusumDown: false, spreadZ: 0, depthZ: 0, signalFlipRate: 0,
  providerAgeMs: 0, staleThresholdMs: 100, warmedUp: true, kinematicsReady: true,
  stale: false, staleReason: null, receiveTsMs: 1_000,
};
const book: BookState = {
  symbol: "BTC/USD", bids: [{ px: 99.995, qty: 1 }, { px: 99.985, qty: 1 }],
  asks: [{ px: 100.005, qty: 1 }, { px: 100.015, qty: 1 }],
  exchangeTsMs: 1_000, receiveTsMs: 1_000, sequence: 1n, valid: true, sourceReset: true,
};

function edge(source: ConservativeEdge["source"] = "ANALYTIC"): ConservativeEdge {
  return { source, side: 1, horizonMs: 900_000, grossBeforeUncertaintyBps: 50,
    signalUncertaintyBps: 5, conservativeGrossBps: 45, quality: .7,
    effectiveSampleCount: source === "CALIBRATED" ? 200 : 0 };
}
function cost(path: ExecutionPath, estimatedCostBps: number, supported = true, fillProbability = 1): CostBreakdown {
  return { path, supported, entryExecutionBps: 0, exitExecutionBps: 0, entryFeeBps: estimatedCostBps / 2,
    exitFeeBps: estimatedCostBps / 2, marketImpactBps: 0, latencyBps: 0, adverseSelectionBps: 0,
    fundingBps: 0, borrowBps: 0, estimatedCostBps, positiveCostErrorP95Bps: 1, fillProbability };
}

test("fee units are explicit and implausible per-leg fees fail closed", () => {
  assert.equal(percentToBps(.15), 15);
  assert.equal(decimalRateToBps(.0015), 15);
  assert.equal(validateFeeBps(25), 25);
  assert.throws(() => validateFeeBps(5_000), /basis-point value/);
});

test("taker book walking counts top-of-book crossing and incremental impact once", () => {
  const model = new CostModel({ makerFeeBps: 15, takerFeeBps: 25, makerExitFillProbability: .65, makerExitFallbackAdverseBps: 2,
    latencyAdverseFraction: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 });
  const estimate = model.estimate(features, book, 1, 2, false)!;
  assert.ok(Math.abs(estimate.spreadBps - 1) < 1e-6);
  assert.ok(Math.abs(estimate.impactBps - .5) < 1e-6);
  assert.ok(Math.abs(estimate.roundTripBps - 51.5) < 1e-6);
  const paths = model.pathEstimates(features, book, 1, 2, .8);
  assert.equal(paths.length, 4);
  assert.equal(paths.find((item) => item.path === "MAKER_MAKER")?.supported, false);
  assert.ok(Math.abs(paths.find((item) => item.path === "TAKER_TAKER")!.estimatedCostBps - 51.5) < 1e-6);
  const boundedExit = paths.find((item) => item.path === "MAKER_MAKER_TAKER_FALLBACK")!;
  assert.equal(boundedExit.supported, true);
  assert.ok(boundedExit.estimatedCostBps > 40);
  assert.ok(boundedExit.estimatedCostBps > paths.find((item) => item.path === "MAKER_TAKER")!.estimatedCostBps);
});

test("maker entry economics remain profitable only after a full taker exit", () => {
  const model = new CostModel({ makerFeeBps: 2, takerFeeBps: 5, makerExitFillProbability: .99,
    makerExitFallbackAdverseBps: 2, latencyAdverseFraction: 0, adverseSelectionBps: 1,
    fundingBps: 0, borrowBps: 0 });
  const estimate = model.estimate(features, book, 1, 1, true)!;
  assert.equal(estimate.feeBps, 7);
  assert.equal(estimate.entryFeeBps, 2);
  assert.equal(estimate.exitFeeBps, 5);
  assert.ok(Math.abs(estimate.spreadBps - .5) < 1e-9);
  assert.equal(estimate.adverseSelectionBps, 3);
  assert.ok(Math.abs(estimate.roundTripBps - 10.5) < 1e-9);
  const exact = exactCostBreakdown(estimate, "MAKER_TAKER", .5);
  assert.equal(exact.entryFeeBps, 2);
  assert.equal(exact.exitFeeBps, 5);
});

test("multi-horizon gate selects the strongest conservative edge across horizon and path", () => {
  const gate = new MultiHorizonCostGate({ costSafetyFactor: 1.5, minimumNetEdgeBps: .5,
    fullQualityEdgeBps: 20, minimumEconomicSizeScale: .2, minimumMakerFillProbability: .4,
    minimumEffectiveSampleCount: 100, maximumReasonableCostBps: 1_000, maximumReasonableGrossBps: 2_000 }, "ANALYTIC_PAPER");
  const decision = gate.evaluate([{ ...edge(), horizonMs: 300_000, conservativeGrossBps: 35 }, edge()], [cost("MAKER_MAKER", 1, false, .9),
    cost("MAKER_TAKER", 25, true, .8), cost("TAKER_TAKER", 30)]);
  assert.equal(decision.pass, true);
  assert.equal(decision.selected?.cost.path, "MAKER_TAKER");
  assert.equal(decision.selected?.edge.horizonMs, 900_000);
  assert.equal(decision.selected?.robustCostBps, 26);
  assert.equal(decision.selected?.lowerBoundNetBps, 19);
  assert.ok(decision.sizeScale >= .2 && decision.sizeScale < 1);
  assert.equal(robustCostBps(cost("TAKER_TAKER", 10), 1.5), 11);
  const inconsistent = { ...cost("TAKER_TAKER", 10), estimatedCostBps: 9 };
  assert.ok(gate.evaluate([edge()], [inconsistent]).bestRejected?.rejectionReasons.includes("INVALID_ECONOMICS"));
  const rejected = gate.evaluate([{ ...edge(), conservativeGrossBps: 5 }],
    [cost("MAKER_MAKER", 1, false, .9), cost("MAKER_TAKER", 10, true, .8)]);
  assert.equal(rejected.bestRejected?.cost.path, "MAKER_TAKER");
});

test("an observed strong continuation clears economics with the bounded entry-risk horizon", () => {
  const cfg = DEFAULT_DETERMINISTIC_SIGNAL_CONFIG;
  const observed = {
    slowTrendReady: true, breakoutUpBps: 0, breakoutDownBps: 0,
    trendFastBps: -74.17731811699468, trendMediumBps: -130.41169857636703,
    trendSlowBps: -294.72346655119, slowVarianceRate: 1.4536446914795633e-8,
    slowTrendAlignment: -.9987679691013045, slowTrendEfficiency: .2283216424462419,
    spreadBps: .12971262168665323, flowFlipRate: .12162162162162163,
  };
  const continuation = {
    score: .58617383655469, efficiency: 0, flowPersistence: 0, velocity: 0, breakoutHold: 0,
    regimeStability: 0, volatilitySuitability: 0, slowTrendAlignment: .9987679691013045,
    slowTrendEfficiency: .2283216424462419,
  };
  const edges = analyticEdges({ side: -1, features: observed as unknown as DeterministicFeatures, continuation }, {
    horizons: cfg.analyticHorizons, spreadUncertaintyWeight: cfg.analyticEdge.spreadUncertaintyWeight,
    flipUncertaintyWeight: cfg.analyticEdge.flipUncertaintyWeight,
  });
  const observedCost: CostBreakdown = {
    path: "MAKER_MAKER_TAKER_FALLBACK", supported: true, entryExecutionBps: 0,
    exitExecutionBps: .022699708795164315, entryFeeBps: 2, exitFeeBps: 2,
    marketImpactBps: 0, latencyBps: 7.483492833739327, adverseSelectionBps: 2.75,
    fundingBps: 0, borrowBps: 0, estimatedCostBps: 14.256192542534492,
    positiveCostErrorP95Bps: 2, fillProbability: .4440526452447344,
  };
  const gate = new MultiHorizonCostGate({
    costSafetyFactor: cfg.costSafetyFactor, minimumNetEdgeBps: cfg.minimumNetEdgeBps,
    fullQualityEdgeBps: cfg.fullQualityEdgeBps, minimumEconomicSizeScale: cfg.minimumEconomicSizeScale,
    minimumMakerFillProbability: cfg.minimumMakerFillProbability,
    minimumEffectiveSampleCount: cfg.minimumEffectiveSampleCount,
    maximumReasonableCostBps: cfg.maximumReasonableCostBps,
    maximumReasonableGrossBps: cfg.maximumReasonableGrossBps,
  }, cfg.economicEdgeMode);
  const selected = gate.evaluate(edges, [observedCost]).selected!;
  const riskSigmaBps = entryRiskSigmaBps(observed.slowVarianceRate, selected.edge.horizonMs, 900_000);
  const maximumLossBps = 3 * riskSigmaBps + 5 * 3.7417464168696637
    + observed.spreadBps / 2 + observedCost.entryFeeBps;
  const rewardRisk = selected.lowerBoundNetBps / maximumLossBps;
  const makerExpectedValueBps = observedCost.fillProbability * selected.lowerBoundNetBps
    - (1 - observedCost.fillProbability) * 2 - 1;

  assert.equal(selected.edge.horizonMs, 14_400_000);
  assert.ok(rewardRisk >= .2);
  assert.ok(makerExpectedValueBps >= .25);
});

test("robust cost keeps known fees exact and stresses only uncertain execution components", () => {
  const observed: CostBreakdown = {
    path: "MAKER_TAKER", supported: true,
    entryExecutionBps: 1, exitExecutionBps: 1,
    entryFeeBps: 15, exitFeeBps: 25,
    marketImpactBps: 2, latencyBps: 1, adverseSelectionBps: 1,
    fundingBps: 0, borrowBps: 0,
    estimatedCostBps: 46, positiveCostErrorP95Bps: 2, fillProbability: .8,
  };
  assert.equal(robustCostBps(observed, 1.75), 50.5);
});

test("live economics require calibrated policy returns and sufficient effective samples", () => {
  const gate = new MultiHorizonCostGate({ costSafetyFactor: 1, minimumNetEdgeBps: .5,
    fullQualityEdgeBps: 20, minimumEconomicSizeScale: .2, minimumMakerFillProbability: .4,
    minimumEffectiveSampleCount: 100, maximumReasonableCostBps: 1_000, maximumReasonableGrossBps: 2_000 }, "CALIBRATED_LIVE");
  assert.equal(gate.evaluate([edge("ANALYTIC")], [cost("TAKER_TAKER", 10)]).pass, false);
  assert.equal(gate.evaluate([{ ...edge("CALIBRATED"), effectiveSampleCount: 99 }], [cost("TAKER_TAKER", 10)]).pass, false);
  assert.equal(gate.evaluate([edge("CALIBRATED")], [cost("TAKER_TAKER", 10)]).pass, true);
});

test("calibrated paper economics reject analytical estimates just like live economics", () => {
  const gate = new MultiHorizonCostGate({ costSafetyFactor: 1, minimumNetEdgeBps: .5,
    fullQualityEdgeBps: 20, minimumEconomicSizeScale: .2, minimumMakerFillProbability: .4,
    minimumEffectiveSampleCount: 100, maximumReasonableCostBps: 1_000, maximumReasonableGrossBps: 2_000 }, "CALIBRATED_PAPER");
  const analytical = gate.evaluate([edge("ANALYTIC")], [cost("TAKER_TAKER", 10)]);
  assert.equal(analytical.pass, false);
  assert.ok(analytical.bestRejected?.rejectionReasons.includes("CALIBRATED_EDGE_REQUIRED"));
  assert.equal(gate.evaluate([edge("CALIBRATED")], [cost("TAKER_TAKER", 10)]).pass, true);
});

test("calibrated edge buckets remain execution-path specific", () => {
  const table = new CalibratedEdgeTable([{ symbol: "BTC/USD", family: "CONTINUATION", side: 1, regime: "TREND_UP",
    minimumQuality: .5, maximumQuality: 1, minimumSpreadBps: 0, maximumSpreadBps: 5,
    horizonMs: 900_000, path: "MAKER_TAKER", meanGrossReturnBps: 30,
    lowerConfidenceGrossReturnBps: 20, effectiveSampleCount: 150 }]);
  const resolved = table.resolve({ symbol: "BTC/USD", family: "CONTINUATION", side: 1, regime: "TREND_UP", quality: .7, spreadBps: 1 });
  assert.equal(resolved[0]?.executionPath, "MAKER_TAKER");
  assert.equal(resolved[0]?.conservativeGrossBps, 20);
});

test("effective samples, feasibility, and post-pass economic sizing are bounded", () => {
  assert.equal(effectiveSampleCount([1, 1, 1, 1]), 4);
  assert.ok(effectiveSampleCount([1, .1, .1, .1]) < 4);
  const horizon = minimumFeasibleHorizonMs({ varianceRate: 1e-8, continuationQuality: .5,
    sigmaCaptureFraction: .5, breakoutContributionBps: 0, robustCostBps: 40,
    fixedSignalUncertaintyBps: 5, minimumNetEdgeBps: .5 });
  assert.ok(Number.isFinite(horizon) && horizon > 0);
  assert.equal(scaleEconomicQuantity(10, .49, .5, 20, .2), 0);
  assert.equal(scaleEconomicQuantity(10, .5, .5, 20, .2), 2);
  assert.equal(scaleEconomicQuantity(10, 20, .5, 20, .2), 10);
});
