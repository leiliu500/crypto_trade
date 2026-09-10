import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { TradingEngine, type EngineDependencies } from "../src/engine/trading-engine.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { PrivateOrderEvent } from "../src/execution/order-state.js";
import type { KrakenPaperHistory } from "../src/kraken/paper-broker.js";
import { newPaperFundingState, observePaperFundingFill, observePaperFundingRates, paperFundingSnapshot,
  postPaperFunding, type PaperFundingState } from "../src/kraken/paper-funding.js";
import type { RollingRealizedPnlLedger } from "../src/risk/rolling-pnl.js";
import type { RiskState } from "../src/risk/risk-state.js";
import type { VenueOrder, VenuePosition } from "../src/venue/types.js";
import type { BookDelta } from "../src/core/order-book.js";

const T = Date.UTC(2026, 8, 9), H = 3_600_000, SYMBOL = "BTC/USD";
const near = (actual: number | null | undefined, expected: number) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function plan(id: string, side: 1 | -1, atMs: number, reduce = false): ExecutionPlan {
  return { clientOrderId: id, symbol: SYMBOL, side, qty: 1, createdMs: atMs, expiresMs: atMs + 1000,
    reduceOnlyIntent: reduce, style: "taker", timeInForce: "ioc", limitPx: 101,
    risk: { maximumLossPerUnit: 1, modeledMaximumLoss: 1 }, expectedCost: { roundTripBps: 0 },
    originatingSequence: 1n, strategyVersion: "test", modelVersion: "test" } as ExecutionPlan;
}
function fundingContext(state: PaperFundingState, asOfMs: number): NonNullable<KrakenPaperHistory["funding"]> {
  const snapshot = paperFundingSnapshot(state, asOfMs);
  return { state, priorHistoryFundingUnknown: false, snapshot: { ...snapshot, priorHistoryFundingUnknown: false,
    lifetimeFundingAccountingKnown: snapshot.fundingAccountingKnown } };
}
function accountFixture() {
  let now = T, cash = 100_000, qty = 0;
  let funding = newPaperFundingState({ startedAtMs: T, productsBySymbol: { [SYMBOL]: "PF_XBTUSD" } });
  const h = { orders: [] as Array<KrakenPaperHistory["orders"][number]>,
    activities: [] as Array<KrakenPaperHistory["activities"][number]>, makerFeeBpsBySymbol: {}, takerFeeBpsBySymbol: {} };
  const fill = (p: ExecutionPlan, price: number, fee = .1) => {
    const remote = { id: `remote-${p.clientOrderId}`, client_order_id: p.clientOrderId,
      symbol: SYMBOL, side: p.side === 1 ? "buy" : "sell", qty: "1", filled_qty: "1",
      filled_avg_price: String(price), status: "filled", updated_at: new Date(now).toISOString() } as VenueOrder;
    h.orders.push({ plan: p, remote });
    const id = `fill-${p.clientOrderId}`;
    h.activities.unshift({ id, activity_type: "FILL", order_id: remote.id, symbol: SYMBOL,
      qty: "1", price: String(price), fee_usd: String(fee), transaction_time: new Date(now).toISOString() });
    funding = observePaperFundingFill(funding, { id, symbol: SYMBOL, occurredAtMs: now, side: p.side, qty: 1 }, now);
    if (p.reduceOnlyIntent) cash += price - 100;
    cash -= fee; qty += p.side;
    return remote;
  };
  const fund = () => {
    funding = observePaperFundingRates(funding, [{ id: "hour-rate", symbol: SYMBOL, productId: "PF_XBTUSD",
      effectiveFromMs: T, effectiveToMs: T + H, knownAtMs: now,
      absoluteUsdPerBasePerHour: 2, sourceResponseSha256: "a".repeat(64) }], now);
    const posted = postPaperFunding(funding, now); funding = posted.state;
    cash += posted.postings.reduce((sum, posting) => sum + posting.cashDeltaUsd, 0);
    return posted.postings;
  };
  return { h, fill, fund, setNow: (value: number) => { now = value; }, now: () => now, cash: () => cash,
    funding: (atMs = now) => fundingContext(funding, atMs),
    positions: () => qty === 0 ? [] : [{ symbol: SYMBOL, side: "long", qty: String(qty), avg_entry_price: "100" } as VenuePosition] };
}
interface Internals {
  rollingPnlLedger: RollingRealizedPnlLedger;
  riskState: RiskState;
  submit(plan: ExecutionPlan): Promise<boolean>;
  clearOrderDeadline(id: string): void;
  onPrivateEvent(event: PrivateOrderEvent): void;
  onBook(delta: BookDelta): void;
}
function engineFixture(account: ReturnType<typeof accountFixture>, options: {
  now?: () => number;
  paperHistory?: () => KrakenPaperHistory;
  paperFunding?: NonNullable<EngineDependencies["paperFunding"]>;
} = {}) {
  const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", POLICY_ENGINE_ENABLED: "false",
    DISTRIBUTIONAL_ENGINE_ENABLED: "false", MODEL_ONLY_ENTRIES: "false", CONTINUOUS_RECORDING_ENABLED: "false", DATABASE_REQUIRED: "false" });
  const sent: ExecutionPlan[] = [], errors: unknown[] = [], fundingCalls: number[] = [];
  const stream = Object.assign(new EventEmitter(), { connect() {}, close() {} });
  const asset = (symbol: string) => ({ symbol, tradable: true, shortable: true, min_order_size: ".0001",
    min_trade_increment: ".0001", price_increment: ".1", maximum_order_qty: "1000" });
  const deps: EngineDependencies = { now: options.now ?? account.now,
    paperHistory: options.paperHistory ?? (() => ({ ...account.h, funding: account.funding() })),
    paperFunding: asOfMs => { fundingCalls.push(asOfMs); return (options.paperFunding ?? account.funding)(asOfMs); },
    tradeStream: stream,
    rest: {
      getAccount: async () => ({ data: { equity: String(account.cash()), cash: String(account.cash()),
        account_blocked: false, trading_blocked: false } }),
      listAssets: async () => ({ data: cfg.symbols.map(asset) }), getAsset: async (s: string) => ({ data: asset(s) }),
      listOrders: async () => ({ data: [] }), listPositions: async () => ({ data: account.positions() }),
      getPortfolioHistory: async () => ({ data: { profit_loss: [9999] } }),
      getActivities: async () => ({ data: account.h.activities }),
      getOrder: async (id: string) => ({ data: account.h.orders.find(o => o.remote.id === id)?.remote }),
    } as unknown as NonNullable<EngineDependencies["rest"]>,
    gateway: { send: async p => { sent.push(p); return { id: `remote-${p.clientOrderId}` } as VenueOrder; },
      cancel: async () => undefined, cancelAll: async () => undefined } };
  const engine = new TradingEngine(cfg, deps); engine.on("engineError", error => errors.push(error));
  (engine as unknown as Internals).riskState.setHealth({ publicStream: true, privateStream: true, bookValid: true });
  return { engine, internal: engine as unknown as Internals, stream, sent, errors, fundingCalls };
}
function closedAccount() {
  const a = accountFixture();
  a.setNow(T + H / 4); a.fill(plan("entry", 1, a.now()), 100);
  a.setNow(T + 3 * H / 4); a.fill(plan("exit", -1, a.now(), true), 101);
  a.setNow(T + H); return a;
}

test("engine reconciles funded cash with exact price P&L and fees without counting settlement twice", async () => {
  const a = closedAccount(); assert.equal(a.fund().length, 1);
  const { engine, errors } = engineFixture(a);
  assert.equal(await engine.reconcileAccount(), true, String(errors));
  for (let i = 0; i < 3; i++) {
    const state = engine.state(), pnl = state.rollingPnlDetails!;
    near(pnl.realizedPricePnl24hUsd, 1); near(pnl.fees24hUsd, .2); near(pnl.fundingCash24hUsd, -1);
    near(state.realizedPnl24h, -.2); near(state.realizedSessionPnl, -.2); near(state.equity, 99_999.8);
    assert.equal(pnl.fundingIncluded, true); assert.equal(pnl.retainedFillEvents, 2);
    assert.deepEqual(a.fund(), []); assert.equal(await engine.reconcileAccount(), true);
  }
  near(a.cash(), 99_999.8); assert.deepEqual(errors, []);
});

test("a funding event reconciles newly posted account cash and clears recoverable funding uncertainty", { timeout: 2000 }, async () => {
  const a = closedAccount(), { engine, stream } = engineFixture(a);
  assert.equal(await engine.reconcileAccount(), false);
  const before = engine.state(); near(before.equity, 100_000.8);
  assert.equal(before.realizedPnl24h, null); near(before.rollingPnlDetails!.fees24hUsd, .2);
  a.fund(); const reconciled = once(engine, "reconciled"); stream.emit("funding", { source: "PAPER_MODEL" });
  await reconciled;
  const after = engine.state(); near(after.equity, 99_999.8); near(after.realizedPnl24h, -.2);
  assert.equal(after.risk.health.accountReconciled, true);
  assert.ok(!after.risk.reasons.includes("ACCOUNT_UNKNOWN"));
});

test("missing funding blocks new risk but allows an exit and preserves valid incremental fill accounting", async () => {
  const a = accountFixture(); a.setNow(T + H / 4); a.fill(plan("entry", 1, a.now()), 100); a.setNow(T + H);
  const { engine, internal, sent } = engineFixture(a);
  assert.equal(await engine.reconcileAccount(), false);
  assert.equal(await internal.submit(plan("new-risk", 1, a.now())), false);
  const exit = plan("safe-exit", -1, a.now(), true);
  assert.equal(await internal.submit(exit), true); internal.clearOrderDeadline(exit.clientOrderId);
  assert.deepEqual(sent.map(p => p.clientOrderId), ["safe-exit"]);
  a.fill(exit, 101);
  internal.onPrivateEvent({ id: "exit-event", event: "fill", orderId: "remote-safe-exit", clientOrderId: "safe-exit",
    symbol: SYMBOL, filledQty: 1, eventQty: 1, eventPx: 101, timestampMs: a.now(), positionQty: 0, feeUsd: .1 });
  let pnl = internal.rollingPnlLedger.snapshot(a.now());
  assert.equal(pnl.status, "UNKNOWN"); near(pnl.realizedPricePnl24hUsd, 1); near(pnl.fees24hUsd, .2);
  assert.equal(pnl.retainedFillEvents, 2); assert.match(pnl.reason!, /^PAPER_FUNDING_/);
  a.fund();
  pnl = engine.state().rollingPnlDetails!;
  assert.equal(pnl.status, "KNOWN"); near(pnl.netRealizedPnl24hUsd, -.7);
  assert.equal(engine.state().risk.health.accountReconciled, false, "new evidence requires account reconciliation before resuming");
  assert.equal(await engine.reconcileAccount(), true); near(engine.state().equity, 99_999.3);
});

test("funding callbacks and rolling snapshots share the exact operational snapshot clock", async () => {
  const a = accountFixture(); a.setNow(T + H); let clock = a.now();
  const { engine, fundingCalls } = engineFixture(a, { now: () => clock++ });
  assert.equal(await engine.reconcileAccount(), true);
  fundingCalls.length = 0;
  const state = engine.state();
  assert.equal(state.rollingPnlDetails!.asOfMs, state.generatedAtMs);
  assert.ok(fundingCalls.length > 0); assert.ok(fundingCalls.every(atMs => atMs === state.generatedAtMs));
  assert.equal(state.realizedPnlMeasurement, "KNOWN");
});

test("latest incomplete funding cannot be overwritten by final successful reconciliation health", async () => {
  const a = closedAccount(), missing = a.funding(); a.fund();
  const { engine } = engineFixture(a, { paperFunding: () => missing });
  assert.equal(await engine.reconcileAccount(), false);
  const state = engine.state(); assert.equal(state.realizedPnl24h, null);
  assert.equal(state.risk.health.accountReconciled, false); assert.equal(state.risk.health.riskRecomputed, false);
  near(state.rollingPnlDetails!.fees24hUsd, .2);
  assert.match(state.rollingPnlDetails!.reason!, /^PAPER_FUNDING_/);
});

test("a throwing funding snapshot cannot crash state or book callbacks, poison fills, or prevent a reduce-only exit", async () => {
  const a = accountFixture(); a.setNow(T + H / 4); a.fill(plan("entry", 1, a.now()), 100);
  a.setNow(T + H); a.fund(); let unavailable = false;
  const { engine, internal, sent, fundingCalls } = engineFixture(a, { paperFunding: atMs => {
    if (unavailable) throw new Error("PAPER_FUNDING_INVALID_CLOCK");
    return a.funding(atMs);
  } });
  assert.equal(await engine.reconcileAccount(), true);
  unavailable = true;
  assert.doesNotThrow(() => engine.state());
  let state = engine.state(); assert.equal(state.realizedPnl24h, null);
  assert.equal(state.risk.health.accountReconciled, false);
  assert.match(state.rollingPnlDetails!.reason!, /^PAPER_FUNDING_SNAPSHOT_UNAVAILABLE:/);
  near(state.rollingPnlDetails!.fees24hUsd, .1);
  fundingCalls.length = 0;
  assert.doesNotThrow(() => internal.onBook({ symbol: SYMBOL, bids: [{ px: 100, qty: 10 }],
    asks: [{ px: 101, qty: 10 }], reset: true, exchangeTsMs: a.now(), receiveTsMs: a.now(), sourceId: "funding-fault-book" }));
  assert.ok(fundingCalls.length > 0, "the book callback must exercise the failing funding source");
  assert.equal(await internal.submit(plan("blocked-entry", 1, a.now())), false);
  const exit = plan("clock-safe-exit", -1, a.now(), true);
  assert.equal(await internal.submit(exit), true); internal.clearOrderDeadline(exit.clientOrderId);
  assert.deepEqual(sent.map(p => p.clientOrderId), ["clock-safe-exit"]);
  a.fill(exit, 101);
  assert.doesNotThrow(() => internal.onPrivateEvent({ id: "clock-safe-exit-fill", event: "fill",
    orderId: "remote-clock-safe-exit", clientOrderId: "clock-safe-exit", symbol: SYMBOL,
    filledQty: 1, eventQty: 1, eventPx: 101, timestampMs: a.now(), positionQty: 0, feeUsd: .1 }));
  state = engine.state(); near(state.rollingPnlDetails!.realizedPricePnl24hUsd, 1);
  near(state.rollingPnlDetails!.fees24hUsd, .2); assert.equal(state.rollingPnlDetails!.retainedFillEvents, 2);
  unavailable = false; state = engine.state();
  assert.equal(state.realizedPnlMeasurement, "KNOWN"); near(state.realizedPnl24h, -.7);
  assert.equal(await engine.reconcileAccount(), true); near(engine.state().equity, 99_999.3);
});

test("an execution stream fault denies new risk before notification while preserving verified cash and exit access", async () => {
  const a = accountFixture(); a.setNow(T + H / 4); a.fill(plan("entry", 1, a.now()), 100);
  a.setNow(T + H); a.fund();
  const { engine, internal, stream, sent } = engineFixture(a);
  assert.equal(await engine.reconcileAccount(), true);
  let deniedBeforeNotification = false;
  engine.on("engineError", () => { deniedBeforeNotification = !engine.state().risk.health.accountReconciled; });
  stream.emit("streamError", new Error("PAPER_EXECUTION_RECOVERY_FAILED"));
  assert.equal(deniedBeforeNotification, true);
  const state = engine.state(); assert.ok(state.risk.reasons.includes("ACCOUNT_UNKNOWN"));
  assert.equal(state.realizedPnlMeasurement, "KNOWN"); near(state.realizedPnl24h, -1.6);
  assert.equal(await internal.submit(plan("blocked-stream-entry", 1, a.now())), false);
  const exit = plan("stream-safe-exit", -1, a.now(), true);
  assert.equal(await internal.submit(exit), true); internal.clearOrderDeadline(exit.clientOrderId);
  assert.deepEqual(sent.map(p => p.clientOrderId), ["stream-safe-exit"]);
});
