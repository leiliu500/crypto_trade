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
import { analyticEdges, validateMultiHorizonAnalyticConfig } from "../src/economics/analytic-edge.js";

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
    slowTrendReady: true, trendFastBps: side * 20, trendMediumBps: side * 35, trendSlowBps: side * 60,
    slowTrendAlignment: side * .7, slowTrendEfficiency: .5, slowVarianceRate: 4e-8, slowSigmaBps: 60,
    longPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0, remainingRoomBps: 0,
      structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 },
    shortPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0, remainingRoomBps: 0,
      structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 },
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

const testConfig = () => ({ ...DEFAULT_DETERMINISTIC_SIGNAL_CONFIG, minimumNetEdgeBps: -10, requireMakerEntry: false });

function calibratedPullbackConfig(regime: "TREND_UP" | "CHOP" = "TREND_UP", lowerConfidenceGrossReturnBps = 15,
  effectiveSampleCount = 200) {
  const cfg = testConfig();
  cfg.calibratedEdges = [{
    symbol: "BTC/USD", family: "PULLBACK_RECOVERY", side: 1, regime,
    minimumQuality: 0, maximumQuality: 1, minimumSpreadBps: 0, maximumSpreadBps: 10,
    horizonMs: cfg.pullbackRecovery.horizonMs, path: "TAKER_TAKER",
    meanGrossReturnBps: lowerConfidenceGrossReturnBps + 10, lowerConfidenceGrossReturnBps,
    effectiveSampleCount,
  }];
  return cfg;
}

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

test("slow trend warm-up and direction alignment fail closed", () => {
  for (const mutate of [
    (value: EntryContext) => { value.features.slowTrendReady = false; },
    (value: EntryContext) => { value.features.slowTrendAlignment = -.7; },
    (value: EntryContext) => { value.features.trendFastBps = -20; },
  ]) {
    const engine = new DeterministicEntryEngine(testConfig());
    let result = null;
    for (let index = 0; index < 20; index += 1) {
      const value = context(1, 1_000 + index * 50); mutate(value); result ??= engine.evaluate(value);
    }
    assert.equal(result, null);
    assert.equal(engine.latestEvaluation()!.long.slowTrendPass, false);
  }
});

test("continuation cannot enter or remain valid when the active regime disallows its direction", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  let value = context(1);
  for (let index = 0; index < 20; index += 1) {
    value = context(1, 1_000 + index * 50);
    value.regime = { name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 };
    result ??= engine.evaluate(value);
  }
  assert.equal(result, null);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.equal(diagnostics.family, "CONTINUATION");
  assert.equal(diagnostics.continuationTrendPass, true);
  assert.equal(diagnostics.regimePass, false);
  assert.ok(diagnostics.reasons.includes("REGIME_GATE"));
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "CONTINUATION", "ANALYTIC"), false);
});

test("an uncalibrated pullback remains observable but cannot authorize an entry", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result, null);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.equal(diagnostics.family, "PULLBACK_RECOVERY");
  assert.equal(diagnostics.continuationTrendPass, false);
  assert.equal(diagnostics.pullbackRecoveryPass, true);
  assert.equal(diagnostics.edgeSource, "UNRESOLVED");
  assert.equal(diagnostics.edgeEffectiveSampleCount, 0);
  assert.equal(diagnostics.pullbackCalibrationPass, false);
  assert.ok(diagnostics.reasons.includes("PULLBACK_CALIBRATION_REQUIRED"));
  assert.ok(diagnostics.reasons.includes("EDGE_NOT_RESOLVED"));
});

test("the uncalibrated pullback gate is symmetric for long and short entries", () => {
  for (const side of [1, -1] as const) {
    const engine = new DeterministicEntryEngine(testConfig());
    let result = null;
    for (let index = 0; index < 20; index += 1) {
      const value = context(side, 1_000 + index * 50);
      value.features.trendFastBps = side * -12;
      value.features.trendMediumBps = side * -5;
      value.features.slowTrendAlignment = side * -.15;
      const pullback = {
        ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
        remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
      };
      if (side === 1) value.features.longPullback = pullback;
      else value.features.shortPullback = pullback;
      result ??= engine.evaluate(value);
    }
    assert.equal(result, null);
    const diagnostics = side === 1 ? engine.latestEvaluation()!.long : engine.latestEvaluation()!.short;
    assert.equal(diagnostics.family, "PULLBACK_RECOVERY");
    assert.equal(diagnostics.pullbackCalibrationPass, false);
    assert.ok(diagnostics.reasons.includes("PULLBACK_CALIBRATION_REQUIRED"));
  }
});

test("a sufficiently sampled calibrated pullback may enter without continuation alignment", () => {
  const cfg = calibratedPullbackConfig();
  const engine = new DeterministicEntryEngine(cfg);
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result?.source, "DETERMINISTIC_PULLBACK_RECOVERY");
  assert.equal(result?.diagnostics.edgeSource, "CALIBRATED");
  assert.equal(result?.diagnostics.pullbackCalibrationPass, true);
  assert.equal(result?.diagnostics.continuationTrendPass, false);
  assert.equal(result?.selectedHorizonMs, cfg.pullbackRecovery.horizonMs);
});

test("a calibrated pullback bucket below the effective-sample requirement remains blocked", () => {
  const engine = new DeterministicEntryEngine(calibratedPullbackConfig("TREND_UP", 15, 99));
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result, null);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.equal(diagnostics.edgeSource, "CALIBRATED");
  assert.equal(diagnostics.edgeEffectiveSampleCount, 99);
  assert.equal(diagnostics.pullbackCalibrationPass, false);
  assert.ok(diagnostics.reasons.includes("PULLBACK_CALIBRATION_REQUIRED"));
  assert.ok(diagnostics.reasons.includes("INSUFFICIENT_EFFECTIVE_SAMPLES"));
});

test("an uncalibrated pullback cannot enter against the active regime", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.regime = { name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 };
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result, null);
  const diagnostics = engine.latestEvaluation()!.long;
  assert.equal(diagnostics.family, "PULLBACK_RECOVERY");
  assert.equal(diagnostics.regimePass, false);
  assert.equal(diagnostics.edgeSource, "UNRESOLVED");
  assert.equal(diagnostics.edgeEffectiveSampleCount, 0);
  assert.equal(diagnostics.pullbackCalibrationPass, false);
  assert.ok(diagnostics.reasons.includes("PULLBACK_CALIBRATION_REQUIRED"));
});

test("a sufficiently sampled calibrated pullback may enter against the active regime", () => {
  const cfg = calibratedPullbackConfig("CHOP");
  const engine = new DeterministicEntryEngine(cfg);
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.regime = { name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 };
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result?.diagnostics.edgeSource, "CALIBRATED");
  assert.equal(result?.diagnostics.edgeEffectiveSampleCount, 200);
  assert.equal(result?.diagnostics.pullbackCalibrationPass, true);
});

test("pending signal validity cannot cross from pullback into continuation or vice versa", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  const value = context(1);
  value.features.trendFastBps = -12;
  value.features.trendMediumBps = -5;
  value.features.slowTrendAlignment = -.15;
  value.features.longPullback = {
    ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
    remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
  };
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY"), false);
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY", "ANALYTIC"), false);
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY", "CALIBRATED"), true);
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "CONTINUATION"), false);
  value.regime = { name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 };
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY", "ANALYTIC"), false);
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY", "CALIBRATED"), true);
  value.features.longPullback.ready = false;
  value.features.trendFastBps = 20;
  value.features.trendMediumBps = 35;
  value.features.slowTrendAlignment = .7;
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "PULLBACK_RECOVERY"), false);
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "CONTINUATION"), false);
  value.regime = { name: "TREND_UP", allowLong: true, allowShort: false, riskScale: 1 };
  assert.equal(engine.signalStillValid(1, value.features, value.regime, "CONTINUATION"), true);
});

test("partial pullbacks do not bypass structural or exact economic gates", () => {
  const engine = new DeterministicEntryEngine(testConfig());
  let result = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.features.trendFastBps = -12;
    value.features.trendMediumBps = -5;
    value.features.slowTrendAlignment = -.15;
    value.features.longPullback = {
      ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
      remainingRoomBps: 20, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
    };
    result ??= engine.evaluate(value);
  }
  assert.equal(result, null);
  assert.equal(engine.latestEvaluation()?.long.pullbackRecoveryPass, false);
  assert.ok(engine.latestEvaluation()?.long.reasons.includes("STRUCTURAL_SETUP_GATE"));
});

test("fee-sized pullback room must still clear the unchanged robust cost gate", () => {
  const run = (roundTripBps: number) => {
    const engine = new DeterministicEntryEngine({ ...calibratedPullbackConfig("TREND_UP", 50), minimumNetEdgeBps: .5 });
    let result = null;
    for (let index = 0; index < 20; index += 1) {
      const value = context(1, 1_000 + index * 50);
      value.features.trendFastBps = -12;
      value.features.trendMediumBps = -5;
      value.features.slowTrendAlignment = -.15;
      value.features.longPullback = {
        ready: true, structuralMoveBps: 150, pullbackDepthBps: 100, recoveryBps: 20,
        remainingRoomBps: 80, structuralExtremeAgeMs: 3_600_000, reversalExtremeAgeMs: 300_000,
      };
      value.longCost = cost(roundTripBps);
      result ??= engine.evaluate(value);
    }
    return { result, diagnostics: engine.latestEvaluation()!.long };
  };
  const affordable = run(20);
  const expensive = run(60);
  assert.equal(affordable.result?.source, "DETERMINISTIC_PULLBACK_RECOVERY");
  assert.equal(affordable.diagnostics.costPass, true);
  assert.equal(expensive.result, null);
  assert.equal(expensive.diagnostics.costPass, false);
  assert.ok(expensive.diagnostics.reasons.includes("COST_GATE"));
});

test("maker-first entries exclude the taker entry path", () => {
  const engine = new DeterministicEntryEngine({ ...testConfig(), requireMakerEntry: true });
  const pathCost = (path: "MAKER_TAKER" | "TAKER_TAKER", amount: number) => ({
    path, supported: true, entryExecutionBps: 0, exitExecutionBps: 0, entryFeeBps: amount / 2,
    exitFeeBps: amount / 2, marketImpactBps: 0, latencyBps: 0, adverseSelectionBps: 0,
    fundingBps: 0, borrowBps: 0, estimatedCostBps: amount, positiveCostErrorP95Bps: 0,
    fillProbability: path === "MAKER_TAKER" ? .9 : 1,
  } as const);
  let intent = null;
  for (let index = 0; index < 20; index += 1) {
    const value = context(1, 1_000 + index * 50);
    value.longEconomicCosts = [pathCost("TAKER_TAKER", .01), pathCost("MAKER_TAKER", .2)];
    intent ??= engine.evaluate(value);
  }
  assert.equal(intent?.executionPath, "MAKER_TAKER");
});

test("long-horizon analytical edge uses slow sampled variance and fails closed before trend warm-up", () => {
  const cfg = { horizons: DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticHorizons,
    spreadUncertaintyWeight: 0, flipUncertaintyWeight: 0 };
  const continuation = {
    score: .8, efficiency: .8, flowPersistence: .8, velocity: .8, breakoutHold: .8,
    regimeStability: 1, volatilitySuitability: 1, slowTrendAlignment: .8, slowTrendEfficiency: .5,
  };
  const baseline = alignedFeatures(1);
  const first = analyticEdges({ side: 1, features: baseline, continuation }, cfg);
  const fastVarianceChanged = analyticEdges({ side: 1,
    features: { ...baseline, varianceRate: baseline.varianceRate * 10_000 }, continuation }, cfg);
  const slowVarianceChanged = analyticEdges({ side: 1,
    features: { ...baseline, slowVarianceRate: baseline.slowVarianceRate * 4 }, continuation }, cfg);
  assert.deepEqual(fastVarianceChanged, first);
  assert.ok(slowVarianceChanged[0]!.grossBeforeUncertaintyBps > first[0]!.grossBeforeUncertaintyBps);
  assert.deepEqual(analyticEdges({ side: 1, features: { ...baseline, slowTrendReady: false }, continuation }, cfg), []);
});

test("sustained 5/15/60-minute continuation clears incident costs while a fading fast leg does not", () => {
  const cfg = { horizons: DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticHorizons,
    spreadUncertaintyWeight: .5, flipUncertaintyWeight: .2 };
  const continuation = {
    score: .4815988496791121, efficiency: .2, flowPersistence: .5, velocity: .5, breakoutHold: .1,
    regimeStability: 0, volatilitySuitability: .8, slowTrendAlignment: .898, slowTrendEfficiency: .099,
  };
  const incident = alignedFeatures(1);
  incident.trendFastBps = 56.33;
  incident.trendMediumBps = 84.92;
  incident.trendSlowBps = 57.58;
  incident.slowTrendAlignment = .898;
  incident.slowTrendEfficiency = .099;
  incident.slowVarianceRate = Math.pow(60.70 / 10_000, 2) / 3_600;
  incident.slowSigmaBps = 60.70;
  incident.spreadBps = 3.950726285846578;
  incident.flowFlipRate = .2495;
  const sustained = analyticEdges({ side: 1, features: incident, continuation }, cfg).at(-1)!;
  const fading = analyticEdges({ side: 1, features: { ...incident, trendFastBps: 5.6 }, continuation }, cfg).at(-1)!;
  assert.ok(sustained.conservativeGrossBps > 40.38115056383447);
  assert.ok(fading.conservativeGrossBps < 40.38115056383447);
  assert.ok(sustained.conservativeGrossBps > fading.conservativeGrossBps);
  assert.throws(() => validateMultiHorizonAnalyticConfig({
    ...cfg, horizons: [{ ...cfg.horizons[0]!, trendCaptureFraction: 1.01 }],
  }), /trend capture fraction/);
});

test("aligned continuation may cost-revalidate a below-stress spread but never a stressed spread", () => {
  const incidentCost = {
    path: "MAKER_MAKER_TAKER_FALLBACK", supported: true,
    entryExecutionBps: 0, exitExecutionBps: 1, entryFeeBps: 15, exitFeeBps: 15,
    marketImpactBps: 0, latencyBps: 0, adverseSelectionBps: 4.93208603647684,
    fundingBps: 0, borrowBps: 0, estimatedCostBps: 35.93208603647684,
    positiveCostErrorP95Bps: 2, fillProbability: .8,
  } as const;
  const widenedSpread = {
    pass: false, stress: false, sampleCount: 512, medianSpreadBps: 2.4,
    tradeThresholdBps: 2.904746773483134, stressThresholdBps: 6.710543056945958,
    reasons: ["SPREAD_ABOVE_DYNAMIC_TRADE_THRESHOLD"],
  } as const;
  const evaluate = (stress: boolean) => {
    const engine = new DeterministicEntryEngine(DEFAULT_DETERMINISTIC_SIGNAL_CONFIG);
    let intent = null;
    for (let index = 0; index < 20; index += 1) {
      const value = context(1, 1_000 + index * 50);
      value.regime = { name: "TREND_UP", allowLong: true, allowShort: false, riskScale: 1 };
      value.features.trendFastBps = 56.33;
      value.features.trendMediumBps = 84.92;
      value.features.trendSlowBps = 57.58;
      value.features.slowTrendAlignment = .898;
      value.features.slowTrendEfficiency = .099;
      value.features.slowVarianceRate = Math.pow(60.70 / 10_000, 2) / 3_600;
      value.features.slowSigmaBps = 60.70;
      value.features.spreadBps = 3.950726285846578;
      value.features.flowFlipRate = .2495;
      value.longLiquidity = { ...widenedSpread, stress };
      value.shortLiquidity = { ...widenedSpread, stress };
      value.longEconomicCosts = [incidentCost];
      value.shortEconomicCosts = [incidentCost];
      intent ??= engine.evaluate(value);
    }
    return { intent, evaluation: engine.latestEvaluation()! };
  };
  const accepted = evaluate(false);
  assert.equal(accepted.intent?.side, 1);
  assert.equal(accepted.intent?.executionPath, "MAKER_MAKER_TAKER_FALLBACK");
  assert.equal(accepted.evaluation.long.liquidityPass, true);
  assert.ok(accepted.intent!.lowerBoundNetBps >= DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumNetEdgeBps);
  const rejected = evaluate(true);
  assert.equal(rejected.intent, null);
  assert.equal(rejected.evaluation.long.liquidityPass, false);
  assert.ok(rejected.evaluation.long.reasons.includes("LIQUIDITY_GATE"));
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
  // grossOpportunityBps is already conservative of signal uncertainty, so exact revalidation charges only robust execution cost.
  const fixedFeeBps = cost().feeBps;
  const robustBudgetBps = intent.grossOpportunityBps - cfg.minimumNetEdgeBps - fixedFeeBps;
  const variableBudgetBps = Math.min(
    robustBudgetBps / cfg.costSafetyFactor,
    robustBudgetBps - cfg.positiveCostErrorP95Bps,
  );
  const thresholdCost = fixedFeeBps + variableBudgetBps;
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
    pass: false, stress: true, sampleCount: 50, medianSpreadBps: 1,
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

  const passingLiquidity = { ...blockedLiquidity, pass: true, stress: false, reasons: [] } as const;
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
  assert.equal(first[2]!.slowTrendReady, false);
});

test("sampled slow trend becomes ready only after causal window coverage", () => {
  const extension = new DeterministicFeatureExtensions({ ...DEFAULT_EXTENSION_CONFIG,
    trendSampleIntervalMs: 1_000, trendFastWindowMs: 1_000, trendMediumWindowMs: 2_000,
    trendSlowWindowMs: 3_000, trendMinimumCoverage: 1 });
  const output = [100, 100.1, 100.2, 100.3].map((mid, index) => {
    const base = alignedFeatures(1, 1_000 + index * 1_000);
    base.mid = mid; base.microprice = mid;
    return extension.update(base, { providerAgeMs: 5, usableDepthQty: 100, usableDepthNotional: 1_000_000,
      replenishmentPressure: .2, bidAdditionQty: 1, askAdditionQty: 0, bidRemovalQty: 0, askRemovalQty: 0 });
  });
  assert.deepEqual(output.map((item) => item.slowTrendReady), [false, false, false, true]);
  assert.ok(output[3]!.trendFastBps > 0 && output[3]!.trendMediumBps > 0 && output[3]!.trendSlowBps > 0);
  assert.ok(output[3]!.slowTrendAlignment > 0);
});

test("sampled multi-hour state detects an ordered rise, pullback, and recovery causally", () => {
  const extension = new DeterministicFeatureExtensions({ ...DEFAULT_EXTENSION_CONFIG,
    trendSampleIntervalMs: 1_000, trendFastWindowMs: 1_000, trendMediumWindowMs: 2_000,
    trendSlowWindowMs: 3_000, trendMinimumCoverage: 1,
    pullbackWindowMs: 5_000, pullbackMinimumCoverage: 1, pullbackSampleIntervalMs: 1_000 });
  const output = [100, 101, 102, 101, 100.5, 101].map((mid, index) => {
    const base = alignedFeatures(1, 1_000 + index * 1_000);
    base.mid = mid; base.microprice = mid;
    return extension.update(base, { providerAgeMs: 5, usableDepthQty: 100, usableDepthNotional: 1_000_000,
      replenishmentPressure: .2, bidAdditionQty: 1, askAdditionQty: 0, bidRemovalQty: 0, askRemovalQty: 0 });
  });
  assert.deepEqual(output.map((item) => item.longPullback.ready), [false, false, false, false, false, true]);
  const state = output.at(-1)!.longPullback;
  assert.ok(state.structuralMoveBps > 190);
  assert.ok(state.pullbackDepthBps > 140);
  assert.ok(state.recoveryBps > 49);
  assert.ok(state.remainingRoomBps > 98);
  assert.equal(state.structuralExtremeAgeMs, 3_000);
  assert.equal(state.reversalExtremeAgeMs, 1_000);
});

test("persisted slow trend restores restart readiness without hydrating fast microstructure state", () => {
  const extension = new DeterministicFeatureExtensions({ ...DEFAULT_EXTENSION_CONFIG,
    trendSampleIntervalMs: 1_000, trendFastWindowMs: 1_000, trendMediumWindowMs: 2_000,
    trendSlowWindowMs: 3_000, trendMinimumCoverage: .9 });
  const asOfMs = 10_000;
  const restored = extension.restoreSlowTrend([
    { atMs: 7_000, mid: 100 }, { atMs: 8_000, mid: 100.1 },
    { atMs: 9_000, mid: 100.2 }, { atMs: 10_000, mid: 100.3 },
    { atMs: 11_000, mid: 500 }, { atMs: Number.NaN, mid: 100 },
  ], asOfMs);
  assert.equal(restored.reason, "RESTORED");
  assert.equal(restored.ready, true);
  const base = alignedFeatures(1, 10_100);
  base.mid = 100.31; base.microprice = 100.31;
  const output = extension.update(base, { providerAgeMs: 5, usableDepthQty: 100, usableDepthNotional: 1_000_000,
    replenishmentPressure: .2, bidAdditionQty: 1, askAdditionQty: 0, bidRemovalQty: 0, askRemovalQty: 0 });
  assert.equal(output.slowTrendReady, true);
  assert.ok(output.trendSlowBps > 0 && output.trendSlowBps < 100);
  assert.equal(output.impulseBps, 0);
  assert.equal(output.anchorDistanceBps, 0);
});

test("stale persisted slow trend fails closed", () => {
  const extension = new DeterministicFeatureExtensions({ ...DEFAULT_EXTENSION_CONFIG,
    trendSampleIntervalMs: 1_000, trendFastWindowMs: 1_000, trendMediumWindowMs: 2_000,
    trendSlowWindowMs: 3_000, trendMinimumCoverage: .9 });
  const restored = extension.restoreSlowTrend([
    { atMs: 1_000, mid: 100 }, { atMs: 2_000, mid: 101 }, { atMs: 3_000, mid: 102 }, { atMs: 4_000, mid: 103 },
  ], 100_000);
  assert.equal(restored.reason, "HISTORY_STALE");
  assert.equal(restored.ready, false);
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
