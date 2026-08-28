import assert from "node:assert/strict";
import test from "node:test";
import type { Features } from "../src/core/market.js";
import { ForecastEngine } from "../src/strategy/forecast.js";
import { SignalEngine } from "../src/strategy/signal.js";
import { entryRiskSigmaBps, RiskSizer } from "../src/risk/sizing.js";
import { PositionManager, type Position } from "../src/strategy/position-manager.js";
import { RiskState } from "../src/risk/risk-state.js";
import { incrementalHoldCostBps } from "../src/strategy/cost.js";

const features = (patch: Partial<Features> = {}): Features => ({
  symbol: "BTC/USD", mid: 100, spread: 1, spreadBps: 100, microprice: 100.5, visibleDepth: 10,
  qi1: .2, qiK: .2, persistentQiK: .2, ofi: .5, tfi: .3, bidCancellationRatio: .1, askCancellationRatio: .2, replenishmentPressure: .1,
  velocity: .001, acceleration: 0, varianceRate: 1e-6, sigmaHBps: 10, microEdgeZ: .5, velocityZ: .5, accelerationZ: 0,
  efficiency: .8, cusumUp: false, cusumDown: false, spreadZ: 0, depthZ: 0, signalFlipRate: 0,
  providerAgeMs: 10, staleThresholdMs: 100, warmedUp: true, kinematicsReady: true,
  stale: false, staleReason: null, receiveTsMs: 1_000,
  ...patch,
});

test("latency decay and 95% residual/cost lower bound gate entries", () => {
  const returnWeights = Array.from({ length: 15 }, () => 0);
  const probabilityWeights = Array.from({ length: 15 }, () => 0);
  const forecastEngine = new ForecastEngine({ intercept: 1, weights: probabilityWeights }, { intercept: 20, weights: returnWeights }, { alphaDecayTauMs: 1_000, intendedHoldMs: 2_000, residualWindowMs: 10_000, fallbackResidualQ95Bps: 2 });
  const forecast = forecastEngine.evaluate(features(), 100);
  assert.ok(forecast.grossAtArrivalBps < 20);
  const signal = new SignalEngine({ costSafetyFactor: 1.75, minimumDirectionProbability: .6, minimumNetEdgeBps: 1, fullQualityEdgeBps: 10 });
  const intent = signal.evaluate(features(), forecast, { roundTripBps: 4, spreadBps: 1, feeBps: 1, impactBps: 1, latencyBps: 1, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 }, true, false);
  assert.ok(intent);
  assert.ok(Math.abs(intent.lowerBoundNetBps - (forecast.grossAtArrivalBps - 2 - 7)) < 1e-10);
  assert.equal(signal.evaluate(features({ stale: true }), forecast, { roundTripBps: 0, spreadBps: 0, feeBps: 0, impactBps: 0, latencyBps: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 }, true, false), null);
});

test("risk sizing cannot exceed its modeled maximum-loss budget", () => {
  const sizer = new RiskSizer({ baseRiskFraction: .001, maximumDrawdown: .05, maximumBookParticipation: .1, fractionalKelly: .1, maximumKellyFraction: .05, targetSigmaHBps: 20, minimumQualityScale: .1 });
  const approval = sizer.size({ side: 1, probability: .7, predictedGrossBps: 20, lowerBoundNetBps: 10, quality: 1, decisionTsMs: 0 }, {
    equity: 100_000, equityHighWater: 100_000, price: 100, initialStopDistance: 1, estimatedExitCostBps: 10, jumpBuffer: .5,
    visibleLiquidityQty: 10_000, maximumNotional: 1_000_000, maximumExchangeQty: 1_000_000, lotSize: .001,
    sigmaHBps: 10, regimeScale: 1, exposureCapacityQty: 1_000_000,
  });
  assert.ok(approval);
  assert.ok(approval.modeledMaximumLoss <= approval.riskBudget + 1e-8);
});

test("entry risk volatility is capped at the unproductive-exit horizon", () => {
  const hourlyVarianceRate = Math.pow(120 / 10_000, 2) / 3_600;
  assert.ok(Math.abs(entryRiskSigmaBps(hourlyVarianceRate, 14_400_000, 900_000) - 60) < 1e-10);
  assert.ok(Math.abs(entryRiskSigmaBps(hourlyVarianceRate, 225_000, 900_000) - 30) < 1e-10);
  assert.throws(() => entryRiskSigmaBps(hourlyVarianceRate, 0, 900_000), /Invalid entry risk horizon inputs/);
});

test("incremental hold cost excludes unavoidable round-trip execution charges", () => {
  const incremental = incrementalHoldCostBps({
    roundTripBps: 60, spreadBps: 8, feeBps: 40, impactBps: 3, latencyBps: 2,
    adverseSelectionBps: 5, fundingBps: .25, borrowBps: .5,
  });
  assert.equal(incremental, 2.75);
});

test("profit floor never loosens and recovery arms break-even", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .5, minimumProgressR: .2, minimumHoldMs: 0, unproductiveExitMs: 5_000, maximumHoldMs: 10_000, reentryCooldownMs: 0, makerExitTtlMs: 30_000, evidenceConfirmationMs: 100, profitActivationCostMultiple: 1.25,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1, minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0, initialRiskPx: 2, roundTripCostPx: .2, mfePx: 0, maePx: 1.2, floorPx: -2, breakEvenArmed: false, phase: "OPEN" };
  manager.update(position, 100.3, 100, features({ sigmaHBps: 1 }), 2, .1);
  assert.equal(position.breakEvenArmed, true);
  assert.ok(position.floorPx >= .2);
  manager.update(position, 103, 200, features({ sigmaHBps: 1 }), 2, .1);
  const protectedFloor = position.floorPx;
  manager.update(position, 104, 300, features({ sigmaHBps: 100 }), 2, 0);
  assert.ok(position.floorPx >= protectedFloor);
});

test("a selected economic horizon bounds the position time stop", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .5, minimumProgressR: .2,
    minimumHoldMs: 0, unproductiveExitMs: 5_000, maximumHoldMs: 10_000, reentryCooldownMs: 0, makerExitTtlMs: 30_000, evidenceConfirmationMs: 100, profitActivationCostMultiple: 1.25,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1,
    minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0,
    initialRiskPx: 2, roundTripCostPx: .2, mfePx: 0, maePx: 0, floorPx: -2,
    breakEvenArmed: false, phase: "OPEN", selectedHorizonMs: 100 };
  const decision = manager.update(position, 100, 101, features({ sigmaHBps: 1 }), 1, 0);
  assert.deepEqual(decision, { action: "EXIT", reason: "TIME_STOP" });
});

test("profit protection waits for meaningful progress instead of clipping at one cost unit", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .75, minimumProgressR: .2,
    minimumHoldMs: 0, unproductiveExitMs: 5_000, maximumHoldMs: 10_000, reentryCooldownMs: 0, makerExitTtlMs: 30_000,
    evidenceConfirmationMs: 100, profitActivationCostMultiple: 1,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1,
    minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: 1, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "OPEN" };

  manager.update(position, 101.01, 100, features({ sigmaHBps: 1 }), 1, .1);
  assert.equal(position.breakEvenArmed, false);
  assert.equal(position.floorPx, -position.initialRiskPx);

  manager.update(position, 102.1, 200, features({ sigmaHBps: 1 }), 1, .1);
  assert.equal(position.breakEvenArmed, true);
  assert.ok(position.floorPx >= position.roundTripCostPx);
  assert.equal(manager.update(position, 107.6, 300, features({ sigmaHBps: 1 }), 1, .1).action, "HOLD");
  assert.equal(position.phase, "TREND_HOLD");
});

test("an unproductive position exits after fifteen minutes instead of waiting for its full horizon", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .75, minimumProgressR: .2,
    minimumHoldMs: 60_000, unproductiveExitMs: 900_000, maximumHoldMs: 14_400_000,
    reentryCooldownMs: 900_000, makerExitTtlMs: 30_000, evidenceConfirmationMs: 30_000,
    profitActivationCostMultiple: 1,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1,
    minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: 1, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "OPEN", selectedHorizonMs: 7_200_000 };

  assert.equal(manager.update(position, 100.5, 899_999, features({ sigmaHBps: 1 }), 1, .1).action, "HOLD");
  assert.deepEqual(manager.update(position, 100.5, 900_000, features({ sigmaHBps: 1 }), 1, .1),
    { action: "EXIT", reason: "UNPRODUCTIVE_TIME_STOP" });
});

test("hold-engine exit evidence is confirmed with OR semantics", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .75, minimumProgressR: .25,
    minimumHoldMs: 1_000, unproductiveExitMs: 10_000, maximumHoldMs: 20_000,
    reentryCooldownMs: 0, makerExitTtlMs: 5_000, evidenceConfirmationMs: 500,
    profitActivationCostMultiple: 2.5,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1,
    minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: 1, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "OPEN" };

  assert.equal(manager.update(position, 99.9, 1_000, features(), 1, 0, 0, true).action, "HOLD");
  assert.deepEqual(manager.update(position, 99.9, 1_500, features(), 1, 0, 0, true),
    { action: "EXIT", reason: "EVIDENCE_EXIT" });
});

test("a no-progress loss is capped at a fraction of initial risk after the minimum hold", () => {
  const manager = new PositionManager({ recoveryArmR: .5, trailActivationR: .75, minimumProgressR: .25,
    minimumHoldMs: 1_000, unproductiveExitMs: 10_000, maximumHoldMs: 20_000,
    reentryCooldownMs: 0, makerExitTtlMs: 5_000, evidenceConfirmationMs: 500,
    profitActivationCostMultiple: 2.5,
    lockMin: .2, lockMax: .8, lockMaturityRate: 1, lockReversalWeight: .3, lockTrendDiscount: .1,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1,
    minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .9, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 1 });
  const position: Position = { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: 1, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "OPEN" };

  assert.equal(manager.update(position, 97.5, 999, features(), 1, 0, 0, false).action, "HOLD");
  assert.deepEqual(manager.update(position, 97.5, 1_000, features(), 1, 0, 0, false),
    { action: "EXIT", reason: "EARLY_ADVERSE_STOP" });
});

test("halt resume clears operational failures only after reconciliation, never drawdown", () => {
  const risk = new RiskState(.01, .01, .05);
  risk.setHealth({ publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, clockValid: true, riskRecomputed: true });
  risk.halt("PUBLIC_STREAM_DOWN");
  assert.equal(risk.resumeAfterReconciliation(), false);
  risk.setHealth({ riskRecomputed: true });
  assert.equal(risk.resumeAfterReconciliation(), true);
  risk.updateEquity(100); risk.updateEquity(90);
  risk.setHealth({ riskRecomputed: true });
  assert.equal(risk.resumeAfterReconciliation(), false);
  assert.ok(risk.reasons().includes("DRAWDOWN"));
});
