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
    providerAgeMs: 20, staleThresholdMs: 500, warmedUp: true, kinematicsReady: true,
    stale: false, staleReason: null, receiveTsMs: nowMs,
    microEdgeBps: side * .3, impulseBps: side, breakoutUpBps: side === 1 ? .8 : 0,
    breakoutDownBps: side === -1 ? .8 : 0, anchorDistanceBps: side * 1.2,
    sigmaImpulseBps: 1, cusumUpScore: side === 1 ? 4 : 0, cusumDownScore: side === -1 ? -4 : 0,
    flowFlipRate: .05, usableDepthQty: 100, usableDepthNotional: 1_000_000,
  };
}

function context(side: 1 | -1 = 1, nowMs = 1_000): EntryContext {
  return {
    symbol: "BTC/USD", sequence: BigInt(nowMs), nowMs, bestBid: 100, bestAsk: 100.01,
    features: alignedFeatures(side, nowMs),
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
  for (let index = 0; index < 20; index += 1) {
    const current = engine.evaluate(context(side, startMs + index * 50));
    if (current) { intent = current; break; }
  }
  return intent;
}

function neutralContext(nowMs: number): EntryContext {
  const value = context(1, nowMs);
  value.features.microprice = value.features.mid;
  value.features.microEdgeBps = 0; value.features.qi1 = 0; value.features.qiK = 0;
  value.features.ofi = 0; value.features.tfi = 0; value.features.replenishmentPressure = 0;
  value.features.velocity = 0; value.features.velocityZ = 0; value.features.accelerationZ = 0;
  value.features.impulseBps = 0; value.features.breakoutUpBps = 0; value.features.breakoutDownBps = 0;
  value.features.cusumUpScore = 0; value.features.cusumDownScore = 0;
  value.features.efficiency = 0; value.features.flowFlipRate = 1;
  return value;
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

test("account health blocks execution without suppressing directional candidates", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let intent = null;
  let candidateSide: 1 | -1 | undefined;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.system.accountReconciled = false;
    intent = engine.evaluate(value);
    candidateSide ??= engine.latestEvaluation()?.candidate?.side;
  }
  assert.equal(intent, null);
  assert.equal(candidateSide, 1);
  assert.equal(engine.latestEvaluation()!.long.healthPass, false);
});

test("one event cannot bypass event-time persistence; aligned long and short inputs are symmetric", () => {
  const longEngine = new DeterministicEntryEngine(testConfig());
  assert.equal(longEngine.evaluate(context()), null);
  assert.equal(persistentIntent(longEngine)?.side, 1);
  assert.equal(persistentIntent(new DeterministicEntryEngine(testConfig()), -1)?.side, -1);
});

test("independent group quorum tolerates one unavailable evidence group", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.ofi = 0; value.features.tfi = 0; value.features.replenishmentPressure = 0;
    result ??= engine.evaluate(value);
  }
  assert.equal(result?.side, 1);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.ok(diagnostics.score >= testConfig().scoreEnter);
  assert.equal(diagnostics.votes.flow, 0);
  assert.equal(diagnostics.votes.activeGroups, 2);
  assert.equal(diagnostics.votes.quorum, true);
});

test("independent group quorum still requires kinematic confirmation", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 8; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.velocityZ = -1;
    value.features.accelerationZ = -1;
    value.features.impulseBps = -1;
    value.features.breakoutUpBps = 0;
    value.features.cusumUpScore = 0;
    result = engine.evaluate(value);
  }
  assert.equal(result, null);
  assert.equal(engine.latestEvaluation()!.long.votes.kinematic, 0);
  assert.equal(engine.latestEvaluation()!.long.votes.quorum, false);
});

test("anti-chasing uses midpoint at arm and rejects a late entry", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    const mid = 100.005 * Math.exp(index * .5 / 10_000);
    value.features.mid = mid; value.features.microprice = mid * Math.exp(.3 / 10_000);
    value.bestBid = mid - .005; value.bestAsk = mid + .005;
    result = engine.evaluate(value);
  }
  assert.equal(result, null);
  assert.equal(engine.latestEvaluation()!.candidate, null);
  assert.ok(engine.latestEvaluation()!.long.reasons.includes("MAXIMUM_CHASE_EXCEEDED"));
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

test("an uneconomic micro candidate never becomes an order intent", () => {
  const engine = new DeterministicEntryEngine({ ...testConfig(), minimumNetEdgeBps: .5 });
  let sawCandidate = false;
  let intent = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.longCost = cost(100); value.shortCost = cost(100);
    intent ??= engine.evaluate(value);
    sawCandidate ||= engine.latestEvaluation()?.candidate?.side === 1;
  }
  assert.equal(sawCandidate, true);
  assert.equal(intent, null);
  assert.equal(engine.latestEvaluation()!.long.costPass, false);
});

test("a cost-rejected episode is reconsidered after its evidence and economics improve", () => {
  const engine = new DeterministicEntryEngine({ ...testConfig(), minimumNetEdgeBps: .5,
    microTrigger: { ...testConfig().microTrigger, candidateRetryMs: 200 } });
  let sawRejectedCandidate = false;
  let intent = null;
  for (let index = 0; index < 60; index += 1) {
    const value = context(1, 1_000 + index * 50);
    const rejected = !sawRejectedCandidate;
    value.longCost = cost(rejected ? 100 : .2);
    value.shortCost = cost(rejected ? 100 : .2);
    intent ??= engine.evaluate(value);
    if (engine.latestEvaluation()?.candidate && !engine.latestEvaluation()?.intent) sawRejectedCandidate = true;
  }
  assert.equal(sawRejectedCandidate, true);
  assert.equal(intent?.side, 1);
});

test("a continuous signal fires once and needs both cooldown and reset before re-arming", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  const first = persistentIntent(engine)!;
  assert.ok(first);
  assert.equal(persistentIntent(engine, 1, first.createdMs + 100), null);
  for (const at of [first.createdMs + 3_100, first.createdMs + 3_400]) assert.equal(engine.evaluate(neutralContext(at)), null);
  assert.equal(persistentIntent(engine, 1, first.createdMs + 3_700)?.side, 1);
});

test("a liquidity-blocked candidate is recorded once and a new episode must reconfirm", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  const blockedLiquidity = {
    pass: false, stress: false, sampleCount: 50, medianSpreadBps: 1,
    tradeThresholdBps: .5, stressThresholdBps: 2,
    reasons: ["SPREAD_ABOVE_DYNAMIC_TRADE_THRESHOLD"],
  } as const;
  let candidateSide: 1 | -1 | undefined;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.longLiquidity = blockedLiquidity;
    value.shortLiquidity = blockedLiquidity;
    assert.equal(engine.evaluate(value), null);
    candidateSide ??= engine.latestEvaluation()?.candidate?.side;
  }
  const blocked = engine.latestEvaluation()!;
  assert.equal(candidateSide, 1);
  assert.equal(blocked.long.rawDirectionalPass, true);
  assert.equal(blocked.long.candidatePass, false);
  assert.equal(blocked.long.liquidityPass, false);

  const passingLiquidity = { ...blockedLiquidity, pass: true, reasons: [] } as const;
  const released = context(1, 4_500); released.longLiquidity = passingLiquidity; released.shortLiquidity = passingLiquidity;
  assert.equal(engine.evaluate(released), null);
  engine.evaluate(neutralContext(4_600));
  let reconfirmed = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 4_700 + index * 50); value.longLiquidity = passingLiquidity; value.shortLiquidity = passingLiquidity;
    reconfirmed ??= engine.evaluate(value);
  }
  assert.equal(reconfirmed?.side, 1);
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

test("directional regime is deterministic, symmetric, and independent of execution liquidity", () => {
  const baseline = alignedFeatures(1);
  const stressed = { ...baseline, providerAgeMs: 10_000, spreadBps: 80, spreadZ: 20, depthZ: -20, usableDepthNotional: 1 };
  const normalDecision = new DeterministicRegimeEngine(DEFAULT_DETERMINISTIC_REGIME_CONFIG).classify(baseline);
  const stressedDecision = new DeterministicRegimeEngine(DEFAULT_DETERMINISTIC_REGIME_CONFIG).classify(stressed);
  assert.equal(normalDecision.name, "BREAKOUT_UP");
  assert.deepEqual(stressedDecision, normalDecision);

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
