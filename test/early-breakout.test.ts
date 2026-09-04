import assert from "node:assert/strict";
import test from "node:test";
import type { Features } from "../src/core/market.js";
import { earlyBreakoutPass, type EarlyBreakoutConfig } from "../src/strategy/early-breakout.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";

const cfg: EarlyBreakoutConfig = {
  enabled: true,
  minimumFastTrendBps: 1,
  maximumOpposingMediumTrendBps: 10,
  maximumOpposingSlowTrendBps: 15,
  maximumOpposingSlowTrendAlignment: .25,
  minimumBreakoutBps: .05,
  minimumVelocityZ: .25,
  maximumFlowFlipRate: .35,
};

const base: Features = {
  symbol: "BTC/USD", mid: 100, spread: .01, spreadBps: 1, microprice: 100.005, visibleDepth: 100,
  qi1: .5, qiK: .4, persistentQiK: .4, ofi: .8, tfi: .5,
  bidCancellationRatio: .1, askCancellationRatio: .5, replenishmentPressure: .4,
  velocity: .001, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
  microEdgeZ: 1, velocityZ: 1, accelerationZ: 0, efficiency: .8,
  cusumUp: true, cusumDown: false, spreadZ: 0, depthZ: 1, signalFlipRate: .05,
  providerAgeMs: 10, staleThresholdMs: 500, warmedUp: true, kinematicsReady: true,
  stale: false, staleReason: null, receiveTsMs: 1_000,
};

function breakout(patch: Partial<DeterministicFeatures> = {}): DeterministicFeatures {
  return {
    ...base,
    microEdgeBps: 1, impulseBps: .2, breakoutUpBps: .1, breakoutDownBps: 0,
    anchorDistanceBps: 0, sigmaImpulseBps: .1, cusumUpScore: 3, cusumDownScore: 0,
    flowFlipRate: .1, usableDepthQty: 100, usableDepthNotional: 10_000,
    slowTrendReady: true, trendFastBps: 2, trendMediumBps: -5, trendSlowBps: 12,
    slowTrendAlignment: .2, slowTrendEfficiency: .1, slowVarianceRate: 1e-8, slowSigmaBps: 5,
    longPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0,
      remainingRoomBps: 0, structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 },
    shortPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0,
      remainingRoomBps: 0, structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 },
    ...patch,
  };
}

test("early breakout accepts fresh motion before medium trend fully aligns", () => {
  assert.equal(earlyBreakoutPass(1, breakout(), cfg), true);
});

test("early breakout stays gated without recent price displacement or with excessive countertrend", () => {
  assert.equal(earlyBreakoutPass(1, breakout({ breakoutUpBps: 0, impulseBps: 0 }), cfg), false);
  assert.equal(earlyBreakoutPass(1, breakout({ trendMediumBps: -10.01 }), cfg), false);
  assert.equal(earlyBreakoutPass(1, breakout({ flowFlipRate: .36 }), cfg), false);
});

test("early breakout retains a causal impulse while the micro trigger confirms", () => {
  assert.equal(earlyBreakoutPass(1, breakout({ breakoutUpBps: 0, impulseBps: .2 }), cfg), true);
});

test("early breakout is directionally symmetric", () => {
  const short = breakout({
    velocityZ: -1, impulseBps: -.2, breakoutUpBps: 0, breakoutDownBps: .1,
    trendFastBps: -2, trendMediumBps: 5, trendSlowBps: -12, slowTrendAlignment: -.2,
  });
  assert.equal(earlyBreakoutPass(-1, short, cfg), true);
});
