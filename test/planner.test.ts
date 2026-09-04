import assert from "node:assert/strict";
import test from "node:test";
import type { BookState, Features } from "../src/core/market.js";
import { bufferedTakerLimitPrice, ExecutionPlanner, type PlannerConfig } from "../src/execution/planner.js";
import { RiskSizer } from "../src/risk/sizing.js";
import { CostModel } from "../src/strategy/cost.js";
import type { TradeIntent } from "../src/strategy/signal.js";

const features: Features = {
  symbol: "BTC/USD", mid: 100, spread: .01, spreadBps: 1, microprice: 100, visibleDepth: 40,
  qi1: .5, qiK: .5, persistentQiK: .5, ofi: 1, tfi: 1,
  bidCancellationRatio: 0, askCancellationRatio: 0, replenishmentPressure: .5,
  velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
  microEdgeZ: 0, velocityZ: 0, accelerationZ: 0, efficiency: 1,
  cusumUp: true, cusumDown: false, spreadZ: 0, depthZ: 0, signalFlipRate: 0,
  providerAgeMs: 5, staleThresholdMs: 100, warmedUp: true, kinematicsReady: true,
  stale: false, staleReason: null, receiveTsMs: 1_000,
};

const book: BookState = {
  symbol: "BTC/USD", bids: [{ px: 99.995, qty: 20 }], asks: [{ px: 100.005, qty: 20 }],
  exchangeTsMs: 995, receiveTsMs: 1_000, sequence: 1n, valid: true, sourceReset: true,
};

const intent: TradeIntent = {
  side: 1, probability: .8, predictedGrossBps: 20, lowerBoundNetBps: 10, quality: 1, decisionTsMs: 1_000,
};

const hybridEntry: PlannerConfig["hybridEntry"] = {
  allowAnalyticPaperExecution: false,
  analyticPaperSizeMultiplier: .1,
  continuationTakerEnabled: true, continuationTakerSizeMultiplier: .25,
  continuationTakerMinimumScore: .3, continuationTakerMinimumNetEdgeBps: 8,
  continuationTakerMinimumExpectedValueBps: 1, continuationTakerMinimumOfi: .5,
  continuationTakerMinimumTfi: .2, continuationTakerMinimumQiK: .15,
  continuationTakerMaximumLatencyHalfLifeFraction: .25, continuationTakerMinimumLatencySamples: 20,
  routeShadowEnabled: true, routeShadowHorizonsMs: [1_000, 5_000, 30_000],
};

function planner(takerLimitBufferBps = 0, fillHazardIntercept = 5,
  overrides: Partial<PlannerConfig> = {}): ExecutionPlanner {
  return new ExecutionPlanner({
    makerTtlMs: 1_500, alphaHalfLifeMs: 4_000, minimumFillProbability: .65, takerLimitBufferBps, cancelAheadFraction: .5,
    pullbackMakerTtlMs: 20_000, pullbackKinematicsGraceMs: 5_000, pullbackKinematicsGraceEvents: 2,
    pullbackSignalInvalidationGraceMs: 5_000, pullbackSignalInvalidationGraceEvents: 3,
    continuationSignalInvalidationGraceMs: 750, continuationSignalInvalidationGraceEvents: 3,
    continuationAdverseFlowConfirmationMs: 100, continuationAdverseFlowConfirmationEvents: 2,
    adverseFlowConfirmationMs: 2_000, adverseFlowConfirmationEvents: 3,
    adverseOfiThreshold: 2, adverseTfiThreshold: .5,
    minimumExpectedValueBps: 0, minimumRewardRiskRatio: 0,
    fillHazardIntercept, fillHazardAggressiveWeight: 0, fillHazardFlowWeight: 0,
    fillHazardImbalanceWeight: 0, fillHazardSpreadWeight: 0,
    makerOpportunityCostBps: 0, staleOrderCostBps: 0, maximumImpactBps: 10, maximumIterations: 5,
    hybridEntry,
    ...overrides,
  }, new RiskSizer({
    baseRiskFraction: .001, maximumDrawdown: .05, maximumBookParticipation: .1,
    fractionalKelly: .1, maximumKellyFraction: .05, targetSigmaHBps: 20, minimumQualityScale: .1,
  }), new CostModel({
    makerFeeBps: 0, takerFeeBps: 4, makerExitFillProbability: .65, makerExitFallbackAdverseBps: 1, latencyAdverseFraction: 0,
    adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0,
  }), "test-strategy", "none");
}

function directionalFillPlanner(): ExecutionPlanner {
  return new ExecutionPlanner({
    makerTtlMs: 1_500, alphaHalfLifeMs: 4_000, minimumFillProbability: .4, takerLimitBufferBps: 0,
    cancelAheadFraction: .5, pullbackMakerTtlMs: 20_000,
    pullbackKinematicsGraceMs: 5_000, pullbackKinematicsGraceEvents: 2,
    pullbackSignalInvalidationGraceMs: 5_000, pullbackSignalInvalidationGraceEvents: 3,
    continuationSignalInvalidationGraceMs: 750, continuationSignalInvalidationGraceEvents: 3,
    continuationAdverseFlowConfirmationMs: 100, continuationAdverseFlowConfirmationEvents: 2,
    adverseFlowConfirmationMs: 2_000, adverseFlowConfirmationEvents: 3,
    adverseOfiThreshold: 2, adverseTfiThreshold: .5,
    minimumExpectedValueBps: 0, minimumRewardRiskRatio: 0,
    fillHazardIntercept: -1, fillHazardAggressiveWeight: .1, fillHazardFlowWeight: 1,
    fillHazardImbalanceWeight: .5, fillHazardSpreadWeight: .05,
    makerOpportunityCostBps: 2, staleOrderCostBps: 1, maximumImpactBps: 10, maximumIterations: 5,
    hybridEntry,
  }, new RiskSizer({
    baseRiskFraction: .001, maximumDrawdown: .05, maximumBookParticipation: .1,
    fractionalKelly: .1, maximumKellyFraction: .05, targetSigmaHBps: 20, minimumQualityScale: .1,
  }), new CostModel({
    makerFeeBps: 15, takerFeeBps: 25, makerExitFillProbability: .65, makerExitFallbackAdverseBps: 2,
    latencyAdverseFraction: .25, adverseSelectionBps: 1, fundingBps: 0, borrowBps: 0,
  }), "test-strategy", "none");
}

test("preliminary cost considers an eligible maker entry", () => {
  const execution = planner();
  const preliminary = execution.preliminaryCost(features, book, 1, .001);
  assert.ok(preliminary);
  assert.ok(preliminary.roundTripBps < 6);
});

test("maker planning remains possible when the exact taker cost gate rejects", () => {
  const execution = planner();
  const plan = execution.build(intent, features, book, {
    symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001,
    maximumOrderQty: 1_000, shortable: false,
  }, {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  }, false, {
    createdMs: 1_000,
    revalidateCost: (cost) => cost.roundTripBps < 6 ? intent : null,
  });
  assert.ok(plan);
  assert.equal(plan.style, "maker");
  assert.equal(plan.timeInForce, "gtc");
  assert.ok(plan.expectedCost.roundTripBps < 6);
  assert.equal(execution.latestBuildRejection(), null);
});

test("maker-only planning reports fill probability and exact-cost failures separately", () => {
  const baseRisk = {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  };
  const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };

  const lowFill = directionalFillPlanner();
  assert.equal(lowFill.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_MAKER_TAKER_FALLBACK" }), null);
  const fillRejection = lowFill.latestBuildRejection();
  assert.equal(fillRejection?.reason, "MAKER_FILL_PROBABILITY_BELOW_MINIMUM");
  assert.ok(Number(fillRejection?.values.fillProbability) < Number(fillRejection?.values.minimumFillProbability));

  const exactCost = planner();
  assert.equal(exactCost.build(intent, features, book, asset, baseRisk, false, {
    createdMs: 1_000, executionPath: "MAKER_MAKER_TAKER_FALLBACK", revalidateCost: () => null,
  }), null);
  assert.equal(exactCost.latestBuildRejection()?.reason, "EXACT_COST_REVALIDATION_FAILED");
});

test("planner rejects small-edge entries whose conservative reward cannot justify modeled loss", () => {
  const execution = planner(0, 5, { minimumRewardRiskRatio: .2 });
  const plan = execution.build(intent, features, book, {
    symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001,
    maximumOrderQty: 1_000, shortable: false,
  }, {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  }, false, { createdMs: 1_000, executionPath: "MAKER_TAKER" });

  assert.equal(plan, null);
  assert.equal(execution.latestBuildRejection()?.reason, "REWARD_RISK_BELOW_MINIMUM");
});

test("planner rejects maker orders whose calibrated fill chance makes order-level EV negative", () => {
  const execution = planner(0, -3.25, {
    minimumFillProbability: .01, minimumExpectedValueBps: 0,
    makerOpportunityCostBps: 2, staleOrderCostBps: 1,
  });
  const plan = execution.build(intent, features, book, {
    symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001,
    maximumOrderQty: 1_000, shortable: false,
  }, {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  }, false, { createdMs: 1_000, executionPath: "MAKER_TAKER" });

  assert.equal(plan, null);
  assert.equal(execution.latestBuildRejection()?.reason, "EXPECTED_VALUE_BELOW_MINIMUM");
});

test("conservative calibration still fires a maker order when edge, fill chance, and reward-risk all pass", () => {
  const execution = planner(0, -3.25, {
    minimumFillProbability: .05, minimumExpectedValueBps: .25, minimumRewardRiskRatio: .25,
    makerOpportunityCostBps: 2, staleOrderCostBps: 1,
    fillHazardFlowWeight: 1, fillHazardImbalanceWeight: .5,
  });
  const strongIntent = { ...intent, predictedGrossBps: 200, lowerBoundNetBps: 100 };
  const fillableFeatures = { ...features, tfi: -.1, qi1: -.5 };
  const plan = execution.build(strongIntent, fillableFeatures, book, {
    symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001,
    maximumOrderQty: 1_000, shortable: false,
  }, {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: .5, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  }, false, { createdMs: 1_000, executionPath: "MAKER_TAKER" });

  assert.ok(plan);
  assert.ok(plan.fillProbability >= .05);
  assert.ok(plan.expectedValue > 0);
  assert.equal(plan.conservativeNetEdgeBps, 100);
  assert.ok((plan.conservativeExpectedValueBps ?? 0) > 0);
  assert.ok((plan.rewardRiskRatio ?? 0) >= .25);
});

test("analytical research plans retain cohort metadata and reduced deterministic size", () => {
  const execution = planner(0, 5);
  const riskContext = {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  };
  const normal = execution.build(intent, features, book,
    { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01,
      maximumOrderQty: 100, shortable: true }, riskContext, false,
    { createdMs: 1_000, executionPath: "MAKER_TAKER" })!;
  const research = execution.build(intent, features, book,
    { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01,
      maximumOrderQty: 100, shortable: true }, riskContext, false,
    { createdMs: 1_000, executionPath: "MAKER_TAKER", quantityMultiplier: .1,
      configurationVersion: "research-v1", regime: "TREND_UP", edgeSource: "ANALYTIC",
      edgeEffectiveSampleCount: 0, researchOnly: true })!;
  assert.ok(research.qty < normal.qty);
  assert.equal(research.configurationVersion, "research-v1");
  assert.equal(research.regime, "TREND_UP");
  assert.equal(research.edgeSource, "ANALYTIC");
  assert.equal(research.edgeEffectiveSampleCount, 0);
  assert.equal(research.researchOnly, true);
});

test("the economic execution path constrains the final order style", () => {
  const execution = planner();
  const baseRisk = {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  };
  const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  const taker = execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "TAKER_TAKER", economicHorizonMs: 900_000 });
  assert.equal(taker?.style, "taker");
  assert.equal(taker?.executionPath, "TAKER_TAKER");
  assert.equal(taker?.economicHorizonMs, 900_000);
  const maker = execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_TAKER", economicHorizonMs: 300_000 });
  assert.equal(maker?.style, "maker");
  assert.equal(maker?.executionPath, "MAKER_TAKER");
  const boundedMakerExit = execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_MAKER_TAKER_FALLBACK", economicHorizonMs: 300_000 });
  assert.equal(boundedMakerExit?.style, "maker");
  assert.equal(boundedMakerExit?.executionPath, "MAKER_MAKER_TAKER_FALLBACK");
  assert.equal(execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_MAKER" }), null);
});

test("maker fill modeling uses the family TTL and competes with signal decay", () => {
  const execution = planner(0, -3);
  const continuationProbability = execution.makerFillProbability(features, book, 1, "CONTINUATION");
  const pullbackProbability = execution.makerFillProbability(features, book, 1, "PULLBACK_RECOVERY");
  assert.ok(Math.abs(continuationProbability - competingFillProbability(Math.exp(-3), 1.5, 4)) < 1e-12);
  assert.ok(Math.abs(pullbackProbability - competingFillProbability(Math.exp(-3), 20, 4)) < 1e-12);
  assert.ok(pullbackProbability > continuationProbability);

  const executable = planner();
  const plan = executable.build(intent, features, book, {
    symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001,
    maximumOrderQty: 1_000, shortable: false,
  }, {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  }, false, { createdMs: 1_000, executionPath: "MAKER_TAKER", entryFamily: "PULLBACK_RECOVERY" });
  assert.equal(plan?.entryFamily, "PULLBACK_RECOVERY");
  assert.equal(plan?.expiresMs, 21_000);
});

test("maker fill probability follows contra-side flow instead of same-side momentum", () => {
  const execution = directionalFillPlanner();
  const ethIncident = { ...features, symbol: "ETH/USD", mid: 2480.8045, spread: .409,
    spreadBps: 1.6486587314724135, tfi: 1, qi1: -.006542300646753155 };
  const ethBook = { ...book, symbol: "ETH/USD",
    bids: [{ px: 2480.6, qty: 20 }], asks: [{ px: 2481.009, qty: 20 }] };
  const sameSideBuyFlow = execution.makerFillProbability(ethIncident, ethBook, 1, "PULLBACK_RECOVERY");
  const contraSellFlow = execution.makerFillProbability({ ...ethIncident, tfi: -1, qi1: -.5 }, ethBook, 1,
    "PULLBACK_RECOVERY");
  const mirroredContraBuyFlow = execution.makerFillProbability({ ...ethIncident, tfi: 1, qi1: .5 }, ethBook, -1,
    "PULLBACK_RECOVERY");

  assert.ok(sameSideBuyFlow < .95, `same-side buy flow must not imply a certain maker fill: ${sameSideBuyFlow}`);
  assert.ok(contraSellFlow > sameSideBuyFlow);
  assert.ok(Math.abs(contraSellFlow - mirroredContraBuyFlow) < 1e-12);
});

test("maker fill probability is bounded by the adverse-flow cancellation policy", () => {
  const execution = planner(0, -3);
  const singleSensorAdverse = { ...features, tfi: -1, ofi: 1 };
  const pullbackProbability = execution.makerFillProbability(singleSensorAdverse, book, 1, "PULLBACK_RECOVERY");
  const continuationProbability = execution.makerFillProbability(singleSensorAdverse, book, 1, "CONTINUATION");
  assert.ok(Math.abs(pullbackProbability - competingFillProbability(Math.exp(-3), 2, 4)) < 1e-12);
  assert.ok(Math.abs(continuationProbability - competingFillProbability(Math.exp(-3), .1, 4)) < 1e-12);
  assert.ok(continuationProbability < pullbackProbability);

  const corroboratedAdverse = { ...features, tfi: -1, ofi: -3 };
  assert.equal(execution.makerFillProbability(corroboratedAdverse, book, 1, "PULLBACK_RECOVERY"), 0);
  assert.equal(execution.makerFillProbability({ ...corroboratedAdverse, tfi: 1, ofi: 3 }, book, -1,
    "PULLBACK_RECOVERY"), 0);
});

test("maker fill probability is denomination-invariant and does not saturate on a tiny base-asset queue", () => {
  const execution = directionalFillPlanner();
  const incident = { ...features, tfi: -.7491045205697658, qi1: .28, spreadBps: .1264358369736318 };
  const tinyBtcQueue = { ...book,
    bids: [{ px: 99.995, qty: .001 }, { px: 99.99, qty: .009 }],
    asks: [{ px: 100.005, qty: .001 }, { px: 100.01, qty: .009 }] };
  const scaledQueue = { ...tinyBtcQueue,
    bids: tinyBtcQueue.bids.map((level) => ({ ...level, qty: level.qty * 1_000 })),
    asks: tinyBtcQueue.asks.map((level) => ({ ...level, qty: level.qty * 1_000 })) };

  const tinyProbability = execution.makerFillProbability(incident, tinyBtcQueue, 1, "CONTINUATION");
  const scaledProbability = execution.makerFillProbability(incident, scaledQueue, 1, "CONTINUATION");
  assert.ok(tinyProbability > 0 && tinyProbability < .2, `unexpected policy-bounded probability: ${tinyProbability}`);
  assert.ok(Math.abs(tinyProbability - scaledProbability) < 1e-12);
});

test("a configured IOC buffer widens only the taker limit-price cap", () => {
  const execution = planner(5);
  const baseRisk = {
    equity: 100_000, equityHighWater: 100_000, initialStopDistance: 1, jumpBuffer: 0,
    maximumNotional: 1_000, lotSize: .001, regimeScale: 1, exposureCapacityQty: 10,
  };
  const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  const taker = execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "TAKER_TAKER" });
  const maker = execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_TAKER" });
  assert.equal(taker?.limitPx, 100.056);
  assert.equal(maker?.limitPx, 99.995);
});

test("the IOC buffer is symmetric for a sell exit", () => {
  assert.equal(bufferedTakerLimitPrice(100, .001, -1, 5), 99.95);
});

function competingFillProbability(fillHazardPerSecond: number, ttlSeconds: number, alphaHalfLifeSeconds: number): number {
  const cancellationHazardPerSecond = Math.log(2) / alphaHalfLifeSeconds;
  const totalHazardPerSecond = fillHazardPerSecond + cancellationHazardPerSecond;
  return fillHazardPerSecond / totalHazardPerSecond * (1 - Math.exp(-totalHazardPerSecond * ttlSeconds));
}
