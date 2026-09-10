import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadConfig, type EngineConfig } from "../src/config.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { BookState } from "../src/core/market.js";
import type { LocalOrderBook } from "../src/core/order-book.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import type { OrderStateReconciler, PrivateOrderEvent } from "../src/execution/order-state.js";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import { newLinearLedger, recordLinearFill } from "../src/economics/net-liquidation.js";
import type { Position } from "../src/strategy/position-manager.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { VenuePosition } from "../src/venue/types.js";
import { SYSTEMATIC_SPEC as S, type SystematicPositionSpec } from "../src/systematic/spec.js";

const symbol = "BTC/USD", initialTime = 1_800_000_000_000;
function spec(): SystematicPositionSpec {
  return { version: S.version, signalId: "synthetic-lifecycle-fixture", signalBarCloseMs: initialTime - S.barMs,
    stopBps: 200, targetBps: 400, trailingBps: 200, trailActivationR: 1,
    maximumHoldMs: S.maximumHoldMs, feeBps: 5, fundingReserveBps: 9 };
}
function plan(id: string, atMs = initialTime): ExecutionPlan {
  return { clientOrderId: id, decisionId: id, riskApprovalId: id, symbol, side: 1, qty: 1,
    limitPx: 100, style: "taker", timeInForce: "ioc", createdMs: atMs, expiresMs: atMs + S.entryTtlMs,
    originatingSequence: 1n, featureHash: "synthetic-fixture", strategyVersion: S.version,
    modelVersion: "unestimated-systematic-paper", systematic: spec(),
    expectedCost: { roundTripBps: 19, spreadBps: 0, feeBps: 10, impactBps: 0,
      latencyBps: 0, adverseSelectionBps: 0, fundingBps: 9, borrowBps: 0 },
    risk: { qty: 1, riskBudget: 100, maximumLossPerUnit: 2.19, modeledMaximumLoss: 2.19,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: 0, expectedValue: 0, reduceOnlyIntent: false, economicHorizonMs: S.maximumHoldMs,
    researchOnly: true, executionPath: "TAKER_TAKER" };
}
interface Runtime {
  book: LocalOrderBook; asset: AssetRules; position?: Position; latestFeatures: DeterministicFeatures;
  reentryBlockedUntilMs?: number;
  regimeEngine: { classify: (...args: never[]) => unknown };
  holdEngine: { evaluate: (...args: never[]) => unknown };
  cost: { estimate: (...args: never[]) => unknown };
}
interface Internals {
  equity: number; equityHighWater: number; runtimes: Map<string, Runtime>; orderState: OrderStateReconciler;
  riskState: { setHealth: (health: Record<string, boolean>) => void };
  restoredPositionCandidates: Map<string, Position[]>;
  submit: (plan: ExecutionPlan) => Promise<boolean>;
  onPrivateEvent: (event: PrivateOrderEvent) => void;
  reconcilePositions: (positions: readonly VenuePosition[]) => void;
  evaluatePosition: (runtime: Runtime, book: BookState, f: DeterministicFeatures) => {
    nowMs: number; decision: { action: string; reason?: string } };
  submitExit: (runtime: Runtime, qty: number, reason: string, book: BookState,
    f: DeterministicFeatures, forcedStyle?: "maker" | "taker") => Promise<void>;
}
function fixture(t: TestContext, patch: Partial<EngineConfig> = {}) {
  let nowMs = initialTime;
  const cfg = { ...loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", MODEL_ONLY_ENTRIES: "false" }),
    continuousRecordingEnabled: false, distributionalEngineEnabled: false, distributionalPaperTrialEnabled: false,
    distributionalEfficientTrainingEnabled: false, distributionalRegimeModelEnabled: false,
    policyEngineEnabled: false, ...patch };
  const broker = new KrakenPaperBroker({ initialEquity: 100_000,
    productsBySymbol: { [symbol]: "PF_XBTUSD" }, instruments: new Map([[symbol, { symbol,
      productId: "PF_XBTUSD", tickSize: .01, quantityIncrement: .001, maximumOrderQty: 10 }]]),
    makerFeeBpsBySymbol: { [symbol]: 2 }, takerFeeBpsBySymbol: { [symbol]: 5 } });
  const engine = new TradingEngine(cfg, { rest: broker, gateway: broker, tradeStream: broker.tradeStream, now: () => nowMs });
  const internal = engine as unknown as Internals, runtime = internal.runtimes.get(symbol)!;
  internal.equity = internal.equityHighWater = 100_000;
  internal.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true,
    bookValid: true, clockValid: true, riskRecomputed: true });
  runtime.asset = { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01,
    maximumOrderQty: 10, shortable: true };
  t.mock.method(runtime.regimeEngine, "classify", () => ({ name: "TREND", allowLong: true, allowShort: true }));
  t.mock.method(runtime.holdEngine, "evaluate", () => ({ holdLowerBoundBps: -500, reversalScore: 1, exitEvidence: true }));
  t.mock.method(runtime.cost, "estimate", () => plan("cost").expectedCost);
  const update = (atMs: number, bid = 99.98, ask = 100, qty = 10) => {
    nowMs = atMs;
    const delta = { symbol, bids: [{ px: bid, qty }], asks: [{ px: ask, qty }], reset: true,
      exchangeTsMs: atMs, receiveTsMs: atMs, sourceId: `fixture-${atMs}` };
    runtime.book.apply(delta);
    runtime.latestFeatures = { symbol, mid: (bid + ask) / 2, spread: ask - bid,
      sigmaHBps: 1, stale: false, receiveTsMs: atMs } as DeterministicFeatures;
    broker.onBook(delta);
    return runtime.book.snapshot();
  };
  update(nowMs);
  const sent = t.mock.method(broker, "send");
  t.after(async () => { delete runtime.position; await engine.stop(); });
  return { engine, internal, runtime, broker, sent, update, now: () => nowMs };
}

for (const patch of [{}, { modelOnlyEntries: true }, { distributionalEngineEnabled: true,
  distributionalPaperEntriesEnabled: true }, { policyEngineEnabled: true }]) {
  test(`systematic production dispatch requires economic acceptance independent of config ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, patch), reasons: string[] = [];
    f.engine.on("entryBlocked", (event: { reason: string }) => reasons.push(event.reason));
    const original = plan("profit-unproven");
    const { systematic, ...withoutMetadata } = original;
    for (const markers of [{ systematic }, { systematicDecision: { paperReady: true } },
      { strategyVersion: S.version }, { modelVersion: "unestimated-systematic-paper" }]) {
      const candidate = { ...withoutMetadata, strategyVersion: "other", modelVersion: "other",
        expectedValue: 1_000_000, researchOnly: false, ...markers } as ExecutionPlan;
      assert.equal(await f.internal.submit(candidate), false);
      assert.equal(reasons.at(-1), "SYSTEMATIC_PROFITABILITY_NOT_VALIDATED");
    }
    assert.equal(f.sent.mock.callCount(), 0);
    assert.equal(f.internal.orderState.all().length, 0, "a rejected candidate must not reserve risk");
  });
}

test("systematic engine recovery retains EXITING and the six-hour cooldown when reconciliation sees flat", async t => {
  const f = fixture(t), ledger = newLinearLedger(1); recordLinearFill(ledger, 1, 100, .05, false);
  const p: Position = { symbol, side: 1, qty: 1, entryPx: 100, openedMs: initialTime - 1_000,
    initialRiskPx: 2, roundTripCostPx: .19, mfePx: 3, maePx: 0, floorPx: 1,
    breakEvenArmed: false, phase: "EXITING", systematic: spec(), ledger };
  assert.equal(f.engine.restorePositionStates([p]), 1);
  assert.equal(f.internal.restoredPositionCandidates.get(symbol)![0]!.phase, "EXITING");
  const remote = { symbol, side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition;
  f.internal.reconcilePositions([remote]);
  assert.equal(f.runtime.position!.phase, "EXITING");
  const b = f.update(initialTime + 100, 103, 103.02);
  assert.equal(f.internal.evaluatePosition(f.runtime, b, f.runtime.latestFeatures).decision.reason, "SYSTEMATIC_EXIT_LATCHED");
  f.internal.reconcilePositions([]);
  assert.equal(f.runtime.reentryBlockedUntilMs, f.now() + S.reentryCooldownMs);
});

test("systematic partial fills retain actual fee and timing; protective exits stay executable while new entries are blocked", async t => {
  const f = fixture(t), entry = plan("existing-fixture-exposure");
  // Direct broker submission represents pre-existing paper exposure; the
  // production entry gate above remains closed and is never bypassed in runtime.
  f.internal.orderState.reserve(entry);
  const remote = await f.broker.send(entry);
  f.internal.orderState.markAccepted(entry.clientOrderId, remote.id, initialTime);
  f.update(initialTime + 250, 99.98, 100, .4);
  const p = f.runtime.position!;
  assert.equal(p.openedMs, initialTime + 250); assert.deepEqual(p.systematic, spec());
  assert.equal(p.qty, .4); assert.equal(p.ledger!.entryFees, .02);
  assert.equal(p.initialRiskPx, 2); assert.equal(p.ledger!.fundingEvidence, "UNOBSERVED");
  p.executionPath = "MAKER_TAKER";
  const stop = f.update(initialTime + 500, 98, 98.02);
  assert.equal(f.internal.evaluatePosition(f.runtime, stop, f.runtime.latestFeatures).decision.reason, "SYSTEMATIC_STOP");
  const exits: ExecutionPlan[] = [];
  f.engine.on("exitDecision", (value: { plan: ExecutionPlan }) => exits.push(value.plan));
  await f.internal.submitExit(f.runtime, p.qty, "SYSTEMATIC_STOP", stop, f.runtime.latestFeatures, "maker");
  assert.equal(exits.length, 1); assert.equal(exits[0]!.style, "taker");
  assert.equal(exits[0]!.reduceOnlyIntent, true); assert.deepEqual(exits[0]!.systematic, spec());
  assert.equal(exits[0]!.createdMs, stop.receiveTsMs);
  assert.equal(exits[0]!.expiresMs, stop.receiveTsMs + S.entryTtlMs);
  assert.equal((await f.broker.listPositions()).data.length, 1, "protective exits still wait for arrival");
  f.update(initialTime + 750, 98, 98.02);
  assert.equal(f.runtime.position, undefined); assert.equal((await f.broker.listPositions()).data.length, 0);
  assert.equal(f.runtime.reentryBlockedUntilMs, f.now() + S.reentryCooldownMs);
  assert.ok(Math.abs(f.engine.state().realizedSessionPnl - (-.8 - .02 - .4 * 98 * .0005)) < 1e-9);
});

test("systematic exit decisions use full executable depth and the quote timestamp", async t => {
  const f = fixture(t), ledger = newLinearLedger(1); recordLinearFill(ledger, 1, 100, .05, false);
  f.runtime.position = { symbol, side: 1, qty: 1, entryPx: 100, openedMs: initialTime,
    initialRiskPx: 2, roundTripCostPx: .19, mfePx: 0, maePx: 0, floorPx: -2,
    breakEvenArmed: false, phase: "OPEN", systematic: spec(), ledger };
  const b = f.update(initialTime + 500, 100, 100.02);
  b.bids = [{ px: 100, qty: .01 }, { px: 97.5, qty: 10 }];
  const result = f.internal.evaluatePosition(f.runtime, b, f.runtime.latestFeatures);
  assert.equal(result.decision.reason, "SYSTEMATIC_STOP", "a profitable best bid cannot hide a losing full-position exit");
  assert.equal(result.nowMs, b.receiveTsMs);
});

test("systematic split entry fills retain the first timestamp and rebase stop dollars to the observed entry VWAP", t => {
  const f = fixture(t), entry = plan("split-entry-event-fixture");
  f.internal.orderState.reserve(entry);
  f.internal.onPrivateEvent({ id: "first-partial", event: "partial_fill", orderId: "fixture-order",
    clientOrderId: entry.clientOrderId, symbol, filledQty: .4, eventQty: .4, eventPx: 100,
    timestampMs: initialTime + 250, positionQty: .4, feeUsd: .02 });
  f.internal.onPrivateEvent({ id: "final-partial", event: "fill", orderId: "fixture-order",
    clientOrderId: entry.clientOrderId, symbol, filledQty: 1, eventQty: .6, eventPx: 102,
    timestampMs: initialTime + 300, positionQty: 1, feeUsd: .0306 });
  const p = f.runtime.position!;
  assert.equal(p.openedMs, initialTime + 250);
  assert.ok(Math.abs(p.entryPx - 101.2) < 1e-10);
  assert.ok(Math.abs(p.initialRiskPx - 2.024) < 1e-10);
  assert.ok(Math.abs(p.ledger!.entryFees - .0506) < 1e-10);
  assert.equal(p.systematic!.stopBps, 200);
  assert.equal(f.sent.mock.callCount(), 0, "fill-event accounting tests never submit new exposure");
});
