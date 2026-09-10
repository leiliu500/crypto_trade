import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadConfig, type SymbolConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { LocalOrderBook } from "../src/core/order-book.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import type { PolicyCollector } from "../src/research/policy-collector.js";
import { POLICY_VERSION } from "../src/research/trading-policy.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { Position } from "../src/strategy/position-manager.js";

const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
function features(book: BookState): DeterministicFeatures {
  const mid = (book.bids[0]!.px + book.asks[0]!.px) / 2;
  const pullback = { ready: false, structuralMoveBps: 100, pullbackDepthBps: 40, recoveryBps: 8,
    remainingRoomBps: 40, structuralExtremeAgeMs: 600_000, reversalExtremeAgeMs: 10_000 };
  return { symbol: book.symbol, mid, spread: .01, spreadBps: 1, microprice: mid, visibleDepth: 20,
    qi1: .5, qiK: .5, persistentQiK: .5, ofi: 1, tfi: 1, bidCancellationRatio: 0, askCancellationRatio: 0,
    replenishmentPressure: 0, velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: 1, accelerationZ: 0, efficiency: .8, cusumUp: true, cusumDown: false,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, stale: false, staleReason: null, receiveTsMs: book.receiveTsMs,
    microEdgeBps: 1, impulseBps: 2, breakoutUpBps: 2, breakoutDownBps: 0, anchorDistanceBps: 0,
    sigmaImpulseBps: 1, cusumUpScore: 1, cusumDownScore: 1, flowFlipRate: 0,
    usableDepthQty: 20, usableDepthNotional: 2_000, slowTrendReady: true,
    trendFastBps: 10, trendMediumBps: 20, trendSlowBps: 40, slowTrendAlignment: 1,
    slowTrendEfficiency: .6, slowVarianceRate: 1e-8, slowSigmaBps: 10,
    longPullback: { ...pullback }, shortPullback: { ...pullback } };
}
interface Runtime {
  config: SymbolConfig; asset: AssetRules; book: LocalOrderBook; latestFeatures: DeterministicFeatures;
  liquidity: { observe: (spread: number) => void }; policyCollector: PolicyCollector; position?: Position;
  entryEngine: { evaluate: (...args: never[]) => unknown };
}
interface Internals {
  distributional?: unknown; crossAssetModel?: unknown; equity: number; equityHighWater: number;
  runtimes: Map<string, Runtime>; riskState: { setHealth: (value: Record<string, boolean>) => void };
  processMarketState: (runtime: Runtime, book: BookState, features: DeterministicFeatures, quoteEvent?: boolean) => void;
  submit: (plan: ExecutionPlan) => Promise<boolean>;
}
function fixture(t: TestContext, policyEnabled = false) {
  let nowMs = Date.UTC(2026, 8, 10, 12);
  const cfg = { ...loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", DISTRIBUTIONAL_ENGINE_ENABLED: "false",
    DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "false", DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "false",
    DISTRIBUTIONAL_EFFICIENT_TRAINING_ENABLED: "false", DISTRIBUTIONAL_REGIME_MODEL_ENABLED: "false",
    POLICY_ENGINE_ENABLED: String(policyEnabled), CROSS_ASSET_PAPER_ENTRIES_ENABLED: "false",
    CROSS_ASSET_PAPER_EVALUATION_ENABLED: "false", MODEL_ONLY_ENTRIES: "true", PAPER_ENTRY_EXERCISE: "false",
    CONTINUOUS_RECORDING_ENABLED: "false", DATABASE_REQUIRED: "false" }), breakoutRetestEnabled: false };
  const broker = new KrakenPaperBroker({ initialEquity: 100_000, now: () => nowMs,
    productsBySymbol: { "BTC/USD": "BTC", "ETH/USD": "ETH" },
    instruments: new Map(SYMBOLS.map(symbol => [symbol, { symbol, productId: symbol,
      tickSize: .001, quantityIncrement: .001, maximumOrderQty: 100 }])),
    makerFeeBpsBySymbol: { "BTC/USD": 2, "ETH/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5, "ETH/USD": 5 } });
  const engine = new TradingEngine(cfg, { rest: broker, gateway: broker, tradeStream: broker.tradeStream, now: () => nowMs });
  const internal = engine as unknown as Internals;
  internal.equity = internal.equityHighWater = 100_000;
  internal.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true,
    bookValid: true, clockValid: true, riskRecomputed: true });
  const update = (symbol: string, advance = 0) => {
    nowMs += advance;
    const runtime = internal.runtimes.get(symbol)!;
    const delta = { symbol, bids: [{ px: 99.995, qty: 10 }], asks: [{ px: 100.005, qty: 10 }], reset: true,
      exchangeTsMs: nowMs, receiveTsMs: nowMs, sourceId: `disabled-model-${symbol}-${nowMs}` };
    runtime.book.apply(delta); broker.onBook(delta);
    const book = runtime.book.snapshot(); runtime.latestFeatures = features(book);
    return { runtime, book };
  };
  for (const [symbol, runtime] of internal.runtimes) {
    runtime.asset = { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001, maximumOrderQty: 100, shortable: true };
    update(symbol);
    for (let i = 0; i <= cfg.dynamicLiquidity.minimumSamples; i++) runtime.liquidity.observe(1);
    t.mock.method(runtime.entryEngine, "evaluate", () => { throw new Error("Unexpected legacy entry route"); });
  }
  const sent = t.mock.method(broker, "send");
  t.after(async () => { for (const runtime of internal.runtimes.values()) delete runtime.position; await engine.stop(); });
  return { cfg, broker, engine, internal, sent, update, now: () => nowMs };
}

test("disabled distribution and policy engines do not start fallback training or submit entries on fresh books", async t => {
  const f = fixture(t), emitted: string[] = [];
  for (const name of ["distributionalDecision", "distributionalSample", "distributionalSelection", "distributionalCheckpoint",
    "crossAssetForecast", "policyObservation", "policySignalEvaluated", "researchEpisode", "decision", "orderReserved", "orderSending"])
    f.engine.on(name, () => emitted.push(name));
  assert.equal(f.internal.distributional, undefined); assert.equal(f.internal.crossAssetModel, undefined);
  for (const step of [0, 250, 750, 60_000]) for (const symbol of SYMBOLS) {
    const { runtime, book } = f.update(symbol, step);
    f.internal.processMarketState(runtime, book, runtime.latestFeatures);
  }
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(emitted, []);
  assert.equal(f.sent.mock.callCount(), 0); assert.equal(f.broker.history().orders.length, 0);
  assert.equal(f.engine.exportDistributionalState(), null);
  for (const runtime of f.internal.runtimes.values()) assert.equal(runtime.policyCollector.lastSampleAtMs(), -Infinity);
  for (const market of f.engine.state().markets) { assert.equal(market.distributional, undefined); assert.equal(market.policyPulse, null); }
});

test("explicitly enabled policy research still collects fresh-book observations with paper entries disabled", async t => {
  const f = fixture(t, true), samples: unknown[] = [], evaluations: unknown[] = [];
  f.engine.on("policyObservation", event => samples.push(event));
  f.engine.on("policySignalEvaluated", event => evaluations.push(event));
  const { runtime, book } = f.update("BTC/USD");
  f.internal.processMarketState(runtime, book, runtime.latestFeatures);
  assert.ok(samples.length > 0, "a real collector must generate candidate observations for this fresh signal");
  assert.equal(evaluations.length, 1); assert.equal(runtime.policyCollector.lastSampleAtMs(), book.receiveTsMs);
  assert.equal(f.sent.mock.callCount(), 0);
});

function existingPlan(atMs: number): ExecutionPlan {
  return { clientOrderId: "recovered-entry-fixture", decisionId: "recovered-entry-fixture", riskApprovalId: "recovered-entry-fixture",
    symbol: "BTC/USD", side: 1, qty: .1, limitPx: 100.005, style: "taker", timeInForce: "ioc",
    createdMs: atMs, expiresMs: atMs + 1_000, originatingSequence: 1n, featureHash: "recovery-fixture",
    strategyVersion: POLICY_VERSION, modelVersion: "pre-existing-paper-position",
    policy: { version: POLICY_VERSION, id: "trend-15m", feeBps: 5, reserveBps: 2 },
    expectedCost: { roundTripBps: 12, spreadBps: 1, feeBps: 10, impactBps: 0,
      latencyBps: 0, adverseSelectionBps: 1, fundingBps: 0, borrowBps: 0 },
    risk: { qty: .1, riskBudget: 10, maximumLossPerUnit: 1, modeledMaximumLoss: .1,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: 1, expectedValue: .1, reduceOnlyIntent: false, researchOnly: true, executionPath: "TAKER_TAKER" };
}
test("disabled-model entry guards still reject new risk while allowing a funded recovered position to close", async t => {
  const f = fixture(t), plan = existingPlan(f.now()), runtime = f.internal.runtimes.get("BTC/USD")!;
  assert.equal(await f.internal.submit(plan), false); assert.equal(f.sent.mock.callCount(), 0);
  // A direct in-memory broker fill represents inventory acquired before the configuration switch.
  await f.broker.send(plan);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal((await f.broker.listPositions()).data.length, 1);
  runtime.position = { symbol: plan.symbol, side: 1, qty: plan.qty, entryPx: plan.limitPx, openedMs: f.now() - 60_000,
    initialRiskPx: 1, roundTripCostPx: .12, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER", policy: plan.policy! };
  f.internal.riskState.setHealth({ privateStream: false });
  const close: ExecutionPlan = { ...plan, clientOrderId: "recovered-position-close", side: -1,
    limitPx: 99.995, reduceOnlyIntent: true, exitReason: "POLICY_DEADLINE" };
  assert.equal(await f.internal.submit(close), true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal((await f.broker.listPositions()).data.length, 0);
  assert.equal(f.engine.state().positions.length, 0);
  assert.equal(f.sent.mock.callCount(), 2); assert.equal(f.sent.mock.calls[1]!.arguments[0].reduceOnlyIntent, true);
});
