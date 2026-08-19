import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DETERMINISTIC_SIGNAL_CONFIG } from "../src/config/deterministic-defaults.js";
import { DeterministicEdgeResolver } from "../src/strategy/deterministic-edge-resolver.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";

const features: DeterministicFeatures = {
  symbol: "BTC/USD", mid: 100, spread: .01, spreadBps: 1, microprice: 100.003, visibleDepth: 1_000,
  qi1: .4, qiK: .35, persistentQiK: .3, ofi: 1, tfi: .6,
  bidCancellationRatio: .1, askCancellationRatio: .5, replenishmentPressure: .5,
  velocity: .00002, acceleration: 0, varianceRate: 4e-8, sigmaHBps: 1,
  microEdgeZ: 1, velocityZ: 1, accelerationZ: 0, efficiency: .9,
  cusumUp: true, cusumDown: false, spreadZ: 0, depthZ: 1, signalFlipRate: .05,
  providerAgeMs: 20, staleThresholdMs: 2_000, warmedUp: true, stale: false, receiveTsMs: 1_000,
  microEdgeBps: .3, impulseBps: 1, breakoutUpBps: .8, breakoutDownBps: 0, anchorDistanceBps: 1.2,
  sigmaImpulseBps: 1, cusumUpScore: 4, cusumDownScore: 0, flowFlipRate: .05,
  usableDepthQty: 100, usableDepthNotional: 1_000_000,
};

test("missing calibrated edge falls back to a finite deterministic analytical estimate", () => {
  const resolver = new DeterministicEdgeResolver(
    "CALIBRATED_OR_ANALYTIC",
    DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge,
    { resolve: () => null },
  );
  const edge = resolver.resolve({ side: 1, score: .7, scoreReset: .1, persistence: .8, evidence: .08, features });
  assert.equal(edge?.source, "ANALYTIC");
  assert.ok(edge && edge.grossOpportunityBps > edge.uncertaintyBps);
  assert.ok(edge && Number.isFinite(edge.grossOpportunityBps) && Number.isFinite(edge.uncertaintyBps));
});

test("calibration-required mode still fails closed when calibration is unavailable", () => {
  const resolver = new DeterministicEdgeResolver(
    "CALIBRATED_REQUIRED",
    DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge,
    { resolve: () => null },
  );
  assert.equal(resolver.resolve({ side: 1, score: .7, scoreReset: .1, persistence: .8, evidence: .08, features }), null);
});
