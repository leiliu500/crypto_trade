import assert from "node:assert/strict";
import test from "node:test";
import type { Features } from "../src/core/market.js";
import { HybridEntryRouter, type HybridEntryConfig } from "../src/execution/hybrid-entry-router.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { LiquidityDecision } from "../src/strategy/dynamic-liquidity.js";

const config: HybridEntryConfig = {
  allowAnalyticPaperExecution: false,
  continuationTakerEnabled: true, continuationTakerSizeMultiplier: .25,
  continuationTakerMinimumScore: .3, continuationTakerMinimumNetEdgeBps: 8,
  continuationTakerMinimumExpectedValueBps: 1, continuationTakerMinimumOfi: .5,
  continuationTakerMinimumTfi: .2, continuationTakerMinimumQiK: .15,
  continuationTakerMaximumLatencyHalfLifeFraction: .25, continuationTakerMinimumLatencySamples: 20,
  routeShadowEnabled: true, routeShadowHorizonsMs: [1_000, 5_000, 30_000],
};

const features: Features = {
  symbol: "BTC/USD", mid: 100, spread: .01, spreadBps: 1, microprice: 100.005, visibleDepth: 100,
  qi1: .5, qiK: .4, persistentQiK: .4, ofi: .8, tfi: .5,
  bidCancellationRatio: .1, askCancellationRatio: .5, replenishmentPressure: .4,
  velocity: .001, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
  microEdgeZ: 1, velocityZ: 1, accelerationZ: 0, efficiency: .8,
  cusumUp: true, cusumDown: false, spreadZ: 0, depthZ: 1, signalFlipRate: .05,
  providerAgeMs: 10, staleThresholdMs: 500, warmedUp: true, kinematicsReady: true,
  stale: false, staleReason: null, receiveTsMs: 1_000,
};

const liquidity: LiquidityDecision = {
  pass: true, stress: false, sampleCount: 100, medianSpreadBps: 1,
  tradeThresholdBps: 2, stressThresholdBps: 4, reasons: [],
};

const calibratedEvidence = {
  regimePass: true, edgeSource: "CALIBRATED" as const,
  edgeEffectiveSampleCount: 100, minimumEffectiveSampleCount: 100,
};

test("strong aligned continuation chooses the higher conservative-EV bounded taker", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, ...calibratedEvidence, signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.takerEligible, true);
  assert.equal(decision.selectedStyle, "taker");
  assert.equal(decision.selectedPlan?.qty, .25);
  assert.deepEqual(decision.reasons, []);
});

test("weak flow or stale execution latency falls back to maker without forcing a trade", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, ...calibratedEvidence, signalScore: .7,
    features: { ...features, ofi: .1 }, liquidity,
    latencySamples: 50, latencyP95Ms: 1_100, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.takerEligible, false);
  assert.equal(decision.selectedStyle, "maker");
  assert.ok(decision.reasons.includes("TAKER_OFI_NOT_ALIGNED"));
  assert.ok(decision.reasons.includes("TAKER_LATENCY_ABOVE_ALPHA_BUDGET"));
});

test("pullback/recovery remains maker-only even when a taker plan has greater EV", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "PULLBACK_RECOVERY", side: 1, ...calibratedEvidence, signalScore: .8, features, liquidity,
    latencySamples: 50, latencyP95Ms: 100, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 20, 30),
  });
  assert.equal(decision.takerEligible, false);
  assert.equal(decision.selectedStyle, "maker");
  assert.ok(decision.reasons.includes("PULLBACK_MAKER_ONLY"));
});

test("non-finite urgency evidence fails closed to the valid maker route", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, ...calibratedEvidence, signalScore: Number.NaN,
    features: { ...features, ofi: Number.NaN }, liquidity,
    latencySamples: 50, latencyP95Ms: Number.NaN, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 20, 30),
  });
  assert.equal(decision.takerEligible, false);
  assert.equal(decision.selectedStyle, "maker");
  assert.ok(decision.reasons.includes("TAKER_SCORE_BELOW_MINIMUM"));
  assert.ok(decision.reasons.includes("TAKER_OFI_NOT_ALIGNED"));
  assert.ok(decision.reasons.includes("TAKER_LATENCY_ABOVE_ALPHA_BUDGET"));
});

test("uncalibrated continuations remain shadow-only even when regime and both execution routes pass", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, regimePass: true, edgeSource: "ANALYTIC",
    edgeEffectiveSampleCount: 0, minimumEffectiveSampleCount: 100,
    signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.executionEvidencePass, false);
  assert.equal(decision.takerEligible, false);
  assert.equal(decision.selectedPlan, null);
  assert.equal(decision.selectedStyle, null);
  assert.ok(decision.reasons.includes("UNCALIBRATED_CONTINUATION"));
});

test("normal paper mode can execute an analytical continuation through the same route gates", () => {
  const decision = new HybridEntryRouter({ ...config, allowAnalyticPaperExecution: true }).select({
    family: "CONTINUATION", side: 1, regimePass: true, edgeSource: "ANALYTIC",
    edgeEffectiveSampleCount: 0, minimumEffectiveSampleCount: 100,
    signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.executionEvidencePass, true);
  assert.equal(decision.takerEligible, true);
  assert.equal(decision.selectedStyle, "taker");
  assert.ok(!decision.reasons.includes("UNCALIBRATED_CONTINUATION"));
});

test("paper permission cannot turn an unresolved continuation into an execution route", () => {
  const decision = new HybridEntryRouter({ ...config, allowAnalyticPaperExecution: true }).select({
    family: "CONTINUATION", side: 1, regimePass: true, edgeSource: "UNRESOLVED",
    edgeEffectiveSampleCount: 0, minimumEffectiveSampleCount: 100,
    signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.executionEvidencePass, false);
  assert.equal(decision.selectedPlan, null);
  assert.ok(decision.reasons.includes("UNCALIBRATED_CONTINUATION"));
});

test("a sufficiently sampled calibrated edge may authorize a neutral continuation", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, regimePass: false, edgeSource: "CALIBRATED",
    edgeEffectiveSampleCount: 100, minimumEffectiveSampleCount: 100,
    signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.executionEvidencePass, true);
  assert.equal(decision.takerEligible, true);
  assert.equal(decision.selectedStyle, "taker");
  assert.ok(!decision.reasons.includes("UNCALIBRATED_CONTINUATION"));
});

test("an undersampled calibrated edge cannot authorize a neutral continuation", () => {
  const decision = new HybridEntryRouter(config).select({
    family: "CONTINUATION", side: 1, regimePass: false, edgeSource: "CALIBRATED",
    edgeEffectiveSampleCount: 99, minimumEffectiveSampleCount: 100,
    signalScore: .7, features, liquidity,
    latencySamples: 50, latencyP95Ms: 400, alphaHalfLifeMs: 4_000,
    makerPlan: plan("maker", 2, 12), takerPlan: plan("taker", 9, 14),
  });
  assert.equal(decision.executionEvidencePass, false);
  assert.equal(decision.selectedPlan, null);
  assert.ok(decision.reasons.includes("UNCALIBRATED_CONTINUATION"));
});

function plan(style: "maker" | "taker", conservativeExpectedValueBps: number,
  conservativeNetEdgeBps: number): ExecutionPlan {
  const qty = style === "maker" ? 1 : .25;
  return {
    clientOrderId: `${style}-order`, decisionId: "decision", riskApprovalId: `${style}-risk`, symbol: "BTC/USD",
    side: 1, qty, limitPx: style === "maker" ? 99 : 101, style, timeInForce: style === "maker" ? "gtc" : "ioc",
    createdMs: 1_000, expiresMs: 2_500, originatingSequence: 1n, featureHash: "features",
    strategyVersion: "test", modelVersion: "none",
    expectedCost: { roundTripBps: 10, spreadBps: 1, feeBps: 8, impactBps: 1,
      latencyBps: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0,
      ...(style === "taker" ? { entryVwap: 101, worstEntryPx: 101 } : {}) },
    risk: { qty, riskBudget: 100, maximumLossPerUnit: 1, modeledMaximumLoss: qty,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "notional" },
    fillProbability: style === "maker" ? .4 : 1,
    conservativeNetEdgeBps, conservativeExpectedValueBps,
    rewardRiskRatio: 1, expectedValue: qty * 100 * conservativeExpectedValueBps / 10_000,
    reduceOnlyIntent: false, entryFamily: "CONTINUATION",
    executionPath: style === "maker" ? "MAKER_TAKER" : "TAKER_TAKER",
  };
}
