import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type SymbolConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import { PositionManager, type Position } from "../src/strategy/position-manager.js";
import { PolicyCollector, type PolicyObservation } from "../src/research/policy-collector.js";
import { evaluatePolicies, validPolicyModel } from "../src/research/policy-validation.js";
import { buildPolicyPlan, policyReserveBps } from "../src/research/policy-planner.js";
import { findPolicy, policyCandidates, policyExit, policyQuantity, POLICY_VERSION } from "../src/research/trading-policy.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import { recoverPolicyPositions } from "../src/research/policy-restore.js";
import { policyMarketPulse } from "../src/research/policy-pulse.js";
import type { EpisodeObservation } from "../src/research/execution-stress.js";

const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config" });
const asset: AssetRules = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
  priceIncrement: .001, maximumOrderQty: 100, shortable: true };
const day = 86_400_000, end = Date.UTC(2026, 8, 4), now = end + 3_600_000;
const liquid = { pass: true, stress: false, sampleCount: 100, medianSpreadBps: 1,
  tradeThresholdBps: 1, stressThresholdBps: 2, reasons: [] };

function book(at: number, mid = 100, symbol = "BTC/USD"): BookState {
  return { symbol, bids: [{ px: mid - .005, qty: 10 }], asks: [{ px: mid + .005, qty: 10 }],
    exchangeTsMs: at, receiveTsMs: at, sequence: BigInt(at), sourceReset: false, valid: true };
}
function features(at: number, side: 1 | -1 = 1, mid = 100, symbol = "BTC/USD"): DeterministicFeatures {
  const pullback = { ready: false, structuralMoveBps: 100, pullbackDepthBps: 40, recoveryBps: 8,
    remainingRoomBps: 40, structuralExtremeAgeMs: 600_000, reversalExtremeAgeMs: 10_000 };
  return { symbol, mid, spread: .01, spreadBps: .01 / mid * 10_000, microprice: mid, visibleDepth: 20,
    qi1: side * .5, qiK: side * .5, persistentQiK: side * .5, ofi: side, tfi: side,
    bidCancellationRatio: 0, askCancellationRatio: 0, replenishmentPressure: 0,
    velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: side, accelerationZ: 0, efficiency: .8, cusumUp: side === 1, cusumDown: side === -1,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, stale: false, staleReason: null, receiveTsMs: at,
    microEdgeBps: side, impulseBps: side * 2, breakoutUpBps: side === 1 ? 2 : 0, breakoutDownBps: side === -1 ? 2 : 0,
    anchorDistanceBps: 0, sigmaImpulseBps: 1, cusumUpScore: 1, cusumDownScore: 1, flowFlipRate: 0,
    usableDepthQty: 20, usableDepthNotional: 2_000, slowTrendReady: true,
    trendFastBps: side * 10, trendMediumBps: side * 20, trendSlowBps: side * 40,
    slowTrendAlignment: side, slowTrendEfficiency: .6, slowVarianceRate: 1e-8, slowSigmaBps: 10,
    longPullback: { ...pullback }, shortPullback: { ...pullback } };
}

function position(side: 1 | -1, policyId = "breakout-1m"): Position {
  return { symbol: "BTC/USD", side, qty: .1, entryPx: 100, openedMs: 1_250,
    initialRiskPx: 1, roundTripCostPx: .1, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER",
    policy: { version: POLICY_VERSION, id: policyId, feeBps: 5, reserveBps: 2 } };
}

test("new signals are symmetric, causal, and separate trend, breakout, and recovery", () => {
  for (const side of [1, -1] as const) {
    const f = features(1_000, side);
    assert.deepEqual(policyCandidates(f).map((c) => c.family), ["CONTINUATION", "EARLY_BREAKOUT"]);
    assert.ok(policyCandidates(f).every((c) => c.side === side));
    (side === 1 ? f.longPullback : f.shortPullback).ready = true;
    assert.equal(policyCandidates(f).at(-1)?.family, "PULLBACK_RECOVERY");
    assert.deepEqual(policyCandidates({ ...f, stale: true }), []);
    assert.deepEqual(policyCandidates({ ...f, slowTrendReady: false }), []);
    assert.deepEqual(policyCandidates({ ...f, ofi: NaN }), []);
  }
});

test("policy pulse distinguishes live signals from authorization and reflects gate priority", () => {
  const input: Parameters<typeof policyMarketPulse>[0] = { nowMs: now, book: book(now), features: features(now),
    mode: "PAPER_RESEARCH", shortable: true, models: [], riskAllowed: true, riskReasons: [],
    positionOpen: false, pendingOrder: false, cooldownUntilMs: 0, activePolicyId: null,
    lastSample: { atMs: now - 10_000, candidates: [{ policyId: "trend-15m", side: 1 }] },
    lastEvaluation: undefined, lastRejection: null, liquidity: { long: liquid, short: liquid } };
  const pulse = policyMarketPulse(input);
  assert.equal(pulse.status, "WAITING_FOR_QUOTE");
  assert.equal(pulse.promotedModels.length, 0);
  assert.equal(pulse.nextSampleAtMs, now + 50_000);
  assert.equal(pulse.families.length, 3);
  assert.equal(pulse.families[0]!.longSignal, true);
  assert.equal(pulse.families[0]!.shortSignal, false);
  pulse.lastSample!.candidates[0]!.policyId = "mutated-ui-copy";
  assert.equal(input.lastSample!.candidates[0]!.policyId, "trend-15m");
  assert.equal(policyMarketPulse({ ...input, mode: "CALIBRATED_PAPER" }).status, "AWAITING_VALIDATION");
  assert.equal(policyMarketPulse({ ...input, features: { ...features(now), ofi: -1 } }).status, "WAITING_FOR_SIGNAL");
  assert.equal(policyMarketPulse({ ...input, cooldownUntilMs: now + 60_000 }).status, "COOLDOWN");
  assert.equal(policyMarketPulse({ ...input, riskAllowed: false, riskReasons: ["ACCOUNT_UNKNOWN"] }).status, "RISK_BLOCKED");
  assert.equal(policyMarketPulse({ ...input, features: { ...features(now), kinematicsReady: false } }).status, "WARMING");
  assert.equal(policyMarketPulse({ ...input, positionOpen: true }).status, "POSITION_OPEN");
  assert.equal(policyMarketPulse({ ...input, positionOpen: true, pendingOrder: true }).status, "ORDER_PENDING");
  assert.equal(policyMarketPulse({ ...input, positionOpen: true, book: { ...book(now), valid: false } }).status, "DATA_GATED");
  const short = policyMarketPulse({ ...input, features: features(now, -1) });
  assert.equal(short.families[0]!.shortSignal, true);
  assert.equal(short.families[0]!.longSignal, false);
  assert.equal(policyMarketPulse({ ...input, features: features(now, -1), shortable: false }).candidates.length, 0);
});

test("engine snapshots scope and expire policy models per symbol and omit pulse in legacy/exercise mode", async () => {
  let at = now;
  const engine = new TradingEngine({ ...cfg, continuousRecordingEnabled: false }, { now: () => at });
  const c = cfg.symbolConfigs["BTC/USD"]!;
  const model = evaluatePolicies(data(() => 20, policyReserveBps(c)).map((row) =>
    ({ ...row, configurationVersion: c.configurationVersion })), c.configurationVersion, now).models[0]!;
  assert.equal(engine.replacePolicyModels([model]), 1);
  assert.equal(engine.state().markets.find((m) => m.symbol === "BTC/USD")!.policyPulse!.promotedModels.length, 1);
  assert.equal(engine.state().markets.find((m) => m.symbol === "ETH/USD")!.policyPulse!.promotedModels.length, 0);
  at = model.expiresAtMs;
  assert.equal(engine.state().markets[0]!.policyPulse!.promotedModels.length, 0);
  const legacy = new TradingEngine({ ...cfg, policyEngineEnabled: false, continuousRecordingEnabled: false });
  const exercise = new TradingEngine({ ...cfg, paperEntryExercise: true, continuousRecordingEnabled: false });
  assert.equal(legacy.state().markets[0]!.policyPulse, null);
  assert.equal(exercise.state().markets[0]!.policyPulse, null);
  await engine.stop(); await legacy.stop(); await exercise.stop();
});

test("collector waits for arrival, uses executable bid/ask and fees, and emits immutable starts", () => {
  for (const side of [1, -1] as const) {
    const collector = new PolicyCollector("v1", "BTC/USD", 5, 2);
    const start = collector.observe(book(1_000), features(1_000, side), asset);
    assert.equal(start.length, 4);
    assert.equal(start[0]!.entryPrice, null);
    assert.deepEqual(collector.observe(book(1_249), features(1_249, side), asset), []);
    collector.observe(book(1_250), features(1_250, side), asset);
    collector.observe(book(1_750, 100 + side), features(1_750, side, 100 + side), asset);
    const exits = collector.observe(book(2_000, 100 + side), features(2_000, side, 100 + side), asset);
    assert.equal(exits.length, 4);
    for (const o of exits) {
      assert.equal(o.status, "COMPLETE");
      assert.equal(o.reason, "POLICY_TARGET");
      assert.equal(o.entryPrice, side === 1 ? 100.005 : 99.995);
      const gross = side * (o.exitPrice! - o.entryPrice!) / o.entryPrice! * 10_000;
      assert.ok(Math.abs(o.netBps! - (gross - 5 * (1 + o.exitPrice! / o.entryPrice!) - 2)) < 1e-10);
    }
    assert.equal(start[0]!.entryPrice, null, "pending events must not mutate after enqueue");
  }
});

test("IOC nonfills are zero attempts; late, stale and missing quote paths are invalid", () => {
  const collector = new PolicyCollector("v1", "BTC/USD", 5, 2);
  collector.observe(book(1_000), features(1_000), asset);
  const nofills = collector.observe(book(1_250, 101), features(1_250, 1, 101), asset);
  assert.equal(nofills.length, 4);
  assert.ok(nofills.every((o) => o.status === "COMPLETE" && o.reason === "ENTRY_NOT_FILLED" && o.netBps === 0));
  for (const at of [2_251, 7_000]) {
    const c = new PolicyCollector("v1", "BTC/USD", 5, 2);
    c.observe(book(1_000), features(1_000), asset);
    assert.ok(c.observe(book(at), features(at), asset).filter((o) => o.status !== "PENDING")
      .every((o) => o.status === "INVALID"));
  }
  const c = new PolicyCollector("v1", "BTC/USD", 5, 2);
  c.observe(book(1_000), features(1_000), asset);
  assert.equal(c.invalidate(1_100, "DISCONNECT").length, 4);
  assert.deepEqual(c.invalidate(1_200, "DISCONNECT"), []);
});

test("policy sizing respects venue increments, minimum lots and short availability", () => {
  assert.equal(policyQuantity(100, asset), .12);
  assert.equal(policyQuantity(100_000, asset), 0);
  const c = new PolicyCollector("v1", "BTC/USD", 5, 2);
  assert.deepEqual(c.observe(book(1_000), features(1_000, -1), { ...asset, shortable: false }), []);
});

test("entry-timed labels capture a brief signal between research ticks without pooling or changing the timer", () => {
  for (const side of [1, -1] as const) {
    const c = new PolicyCollector("v2", "BTC/USD", 5, 2);
    const noSignal = { ...features(1_000, side), trendSlowBps: 0, trendMediumBps: 0,
      trendFastBps: 0, velocityZ: 0, impulseBps: 0, breakoutUpBps: 0, breakoutDownBps: 0 };
    assert.deepEqual(c.observe(book(1_000), noSignal, asset), []);
    assert.deepEqual(c.observe(book(31_000), features(31_000, side), asset), []);
    const candidate = policyCandidates(features(31_000, side))[0]!;
    const starts = c.captureEntry(book(31_000), features(31_000, side), asset, candidate, .04);
    assert.equal(starts.length, 2);
    assert.ok(starts.every((o) => o.sampling === "ENTRY" && o.signalAtMs === 31_000 && o.qty === .04));
    assert.equal(c.lastSampleAtMs(), 1_000, "entry capture must not reset the research clock");
    c.observe(book(31_250), features(31_250, side), asset);
    assert.ok(starts.every((o) => o.entryAtMs === null), "persisted starts remain immutable");
    assert.deepEqual(c.captureEntry(book(31_001), features(31_002, side), asset, candidate, .04), []);
    assert.deepEqual(c.captureEntry(book(31_001), { ...features(31_001, side), stale: true }, asset, candidate, .04), []);
    assert.deepEqual(c.captureEntry(book(31_001), features(31_001, side), asset, candidate, .0405), []);
  }
});

test("Market Pulse exposes liquidity and current-quote planning rejections without hiding them behind the research timer", () => {
  const input: Parameters<typeof policyMarketPulse>[0] = { nowMs: now, book: book(now), features: features(now),
    mode: "PAPER_RESEARCH", shortable: true, models: [], riskAllowed: true, riskReasons: [],
    positionOpen: false, pendingOrder: false, cooldownUntilMs: 0, activePolicyId: null,
    lastSample: undefined, lastEvaluation: undefined, lastRejection: null,
    liquidity: { long: { ...liquid, pass: false, reasons: ["DEPTH_Z_BELOW_LIMIT"] }, short: liquid } };
  assert.equal(policyMarketPulse(input).status, "LIQUIDITY_BLOCKED");
  assert.deepEqual(policyMarketPulse(input).reasons, ["DEPTH_Z_BELOW_LIMIT"]);
  const unblocked = { ...input, liquidity: { long: liquid, short: liquid } };
  const rejected = { atMs: now, quoteAtMs: now, policyId: "trend-15m", side: 1, reason: "POLICY_RISK_SIZE_BLOCK", modelKey: null };
  assert.equal(policyMarketPulse({ ...unblocked, lastEvaluation: rejected }).status, "ENTRY_BLOCKED");
  assert.equal(policyMarketPulse({ ...unblocked, lastEvaluation: { ...rejected, quoteAtMs: now - 1 } }).status, "WAITING_FOR_QUOTE");
  assert.equal(policyMarketPulse(unblocked).entryEvaluationMode, "FRESH_QUOTE");
});

test("partial IOC fill outcomes include losses and weight returns by requested quantity", () => {
  const c = new PolicyCollector("v1", "BTC/USD", 5, 2);
  const starts = c.observe(book(1_000), features(1_000), asset);
  c.observe({ ...book(1_250), asks: [{ px: 100.005, qty: .04 }, { px: 100.015, qty: 10 }] }, features(1_250), asset);
  c.observe(book(1_500, 99), features(1_500, 1, 99), asset);
  const exits = c.observe(book(1_750, 99), features(1_750, 1, 99), asset);
  assert.equal(exits.length, 4);
  for (const o of exits) {
    assert.equal(o.filledQty, .04);
    assert.equal(o.qty, starts[0]!.qty);
    assert.equal(o.reason, "POLICY_STOP");
    assert.ok(o.netBps! < 0);
    const gross = (99 - .005 - 100.005) / 100.005 * 10_000;
    assert.ok(Math.abs(o.grossBps! - gross * .04 / o.qty) < 1e-9);
  }
});

test("runtime shares stop, net target and unconditional deadline without legacy micro exits", () => {
  const manager = new PositionManager(cfg.position);
  for (const side of [1, -1] as const) {
    const p = position(side);
    assert.equal(manager.update(p, 100, 1_500, features(1_500, side), -500, 1, 500, true).action, "HOLD");
    assert.deepEqual(manager.update(p, 100 + side * .5, 1_600, features(1_600, side), -500, 1),
      { action: "EXIT", reason: "POLICY_TARGET" });
    assert.deepEqual(manager.update(position(side), 100 - side * .2, 1_600, features(1_600, side), 500, 0),
      { action: "EXIT", reason: "POLICY_STOP" });
    // Positive gross progress does not remove the policy deadline.
    assert.deepEqual(manager.update(position(side), 100 + side * .1, 61_250, features(61_250, side), 500, 0),
      { action: "EXIT", reason: "POLICY_DEADLINE" });
  }
  const bad = position(1); bad.policy!.version = "unknown";
  assert.deepEqual(manager.update(bad, 100, 1_500, features(1_500), 500, 0), { action: "EXIT", reason: "INVALID_POLICY" });
  assert.equal(policyExit(findPolicy("breakout-1m")!, NaN, 100, 0), "POLICY_STOP");
  const legacy = position(1); legacy.policy!.version = "executable-policy-v1";
  assert.deepEqual(manager.update(legacy, 100.5, 1_600, features(1_600), 0, 0), { action: "EXIT", reason: "POLICY_TARGET" });
});

function data(returnFor: (policyId: string, at: number) => number = (id) => id === "trend-15m" ? 20 : 10,
  reserve = 2): PolicyObservation[] {
  const rows: PolicyObservation[] = [];
  for (let hour = 0; hour < 14 * 24; hour++) {
    const at = end - 14 * day + hour * 3_600_000 + 60_000;
    for (const policyId of ["trend-15m", "trend-30m"]) {
      const net = returnFor(policyId, at), fee = 5;
      const exitPrice = 100 * (net + 10_000 + fee + reserve) / (10_000 - fee);
      rows.push({ sampling: "ENTRY", id: `${hour}-${policyId}`, configurationVersion: "v1", policyVersion: POLICY_VERSION,
        symbol: "BTC/USD", policyId, family: "CONTINUATION", side: 1, regime: "TREND_UP",
        signalAtMs: at, entryAtMs: at + 250, exitAtMs: at + 500 + findPolicy(policyId)!.horizonMs,
        entryPrice: 100, exitPrice, qty: .12, filledQty: .12, signalBid: 99.99, signalAsk: 100, spreadBps: 1,
        feeBps: fee, reserveBps: reserve, grossBps: (exitPrice / 100 - 1) * 10_000, netBps: net,
        status: "COMPLETE", reason: "POLICY_DEADLINE", features: {} });
    }
  }
  return rows;
}

test("predeclared purged daily train/validation/holdout produces a scoped expiring model", () => {
  const report = evaluatePolicies(data(), "v1", now);
  assert.equal(report.models.length, 1, JSON.stringify(report.evaluations));
  const model = report.models[0]!;
  assert.equal(model.policyId, "trend-15m");
  assert.equal(model.fittedMeanNetBps, 20);
  assert.ok(model.holdoutSamples >= 30 && model.independentSamples >= 100);
  assert.ok(model.trainedThroughMs < model.holdoutStartMs);
  assert.equal(model.expiresAtMs, end + day);
  assert.ok(validPolicyModel(model, "v1", now));
  assert.equal(validPolicyModel(model, "different", now), false);
  assert.equal(validPolicyModel(model, "v1", model.expiresAtMs), false);
  for (const fold of report.evaluations[0]!.folds) assert.ok(fold.trainingEndMs < fold.testStartMs);
  assert.deepEqual(evaluatePolicies(data(), "v1", now + 3_600_000).models, report.models);
});

test("holdout cannot select a policy or leak into its fitted return", () => {
  const rows = data((id, at) => at >= end - 3.5 * day
    ? (id === "trend-15m" ? -20 : 200) : (id === "trend-15m" ? 20 : 10));
  const report = evaluatePolicies(rows, "v1", now);
  assert.equal(report.evaluations[0]!.selectedPolicyId, "trend-15m");
  assert.equal(report.models.length, 0);
  assert.ok(report.evaluations[0]!.reasons.includes("NON_POSITIVE_FINAL_HOLDOUT_RETURN"));
  const positive = evaluatePolicies(data((id, at) => at >= end - 3.5 * day ? 100 : id === "trend-15m" ? 20 : 10), "v1", now);
  assert.equal(positive.models[0]!.fittedMeanNetBps, 20);
});

test("incomplete, duplicated, missing-variant, overlapping and cross-version data cannot promote", () => {
  const bad = data(); bad[0]!.status = "INVALID";
  assert.equal(evaluatePolicies(bad, "v1", now).models.length, 0);
  const pending = data(); pending[0]!.status = "PENDING";
  assert.equal(evaluatePolicies(pending, "v1", now).models.length, 0);
  assert.equal(evaluatePolicies(data().filter((o) => o.policyId === "trend-15m"), "v1", now).models.length, 0);
  const duplicated = data(); duplicated.push({ ...duplicated[0]!, id: "duplicate" });
  assert.equal(evaluatePolicies(duplicated, "v1", now).models.length, 0);
  assert.equal(evaluatePolicies(data(), "another-config", now).models.length, 0);
  const clustered = data().map((o, i) => ({ ...o, signalAtMs: end - day + i }));
  assert.equal(evaluatePolicies(clustered, "v1", now).models.length, 0);
  assert.equal(evaluatePolicies(data(() => -5), "v1", now).models.length, 0);
  const periodic = data().map((o) => ({ ...o, sampling: "PERIODIC" as const }));
  assert.deepEqual(evaluatePolicies(periodic, "v1", now).evaluations, []);
  assert.deepEqual(evaluatePolicies([...data(), ...periodic], "v1", now).models, evaluatePolicies(data(), "v1", now).models);
  assert.deepEqual(evaluatePolicies(data().map((o) => ({ ...o, policyVersion: "executable-policy-v1" })), "v1", now).models, []);
});

test("paper probes submit without a fictional positive edge and preserve all risk caps", () => {
  const input = { config: cfg.symbolConfigs["BTC/USD"]!, book: book(now), features: features(now), asset,
    candidate: policyCandidates(features(now))[0]!, policyId: "trend-15m", allowPaperResearch: true,
    equity: 100_000, equityHighWater: 100_000, nowMs: now };
  const result = buildPolicyPlan(input);
  assert.ok(result.plan, result.reason);
  assert.equal(result.plan.expectedValue, 0);
  assert.equal(result.plan.conservativeNetEdgeBps, undefined);
  assert.equal(result.plan.researchOnly, true);
  assert.equal(result.plan.edgeSource, "UNRESOLVED");
  assert.ok(result.plan.qty * result.plan.limitPx <= 12);
  assert.ok(result.plan.risk.modeledMaximumLoss <= result.plan.risk.riskBudget);
  assert.equal(buildPolicyPlan({ ...input, allowPaperResearch: false }).plan, null);
  assert.equal(buildPolicyPlan({ ...input, equity: 1 }).plan, null);
  assert.equal(buildPolicyPlan({ ...input, features: { ...input.features, stale: true } }).plan, null);
});

test("promoted model plans reject expiry, changed costs, spread expansion and negative cost-adjusted edge", () => {
  const c = cfg.symbolConfigs["BTC/USD"]!;
  const rows = data(() => 100, policyReserveBps(c)).map((o) => ({ ...o, configurationVersion: c.configurationVersion }));
  const model = evaluatePolicies(rows, c.configurationVersion, now).models[0]!;
  assert.ok(model);
  const input = { config: c, book: book(now), features: features(now), asset,
    candidate: policyCandidates(features(now))[0]!, policyId: model.policyId, model, allowPaperResearch: false,
    equity: 100_000, equityHighWater: 100_000, nowMs: now };
  assert.ok(buildPolicyPlan(input).plan);
  assert.equal(buildPolicyPlan({ ...input, model: { ...model, expiresAtMs: now } }).plan, null);
  assert.equal(buildPolicyPlan({ ...input, model: { ...model, feeBps: model.feeBps + 1 } }).plan, null);
  assert.equal(buildPolicyPlan({ ...input, features: { ...input.features, spreadBps: 2 } }).plan, null);
  assert.equal(buildPolicyPlan({ ...input, model: { ...model, lowerNetBps: .01 } }).plan, null);
});

for (const symbol of ["BTC/USD", "ETH/USD"]) for (const side of [1, -1] as const) {
  test(`brief ${symbol} ${side === 1 ? "long" : "short"} signal between samples submits, fills and exits with all gates intact`, async () => {
    let clockMs = Date.now();
    const firstQuoteMs = clockMs;
    const broker = new KrakenPaperBroker({ initialEquity: 100_000,
      productsBySymbol: { [symbol]: "TEST" }, instruments: new Map([[symbol, { symbol, productId: "TEST",
        tickSize: .001, quantityIncrement: .001, maximumOrderQty: 100 }]]),
      makerFeeBpsBySymbol: { [symbol]: 2 }, takerFeeBpsBySymbol: { [symbol]: 5 } });
    const engine = new TradingEngine(cfg, { rest: broker, gateway: broker, tradeStream: broker.tradeStream, now: () => clockMs });
    const internals = engine as unknown as {
      equity: number; equityHighWater: number;
      portfolio: { canAdd: (...args: unknown[]) => boolean };
      riskState: { setHealth: (health: Record<string, boolean>) => void };
      runtimes: Map<string, { config: SymbolConfig; asset: AssetRules; latestFeatures: DeterministicFeatures;
        book: { apply: (delta: unknown) => void }; liquidity: { observe: (spread: number) => void };
        entryEngine: { evaluate: () => never } }>;
      processMarketState: (runtime: unknown, b: BookState, f: DeterministicFeatures, quoteEvent?: boolean) => void;
    };
    internals.equity = internals.equityHighWater = 100_000;
    internals.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, riskRecomputed: true });
    const feed = (b: BookState) => ({ symbol: b.symbol, bids: [...b.bids], asks: [...b.asks], reset: true,
      exchangeTsMs: b.exchangeTsMs, receiveTsMs: b.receiveTsMs, sourceId: `book-${b.receiveTsMs}` });
    for (const [s, runtime] of internals.runtimes) {
      runtime.asset = { ...asset, symbol: s };
      runtime.latestFeatures = features(clockMs, side, 100, s);
      runtime.book.apply(feed(book(clockMs, 100, s)));
      for (let i = 0; i <= cfg.dynamicLiquidity.minimumSamples; i++) runtime.liquidity.observe(1);
      runtime.entryEngine.evaluate = () => { throw new Error("Legacy forecast path must not run"); };
    }
    const runtime = internals.runtimes.get(symbol)!;
    const decisions: ExecutionPlan[] = [];
    const observations: PolicyObservation[] = [];
    const researchEpisodes: EpisodeObservation[] = [];
    const evaluations: Array<{ reason: string }> = [];
    engine.on("decision", ({ plan }: { plan: ExecutionPlan }) => decisions.push(plan));
    engine.on("policyObservation", (o: PolicyObservation) => observations.push(o));
    engine.on("researchEpisode", (o: EpisodeObservation) => researchEpisodes.push(o));
    engine.on("policyEntryEvaluated", (e: { reason: string }) => evaluations.push(e));
    try {
      internals.processMarketState(runtime, book(clockMs, 100, symbol), {
        ...features(clockMs, side, 100, symbol), trendSlowBps: 0, trendMediumBps: 0,
        trendFastBps: 0, velocityZ: 0, impulseBps: 0, breakoutUpBps: 0, breakoutDownBps: 0 });
      clockMs += 30_000;
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol), false);
      assert.equal(decisions.length, 0, "trade-only events must not trigger entries");
      internals.processMarketState(runtime, book(clockMs - 2_000, 100, symbol), features(clockMs - 2_000, side, 100, symbol));
      assert.equal(evaluations.at(-1)?.reason, "POLICY_QUOTE_NOT_CURRENT");
      internals.riskState.setHealth({ privateStream: false });
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      assert.equal(evaluations.at(-1)?.reason, "HEALTH_GATE");
      assert.equal(decisions.length, 0, "health gates remain mandatory");
      internals.riskState.setHealth({ privateStream: true });
      const illiquid = { ...features(clockMs, side, 100, symbol), depthZ: -100 };
      internals.processMarketState(runtime, book(clockMs, 100, symbol), illiquid);
      assert.equal(decisions.length, 0, "liquidity failures must not be bypassed");
      assert.equal(evaluations.at(-1)?.reason, "DEPTH_Z_BELOW_LIMIT");
      assert.equal(engine.state().markets.find((m) => m.symbol === symbol)!.policyPulse!.status, "LIQUIDITY_BLOCKED");
      const reports = evaluations.length;
      internals.processMarketState(runtime, book(clockMs, 100, symbol), illiquid);
      assert.equal(evaluations.length, reports, "repeated identical rejects are telemetry-deduplicated, not execution-throttled");
      const originalConfig = runtime.config;
      runtime.config = { ...originalConfig, planner: { ...originalConfig.planner,
        hybridEntry: { ...originalConfig.planner.hybridEntry, allowAnalyticPaperExecution: false } } };
      clockMs += 1; // A distinct fresh quote after liquidity recovers.
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      assert.equal(evaluations.at(-1)?.reason, "POLICY_NOT_PROMOTED", "calibrated-only mode must not acquire unscored orders");
      runtime.config = originalConfig;
      internals.equity = 1;
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      assert.equal(evaluations.at(-1)?.reason, "POLICY_RISK_SIZE_BLOCK");
      internals.equity = 100_000;
      const canAdd = internals.portfolio.canAdd;
      internals.portfolio.canAdd = () => false;
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      assert.equal(evaluations.at(-1)?.reason, "PORTFOLIO_CAPACITY_BLOCK");
      internals.portfolio.canAdd = canAdd;
      assert.equal(decisions.length, 0, "model permission, sizing and portfolio failures cannot dispatch orders");
      assert.equal(observations.filter((o) => o.sampling === "ENTRY").length, 0, "blocked plans must not be labeled as attempts");
      assert.ok(researchEpisodes.some((o) => o.sampling === "EPISODE"), "research can collect without a dispatchable plan");
      clockMs += 1;
      broker.onBook(feed(book(clockMs, 100, symbol)));
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(decisions.length, 1);
      assert.equal(engine.state().positions[0]?.side, side);
      assert.equal(engine.state().positions[0]?.policy?.id, decisions[0]!.policy!.id);
      assert.equal(decisions[0]!.edgeSource, "UNRESOLVED");
      const pulse = engine.state().markets.find((m) => m.symbol === symbol)!.policyPulse!;
      assert.equal(pulse.status, "POSITION_OPEN");
      assert.equal(pulse.lastSample!.atMs, firstQuoteMs, "entry must not wait for the next periodic sample");
      assert.equal(pulse.entryCounters.plansApproved, 1);
      const labels = observations.filter((o) => o.sampling === "ENTRY");
      assert.equal(labels.length, 2, "the entry quote must have both family exit variants");
      assert.ok(labels.every((o) => o.signalAtMs === clockMs && o.qty === decisions[0]!.qty));
      assert.equal(pulse.lastEvaluation!.policyId, decisions[0]!.policy!.id);
      assert.equal(pulse.lastEvaluation!.reason, "POLICY_PAPER_EXPERIMENT");
      assert.equal(pulse.activePolicyId, decisions[0]!.policy!.id);
      const recovered = recoverPolicyPositions(broker.history(), (await broker.listPositions()).data, []);
      assert.equal(recovered.length, 1, "policy survives a missing first DB position snapshot");
      assert.deepEqual(recovered[0]!.policy, decisions[0]!.policy);
      const supplied = { ...recovered[0]!, mfePx: .2 };
      assert.deepEqual(recoverPolicyPositions(broker.history(), (await broker.listPositions()).data, [supplied]), [supplied]);
      clockMs += 1_000;
      const exitMid = 100 + side * 2;
      broker.onBook(feed(book(clockMs, exitMid, symbol)));
      internals.processMarketState(runtime, book(clockMs, exitMid, symbol), features(clockMs, side, exitMid, symbol));
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(engine.state().positions.length, 0);
      assert.ok(engine.state().realizedSessionPnl > 0, "synthetic favorable paths must realize fee-adjusted profit");
      assert.equal(engine.state().orders.length, 2);
      assert.equal(engine.state().orders[1]?.plan.exitReason, "POLICY_TARGET");
      clockMs += 60_000;
      internals.processMarketState(runtime, book(clockMs, exitMid, symbol), features(clockMs, side, exitMid, symbol));
      assert.equal(decisions.length, 1, "paper experiment rate limit survives the exit");
      clockMs += 1;
      internals.processMarketState(runtime, book(clockMs, 100, symbol), features(clockMs, side, 100, symbol));
      assert.ok(researchEpisodes.some((o) => o.signalAtMs === clockMs && o.context.cooldownRemainingMs > 0),
        "distinct shadow episodes must be collected before the execution cooldown gate");
      assert.equal(decisions.length, 1, "shadow collection never submits an additional order");
      assert.ok(engine.state().markets.find((m) => m.symbol === symbol)!.policyPulse!.research!.counters.episodes! >= 2);
    } finally { await engine.stop(); }
  });
}
