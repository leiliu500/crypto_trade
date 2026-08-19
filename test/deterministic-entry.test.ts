import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DETERMINISTIC_SIGNAL_CONFIG } from "../src/config/deterministic-defaults.js";
import { loadConfig } from "../src/config.js";
import { DeterministicEntryEngine, type EntryContext } from "../src/strategy/deterministic-entry.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import { DeterministicFeatureExtensions } from "../src/strategy/deterministic-features.js";
import { DeterministicRegimeEngine } from "../src/strategy/deterministic-regime.js";
import { DeterministicHoldEngine } from "../src/strategy/deterministic-hold.js";
import { DEFAULT_DETERMINISTIC_HOLD_CONFIG, DEFAULT_DETERMINISTIC_REGIME_CONFIG, DEFAULT_EXTENSION_CONFIG } from "../src/config/deterministic-defaults.js";
import { SignalRouter } from "../src/strategy/signal-router.js";

const cost = (roundTripBps = .2) => ({
  roundTripBps, spreadBps: .1, feeBps: .05, impactBps: .02, latencyBps: .01,
  adverseSelectionBps: .01, fundingBps: 0, borrowBps: 0,
});

function alignedFeatures(side: 1 | -1 = 1, nowMs = 1_000): DeterministicFeatures {
  const mid = 100.005;
  return {
    symbol: "BTC/USD", mid, spread: .01, spreadBps: 1,
    microprice: mid * Math.exp(side * .3 / 10_000), visibleDepth: 1_000,
    qi1: side * .4, qiK: side * .35, persistentQiK: side * .3,
    ofi: side, tfi: side * .6, bidCancellationRatio: side === 1 ? .1 : .5,
    askCancellationRatio: side === 1 ? .5 : .1, replenishmentPressure: side * .5,
    velocity: side * .00002, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: side, velocityZ: side, accelerationZ: 0, efficiency: .9,
    cusumUp: side === 1, cusumDown: side === -1, spreadZ: 0, depthZ: 1, signalFlipRate: .05,
    providerAgeMs: 20, staleThresholdMs: 500, warmedUp: true, stale: false, receiveTsMs: nowMs,
    microEdgeBps: side * .3, impulseBps: side, breakoutUpBps: side === 1 ? .8 : 0,
    breakoutDownBps: side === -1 ? .8 : 0, anchorDistanceBps: side * 1.2,
    sigmaImpulseBps: 1, cusumUpScore: side === 1 ? 4 : 0, cusumDownScore: side === -1 ? -4 : 0,
    flowFlipRate: .05, usableDepthQty: 100, usableDepthNotional: 1_000_000,
  };
}

function context(side: 1 | -1 = 1, nowMs = 1_000): EntryContext {
  return {
    symbol: "BTC/USD", sequence: BigInt(nowMs), nowMs, bestBid: 100, bestAsk: 100.01,
    expectedLatencyMs: 100, features: alignedFeatures(side, nowMs),
    regime: side === 1
      ? { name: "TREND_UP", allowLong: true, allowShort: false, riskScale: 1 }
      : { name: "TREND_DOWN", allowLong: false, allowShort: true, riskScale: 1 },
    system: {
      bookValid: true, sequenceValid: true, checksumValid: true, publicStreamHealthy: true,
      privateStreamHealthy: true, accountReconciled: true, clockHealthy: true, entriesAllowed: true,
      noExistingPosition: true, noPendingEntry: true,
    },
    longCost: cost(), shortCost: cost(),
  };
}

const testConfig = () => ({ ...DEFAULT_DETERMINISTIC_SIGNAL_CONFIG, minimumNetEdgeBps: -10 });

function persistentIntent(engine: DeterministicEntryEngine, side: 1 | -1 = 1, startMs = 1_000) {
  let intent = null;
  for (let index = 0; index < 8; index += 1) intent = engine.evaluate(context(side, startMs + index * 50));
  return intent;
}

test("deterministic-only construction and config loading require no model", () => {
  assert.ok(new DeterministicEntryEngine({ ...testConfig(), mode: "DETERMINISTIC_ONLY" }));
  const cfg = loadConfig({ TRADING_MODE: "replay", DATABASE_ENABLED: "false", DASHBOARD_ENABLED: "false" });
  assert.equal(cfg.signalMode, "DETERMINISTIC_ONLY");
  assert.equal(cfg.modelVersion, "none");
  assert.equal(loadConfig({ TRADING_MODE: "replay", SIGNAL_MODE: "DETERMINISTIC_WITH_MODEL_VETO" }).signalMode, "DETERMINISTIC_ONLY");
});

test("stale, unwarmed, and unhealthy data always block entry", () => {
  for (const mutate of [
    (value: EntryContext) => { value.features.stale = true; },
    (value: EntryContext) => { value.features.warmedUp = false; },
    (value: EntryContext) => { value.system.accountReconciled = false; },
  ]) {
    const engine = new DeterministicEntryEngine(testConfig());
    let result = null;
    for (let index = 0; index < 8; index += 1) { const value = context(1, 1_000 + index * 50); mutate(value); result = engine.evaluate(value); }
    assert.equal(result, null);
  }
});

test("one event cannot bypass event-time persistence; aligned long and short inputs are symmetric", () => {
  const longEngine = new DeterministicEntryEngine(testConfig());
  assert.equal(longEngine.evaluate(context()), null);
  assert.equal(persistentIntent(longEngine)?.side, 1);
  assert.equal(persistentIntent(new DeterministicEntryEngine(testConfig()), -1)?.side, -1);
});

test("independent evidence groups cannot be replaced by a high aggregate score", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 8; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.ofi = 0; value.features.tfi = 0; value.features.replenishmentPressure = 0;
    result = engine.evaluate(value);
  }
  assert.equal(result, null);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.ok(diagnostics.score >= testConfig().scoreEnter);
  assert.equal(diagnostics.votes.flow, 0);
  assert.ok(diagnostics.reasons.includes("RULE_QUORUM"));
});

test("anti-chasing rejects overextended signals", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 8; index += 1) {
    const value = context(1, 1_000 + index * 50); value.features.anchorDistanceBps = 20;
    result = engine.evaluate(value);
  }
  assert.equal(result, null);
  assert.ok(engine.latestEvaluation()!.long.reasons.includes("ANTI_CHASE_GATE"));
});

test("exact quantity cost is inclusive at the threshold and rejects one increment above it", () => {
  const cfg = testConfig();
  const engine = new DeterministicEntryEngine(cfg);
  const intent = persistentIntent(engine)!;
  assert.ok(intent);
  const thresholdCost = (intent.grossOpportunityBps - intent.uncertaintyReserveBps - cfg.minimumNetEdgeBps) / cfg.costSafetyFactor;
  assert.ok(engine.revalidateExactCost(intent, cost(thresholdCost)));
  assert.equal(engine.revalidateExactCost(intent, cost(thresholdCost + 1e-9)), null);
});

test("a continuous signal fires once and needs both cooldown and reset before re-arming", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  const first = persistentIntent(engine)!;
  engine.markFired(first.side, first.createdMs);
  assert.equal(persistentIntent(engine, 1, first.createdMs + 100), null);
  for (const at of [first.createdMs + 3_100, first.createdMs + 3_400]) {
    const reset = context(1, at);
    reset.regime = { name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 };
    assert.equal(engine.evaluate(reset), null);
  }
  assert.equal(persistentIntent(engine, 1, first.createdMs + 3_700)?.side, 1);
});

test("directional persistence survives a liquidity block and becomes executable without re-confirming", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  const blockedLiquidity = {
    pass: false, stress: false, sampleCount: 50, medianSpreadBps: 1,
    tradeThresholdBps: .5, stressThresholdBps: 2,
    reasons: ["SPREAD_ABOVE_DYNAMIC_TRADE_THRESHOLD"],
  } as const;
  for (let index = 0; index < 8; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.longLiquidity = blockedLiquidity;
    value.shortLiquidity = blockedLiquidity;
    assert.equal(engine.evaluate(value), null);
  }
  const blocked = engine.latestEvaluation()!;
  assert.equal(blocked.candidate?.side, 1);
  assert.equal(blocked.long.rawDirectionalPass, true);
  assert.equal(blocked.long.candidatePass, true);
  assert.equal(blocked.long.liquidityPass, false);

  const released = context(1, 1_400);
  const passingLiquidity = { ...blockedLiquidity, pass: true, reasons: [] } as const;
  released.longLiquidity = passingLiquidity;
  released.shortLiquidity = passingLiquidity;
  assert.equal(engine.evaluate(released)?.side, 1);
});

test("direction conflict and a null deterministic signal always produce no trade", () => {
  const cfg = { ...testConfig(), minimumBookVotes: 1, minimumFlowVotes: 1, minimumKinematicVotes: 1, scoreEnter: -.5, scoreReset: -.8 };
  const engine = new DeterministicEntryEngine(cfg);
  let intent = null;
  for (let index = 0; index < 8; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.regime = { name: "UNKNOWN", allowLong: true, allowShort: true, riskScale: 1 };
    value.features.microEdgeBps = .3; value.features.qi1 = -.4; value.features.qiK = 0;
    value.features.ofi = .4; value.features.tfi = -.4; value.features.replenishmentPressure = 0;
    value.features.velocityZ = 0; value.features.velocity = 0; value.features.impulseBps = 0;
    value.features.breakoutUpBps = 1; value.features.breakoutDownBps = 1;
    value.features.cusumUpScore = 4; value.features.cusumDownScore = -4;
    intent = engine.evaluate(value);
  }
  assert.equal(intent, null);
  const router = new SignalRouter("DETERMINISTIC_WITH_MODEL_VETO", { evaluate: () => ({ accept: true, rankingScore: 1, sizeMultiplier: 1, modelVersion: "test" }) });
  assert.equal(router.route(null, alignedFeatures()), null);
});

test("optional models can veto or reduce but cannot create or enlarge deterministic exposure", () => {
  const intent = persistentIntent(new DeterministicEntryEngine(testConfig()))!;
  const veto = new SignalRouter("DETERMINISTIC_WITH_MODEL_VETO", { evaluate: () => ({ accept: false, rankingScore: 1, sizeMultiplier: 1, modelVersion: "test" }) });
  assert.equal(veto.route(intent, alignedFeatures()), null);
  const oversized = new SignalRouter("DETERMINISTIC_WITH_MODEL_RANKING", { evaluate: () => ({ accept: true, rankingScore: 1, sizeMultiplier: 4, modelVersion: "test" }) });
  assert.equal(oversized.route(intent, alignedFeatures())!.sizeMultiplier, 1);
});

test("identical causal event streams replay to identical decisions", () => {
  const run = () => {
    const engine = new DeterministicEntryEngine(testConfig());
    return Array.from({ length: 8 }, (_, index) => engine.evaluate(context(1, 1_000 + index * 50)));
  };
  assert.deepEqual(run(), run());
});

test("regime and hold engines are deterministic, symmetric, and fail closed under liquidity stress", () => {
  const regimes = new DeterministicRegimeEngine(DEFAULT_DETERMINISTIC_REGIME_CONFIG);
  assert.equal(regimes.classify(alignedFeatures(1)).name, "BREAKOUT_UP");
  const stressed = alignedFeatures(1); stressed.providerAgeMs = 10_000;
  const gated = regimes.classify(stressed);
  assert.deepEqual([gated.allowLong, gated.allowShort, gated.riskScale], [false, false, 0]);

  const hold = new DeterministicHoldEngine(DEFAULT_DETERMINISTIC_HOLD_CONFIG);
  assert.equal(hold.evaluate(1, alignedFeatures(1), 0).exitEvidence, false);
  const reversal = hold.evaluate(1, alignedFeatures(-1), 0);
  assert.equal(reversal.exitEvidence, true);
  assert.ok(reversal.reversalVotes >= DEFAULT_DETERMINISTIC_HOLD_CONFIG.reversalVoteThreshold);
});

test("deterministic feature windows use only prior and current events", () => {
  const run = () => {
    const extension = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG);
    return [100, 100.001, 100.01].map((mid, index) => {
      const base = alignedFeatures(1, 1_000 + index * 1_000);
      base.mid = mid; base.microprice = mid; base.spread = .01; base.spreadBps = .01 / mid * 10_000;
      return extension.update(base, { providerAgeMs: 5, usableDepthQty: 100, usableDepthNotional: 1_000_000,
        replenishmentPressure: .2, bidAdditionQty: 1, askAdditionQty: 0, bidRemovalQty: 0, askRemovalQty: 0 });
    });
  };
  const first = run(), second = run();
  assert.deepEqual(first, second);
  assert.equal(first[0]!.breakoutUpBps, 0);
  assert.ok(first[2]!.breakoutUpBps > 0);
});

test("deterministic extensions preserve the clock-adjusted provider age", () => {
  const extension = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG);
  const base = alignedFeatures(1);
  base.providerAgeMs = 0;
  const result = extension.update(base, {
    providerAgeMs: -24, usableDepthQty: 100, usableDepthNotional: 1_000_000,
    replenishmentPressure: 0, bidAdditionQty: 0, askAdditionQty: 0, bidRemovalQty: 0, askRemovalQty: 0,
  });
  assert.equal(result.providerAgeMs, 0);
});
