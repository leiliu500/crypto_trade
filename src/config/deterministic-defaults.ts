import type { DeterministicSignalConfig } from "../strategy/deterministic-entry.js";
import type { ExtensionConfig } from "../strategy/deterministic-features.js";
import type { DeterministicHoldConfig } from "../strategy/deterministic-hold.js";
import type { DeterministicRegimeConfig } from "../strategy/deterministic-regime.js";

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  impulseWindowMs: 500, breakoutWindowMs: 2_000, anchorWindowMs: 5_000, flipWindowMs: 2_000,
  maximumStoredWindowMs: 10_000, cusumDrift: .15, cusumCap: 12, alignmentDeadband: .2,
};
export const DEFAULT_DETERMINISTIC_REGIME_CONFIG: DeterministicRegimeConfig = {
  trendEfficiency: .6, chopEfficiency: .35, maximumTrendFlipRate: .3, chopFlipRate: .55,
  regimeMicroEdgeBps: .15, regimeQiK: .1, regimeOfi: .25, regimeTfi: .12, regimeVelocityZ: .2, maximumOpposingAccelerationZ: .35,
  breakoutBps: .5, breakoutCusum: 2.5, breakoutOfi: .35, breakoutTfi: .18, neutralOfi: .08, neutralTfi: .05,
  hysteresisResetRatio: .75,
};
export const DEFAULT_DETERMINISTIC_SIGNAL_CONFIG: DeterministicSignalConfig = {
  mode: "DETERMINISTIC_ONLY", configurationVersion: "deterministic-v1",
  maximumSpreadBps: 30, maximumSpreadZ: 3, minimumDepthZ: -2.5, maximumImpactBps: 1.5,
  microEdgeBps: .2, qi1: .15, qiK: .1, ofi: .3, tfi: .15, replenishment: .1, velocityZ: .25,
  maximumOpposingAccelerationZ: .3, impulseBps: .4, breakoutBps: .5, cusum: 2.5, efficiency: .45, maximumFlipRate: .45,
  minimumBookVotes: 1, minimumFlowVotes: 1, minimumKinematicVotes: 1,
  scoreEnter: .30, scoreReset: .10, arbitrationMargin: .08,
  scoreWeights: { micro: 1, qi1: 1, qiK: 1, ofi: 1.25, tfi: 1.25, replenishment: .5, velocity: 1, acceleration: .5, impulse: .75, cusum: .75, efficiency: .75, flipQuality: .75 },
  persistenceWindowMs: 250, minimumPersistence: .60, minimumConfirmationMs: 75, minimumConfirmationEvents: 3,
  cooldownMs: 3_000, resetMs: 250,
  maximumImpulseZ: 2.5, maximumChaseBps: 1.5, maximumAnchorZ: 3,
  costSafetyFactor: 1.75, minimumNetEdgeBps: .5, fullQualityEdgeBps: 3,
  edgeSourceMode: "CALIBRATED_OR_ANALYTIC",
  analyticEdge: {
    economicHorizonMs: 30 * 60_000,
    qiKScale: .20, ofiScale: .50, tfiScale: .25, velocityScale: .50,
    microEdgeScaleBps: .50, breakoutScaleBps: 5,
    sigmaCaptureFraction: .65, breakoutWeight: .25, maximumGrossBps: 300,
    baseUncertaintyBps: 2, sigmaUncertaintyFraction: .20,
    spreadUncertaintyWeight: .50, flipUncertaintyWeight: .20,
  },
};
export const DEFAULT_DETERMINISTIC_HOLD_CONFIG: DeterministicHoldConfig = {
  holdHorizonMs: 1_000, kinematicSigmaCap: 1.5, flowSigmaScale: .75, totalSigmaCap: 2,
  minimumContinuationScore: .05, reversalVoteThreshold: 3,
  opposingAccelerationZ: .5, opposingOfi: .3, opposingTfi: .15, opposingReplenishment: .1, opposingCusum: 2.5,
  uncertaintySpreadPenaltyBps: .2, uncertaintyFlipPenaltyBps: .5, minimumHoldEdgeBps: 0,
};
