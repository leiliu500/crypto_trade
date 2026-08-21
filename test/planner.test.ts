import assert from "node:assert/strict";
import test from "node:test";
import type { BookState, Features } from "../src/core/market.js";
import { ExecutionPlanner } from "../src/execution/planner.js";
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

function planner(takerLimitBufferBps = 0): ExecutionPlanner {
  return new ExecutionPlanner({
    makerTtlMs: 1_500, alphaHalfLifeMs: 4_000, minimumFillProbability: .65, takerLimitBufferBps, cancelAheadFraction: .5,
    fillHazardIntercept: 5, fillHazardAggressiveWeight: 0, fillHazardFlowWeight: 0,
    fillHazardImbalanceWeight: 0, fillHazardSpreadWeight: 0,
    makerOpportunityCostBps: 0, staleOrderCostBps: 0, maximumImpactBps: 10, maximumIterations: 5,
  }, new RiskSizer({
    baseRiskFraction: .001, maximumDrawdown: .05, maximumBookParticipation: .1,
    fractionalKelly: .1, maximumKellyFraction: .05, targetSigmaHBps: 20, minimumQualityScale: .1,
  }), new CostModel({
    makerFeeBps: 0, takerFeeBps: 4, expectedExitTaker: true, latencyAdverseFraction: 0,
    adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0,
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
  assert.equal(execution.build(intent, features, book, asset, baseRisk, false,
    { createdMs: 1_000, executionPath: "MAKER_MAKER" }), null);
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
