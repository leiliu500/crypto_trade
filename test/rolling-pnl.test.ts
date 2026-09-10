import assert from "node:assert/strict";
import test from "node:test";
import { RollingRealizedPnlLedger, ROLLING_PNL_WINDOW_MS as DAY } from "../src/risk/rolling-pnl.js";
import type { KrakenPaperHistory } from "../src/kraken/paper-broker.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { VenueOrder, VenuePosition } from "../src/venue/types.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { loadConfig } from "../src/config.js";
import type { EngineDependencies } from "../src/engine/trading-engine.js";
import type { PrivateOrderEvent, OrderStateReconciler } from "../src/execution/order-state.js";

const T = Date.UTC(2023, 0, 3), H = 3_600_000;
export function plan(id: string, side: 1 | -1, qty: number, atMs: number, reduce = false): ExecutionPlan {
  return { clientOrderId: id, symbol: "BTC/USD", side, qty, createdMs: atMs, expiresMs: atMs + 1000,
    reduceOnlyIntent: reduce, style: "taker", timeInForce: "ioc", limitPx: 100,
    risk: { maximumLossPerUnit: 1, modeledMaximumLoss: qty }, expectedCost: { roundTripBps: 0 },
    originatingSequence: 1n, strategyVersion: "test", modelVersion: "test" } as ExecutionPlan;
}
function history(): { orders: KrakenPaperHistory["orders"][number][]; activities: KrakenPaperHistory["activities"][number][];
  makerFeeBpsBySymbol: Record<string, number>; takerFeeBpsBySymbol: Record<string, number> } {
  return { orders: [], activities: [], makerFeeBpsBySymbol: { "BTC/USD": 999 }, takerFeeBpsBySymbol: { "BTC/USD": 999 } };
}
function fill(h: ReturnType<typeof history>, p: ExecutionPlan, qty: number, price: number, fee: number, atMs: number, id?: string): void {
  let order = h.orders.find(o => o.plan.clientOrderId === p.clientOrderId);
  if (!order) { order = { plan: p, remote: { id: `remote-${p.clientOrderId}`, client_order_id: p.clientOrderId,
    symbol: p.symbol, side: p.side === 1 ? "buy" : "sell", qty: String(p.qty), filled_qty: "0", filled_avg_price: null } as VenueOrder }; h.orders.push(order); }
  const old = Number(order.remote.filled_qty), total = old + qty;
  order.remote.filled_avg_price = String((old * Number(order.remote.filled_avg_price ?? 0) + qty * price) / total);
  order.remote.filled_qty = String(total); order.remote.updated_at = new Date(atMs).toISOString();
  order.remote.status = total >= p.qty ? "filled" : "partially_filled";
  h.activities.unshift({ id: id ?? `fill-${h.activities.length}`, activity_type: "FILL", order_id: order.remote.id,
    symbol: p.symbol, qty: String(qty), price: String(price), fee_usd: String(fee), transaction_time: new Date(atMs).toISOString() });
}
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("trailing 24 hours crosses midnight independently of the UTC session and expires the left boundary", () => {
  const h = history(), entry = plan("entry", 1, 1, T - 25 * H), exit = plan("exit", -1, 1, T - H, true);
  fill(h, entry, 1, 100, 1, T - 25 * H); fill(h, exit, 1, 90, 2, T - H);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T + H, []), true);
  let s = ledger.snapshot(T + H); near(s.realizedPricePnl24hUsd, -10); near(s.fees24hUsd, 2); near(s.netRealizedPnl24hUsd, -12);
  near(s.utcSessionNetPnlUsd, 0); assert.equal(s.fundingIncluded, false);
  s = ledger.snapshot(T + 23 * H); near(s.netRealizedPnl24hUsd, 0); // Exit is exactly at excluded boundary.
});

test("entry fees are cash losses immediately, and midnight fills belong to the new session", () => {
  const h = history(); fill(h, plan("entry", 1, 2, T), 2, 100, 0.8, T);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), true);
  const s = ledger.snapshot(T); near(s.realizedPricePnl24hUsd, 0); near(s.netRealizedPnl24hUsd, -.8); near(s.utcSessionNetPnlUsd, -.8);
});

test("partial closes then additions use the remaining inventory's weighted average", () => {
  const h = history(); fill(h, plan("a", 1, 2, T), 2, 100, 0, T);
  fill(h, plan("b", -1, 1, T + 1, true), 1, 110, 0, T + 1);
  fill(h, plan("c", 1, 1, T + 2), 1, 200, 0, T + 2);
  fill(h, plan("d", -1, 2, T + 3, true), 2, 160, 0, T + 3);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T + 3, []), true);
  near(ledger.snapshot(T + 3).realizedPricePnl24hUsd, 30); // 10 + 2*(160-150).
});

test("same-timestamp newest-first activities replay in actual insertion order", () => {
  const h = history(); fill(h, plan("long", 1, 1, T), 1, 100, .1, T);
  fill(h, plan("close", -1, 1, T, true), 1, 102, .2, T);
  fill(h, plan("short", -1, 1, T), 1, 102, .3, T);
  fill(h, plan("cover", 1, 1, T, true), 1, 101, .4, T);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T, []), true);
  near(ledger.snapshot(T).netRealizedPnl24hUsd, 2);
});

test("all historical order totals expose truncated activities even if the missing trade is older than 24 hours", () => {
  const h = history(); fill(h, plan("entry", 1, 1, T - 3 * DAY), 1, 100, 1, T - 3 * DAY);
  fill(h, plan("exit", -1, 1, T - 2 * DAY, true), 1, 101, 1, T - 2 * DAY);
  h.activities = []; const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T, []), false);
  const s = ledger.snapshot(T); assert.equal(s.netRealizedPnl24hUsd, null); assert.match(s.reason!, /TRUNCATED/);
});

test("missing fee records cannot be replaced by the configured fee tier", () => {
  const h = history(); fill(h, plan("entry", 1, 1, T), 1, 100, 0, T);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), true);
  near(ledger.snapshot(T).fees24hUsd, 0); delete h.activities[0]!.fee_usd;
  assert.equal(ledger.restore(h, T), false); assert.match(ledger.snapshot(T).reason!, /RECORDED_FEE_MISSING/);
  const s = ledger.snapshot(T); near(s.realizedPricePnl24hUsd, 0); assert.equal(s.fees24hUsd, null);
  assert.equal(s.netRealizedPnl24hUsd, null); assert.equal(s.utcSessionNetPnlUsd, null);
  assert.equal(s.retainedMissingFeeEvents, 1); assert.equal(s.missingFeeEvents24h, 1);
  assert.equal(s.missingFeeEventsUtcSession, 1);
});

test("duplicate IDs, unmatched orders, inconsistent quantities and VWAP are rejected", () => {
  const original = history(); fill(original, plan("entry", 1, 1, T), 1, 100, 1, T);
  const mutations: Array<(h: ReturnType<typeof history>) => void> = [
    h => { h.activities.push({ ...h.activities[0]! }); },
    h => { h.orders.push(structuredClone(h.orders[0]!)); },
    h => { h.activities[0]!.order_id = "unknown"; },
    h => { h.orders[0]!.remote.filled_qty = ".5"; },
    h => { h.orders[0]!.remote.filled_avg_price = "101"; },
    h => { h.orders[0]!.remote.side = "sell"; },
    h => { h.activities[0]!.fee_usd = ""; },
    h => { h.activities[0]!.qty = "NaN"; },
  ];
  for (const change of mutations) { const h = structuredClone(original); change(h); const ledger = new RollingRealizedPnlLedger();
    assert.equal(ledger.restore(h, T), false); assert.equal(ledger.snapshot(T).netRealizedPnl24hUsd, null); }
});

test("future fills, undefined opening inventory and invalid reductions are unknown", () => {
  let h = history(); fill(h, plan("future", 1, 1, T), 1, 100, 1, T + 1);
  let ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), false);
  h = history(); fill(h, plan("orphan", -1, 1, T, true), 1, 100, 1, T);
  ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), false);
  h = history(); fill(h, plan("a", 1, 1, T), 1, 100, 0, T); fill(h, plan("b", -1, 1, T + 1), 1, 99, 0, T + 1);
  ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T + 1), false);
});

test("restart reconstruction verifies remaining quantity, side and entry average against remote positions", () => {
  const h = history(); fill(h, plan("entry", -1, 2, T), 2, 100, .2, T);
  const remote = { symbol: "BTCUSD", side: "short", qty: "2", avg_entry_price: "100" } as VenuePosition;
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T, [remote]), true);
  for (const patch of [{ qty: "1" }, { side: "long" }, { avg_entry_price: "101" }]) {
    assert.equal(ledger.restore(h, T, [{ ...remote, ...patch } as VenuePosition]), false);
    assert.equal(ledger.snapshot(T).netRealizedPnl24hUsd, null);
  }
  assert.equal(ledger.restore(h, T, []), false);
});

test("incremental exact fills and repeated reconciliation agree without double counting", () => {
  const h = history(), p = plan("entry", 1, 2, T); fill(h, p, 1, 100, .1, T);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), true);
  const partial = { plan: p, cumulativeFilledQty: 2, qty: 1, price: 110, feeUsd: .2, atMs: T + 1 };
  assert.equal(ledger.recordFill(partial, T + 1), true); near(ledger.snapshot(T + 1).netRealizedPnl24hUsd, -.3);
  assert.equal(ledger.recordFill(partial, T + 1), true); near(ledger.snapshot(T + 1).netRealizedPnl24hUsd, -.3);
  fill(h, p, 1, 110, .2, T + 1); const before = ledger.snapshot(T + 1);
  assert.equal(ledger.restore(h, T + 1), true); assert.deepEqual(ledger.snapshot(T + 1), before);
  assert.equal(ledger.recordFill({ ...partial, feeUsd: .4 }, T + 1), false);
  assert.equal(ledger.snapshot(T + 1).netRealizedPnl24hUsd, null);
});

test("partial-fill gaps and backwards clocks cannot masquerade as complete history", () => {
  const h = history(), p = plan("entry", 1, 3, T); fill(h, p, 1, 100, .1, T);
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T), true);
  assert.equal(ledger.recordFill({ plan: p, cumulativeFilledQty: 3, qty: 1, price: 101, feeUsd: .1, atMs: T + 1 }, T + 1), false);
  assert.match(ledger.snapshot(T + 1).reason!, /QUANTITY_GAP/);
  assert.equal(ledger.restore(h, T + 1), true); assert.equal(ledger.snapshot(T).status, "UNKNOWN");
});

test("a verified empty account is zero; an uninitialized ledger stays unknown", () => {
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.snapshot(T).netRealizedPnl24hUsd, null);
  assert.equal(ledger.restore(history(), T, []), true); near(ledger.snapshot(T).netRealizedPnl24hUsd, 0);
});

interface Internals {
  rollingPnlLedger: RollingRealizedPnlLedger;
  orderState: OrderStateReconciler;
  onPrivateEvent(event: PrivateOrderEvent): void;
  portfolioRealizedLoss24h(): number;
  submit(plan: ExecutionPlan): Promise<boolean>;
  clearOrderDeadline(id: string): void;
}
function engineFixture(h: ReturnType<typeof history>, options: { now?: () => number; equity?: number;
  positions?: () => VenuePosition[]; onPositions?: (call: number) => void } = {}) {
  const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", POLICY_ENGINE_ENABLED: "false",
    DISTRIBUTIONAL_ENGINE_ENABLED: "false", MODEL_ONLY_ENTRIES: "false", CONTINUOUS_RECORDING_ENABLED: "false", DATABASE_REQUIRED: "false" });
  const sent: ExecutionPlan[] = [], errors: unknown[] = []; let positionCalls = 0;
  const asset = (symbol: string) => ({ symbol, tradable: true, shortable: true, min_order_size: ".0001",
    min_trade_increment: ".0001", price_increment: ".1", maximum_order_qty: "1000" });
  const deps: EngineDependencies = { paperHistory: () => h, now: options.now ?? (() => T),
    rest: {
      getAccount: async () => ({ data: { equity: String(options.equity ?? 100_000), account_blocked: false, trading_blocked: false } }),
      listAssets: async () => ({ data: cfg.symbols.map(asset) }), getAsset: async (s: string) => ({ data: asset(s) }),
      listOrders: async () => ({ data: h.orders.filter(o => o.remote.status === "partially_filled").map(o => o.remote) }),
      listPositions: async () => { const positions = structuredClone(options.positions?.() ?? []); options.onPositions?.(++positionCalls); return { data: positions }; },
      getPortfolioHistory: async () => ({ data: { profit_loss: [9999] } }),
      getActivities: async () => ({ data: [] }), // This paged endpoint is deliberately not the exact source.
      getOrder: async (id: string) => ({ data: h.orders.find(o => o.remote.id === id)?.remote }),
    } as unknown as NonNullable<EngineDependencies["rest"]>,
    gateway: { send: async p => { sent.push(p); return { id: `sent-${p.clientOrderId}` } as VenueOrder; },
      cancel: async () => undefined, cancelAll: async () => undefined } };
  const engine = new TradingEngine(cfg, deps); engine.on("engineError", error => errors.push(error));
  return { engine, internals: engine as unknown as Internals, sent, errors, cfg };
}

test("engine reconciliation restores trailing losses rather than reusing the UTC portfolio-history proxy", async () => {
  const h = history(); fill(h, plan("entry", 1, 1, T - 25 * H), 1, 100, 1, T - 25 * H);
  fill(h, plan("exit", -1, 1, T - H, true), 1, 90, 2, T - H);
  const { engine, internals, errors } = engineFixture(h);
  assert.equal(await engine.reconcileAccount(), true, String(errors)); const state = engine.state();
  near(state.realizedPnl24h!, -12); near(state.realizedSessionPnl, 0); near(internals.portfolioRealizedLoss24h(), 12);
  assert.equal(state.realizedPnlMeasurement, "KNOWN"); assert.equal(state.rollingPnlDetails!.fundingIncluded, false);
  const restarted = engineFixture(structuredClone(h)); assert.equal(await restarted.engine.reconcileAccount(), true);
  near(restarted.engine.state().realizedPnl24h!, -12);
});

test("unknown retained history blocks entries globally while allowing a reduce-only exit", async () => {
  const h = history(); fill(h, plan("entry", 1, 1, T - H), 1, 100, .1, T - H); h.activities = [];
  const remote = { symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition;
  const { engine, internals, sent } = engineFixture(h, { positions: () => [remote] });
  assert.equal(await engine.reconcileAccount(), false); let state = engine.state();
  assert.equal(state.realizedPnl24h, null); assert.equal(state.realizedPnlMeasurement, "UNKNOWN");
  assert.equal(state.risk.health.accountReconciled, false); assert.equal(state.positions.length, 1);
  assert.equal(internals.portfolioRealizedLoss24h(), Infinity);
  assert.equal(await internals.submit(plan("new-risk", 1, 1, T)), false);
  const exit = plan("safe-exit", -1, 1, T, true);
  assert.equal(await internals.submit(exit), true); internals.clearOrderDeadline(exit.clientOrderId);
  assert.deepEqual(sent.map(p => p.clientOrderId), ["safe-exit"]);
  state = engine.state(); assert.equal(state.realizedPnlMeasurement, "UNKNOWN");
});

test("private partial fills update exact fees immediately and reconciliation cannot double count them", async () => {
  let nowMs = T; const h = history(), p = plan("entry", 1, 2, T - 1);
  fill(h, p, 1, 100, .1, T - 1);
  let positions = [{ symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition];
  const { engine, internals } = engineFixture(h, { now: () => nowMs, positions: () => positions });
  assert.equal(await engine.reconcileAccount(), true);
  internals.orderState.reserve(p); internals.orderState.reconcileOrder({ id: "remote-entry", clientOrderId: "entry", filledQty: 1, averageFillPx: 100, status: "partially_filled" });
  nowMs++; fill(h, p, 1, 110, .2, nowMs);
  positions = [{ ...positions[0]!, qty: "2", avg_entry_price: "105" }];
  const event: PrivateOrderEvent = { id: "event-partial", event: "fill", orderId: "remote-entry", clientOrderId: "entry",
    symbol: "BTC/USD", filledQty: 2, eventQty: 1, eventPx: 110, timestampMs: nowMs, positionQty: 2, feeUsd: .2 };
  internals.onPrivateEvent(event); near(engine.state().realizedPnl24h!, -.3);
  internals.onPrivateEvent({ ...event, id: "redelivery" }); near(engine.state().realizedPnl24h!, -.3);
  assert.equal(await engine.reconcileAccount(), true); near(engine.state().realizedPnl24h!, -.3);
  internals.onPrivateEvent({ ...event, id: "conflict", feeUsd: .9 });
  assert.equal(engine.state().realizedPnl24h, null); assert.equal(engine.state().risk.health.accountReconciled, false);
});

test("a missing stream fee is recovered as recorded zero instead of applying today's configured rate", async () => {
  const h = history(), p = plan("entry", 1, 1, T); let positions: VenuePosition[] = [];
  const { engine, internals } = engineFixture(h, { positions: () => positions });
  assert.equal(await engine.reconcileAccount(), true); internals.orderState.reserve(p);
  fill(h, p, 1, 100, 0, T); positions = [{ symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition];
  internals.onPrivateEvent({ id: "without-stream-fee", event: "fill", orderId: "remote-entry", clientOrderId: "entry",
    symbol: "BTC/USD", filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: T, positionQty: 1 });
  near(engine.state().realizedPnl24h!, 0); near(engine.state().realizedSessionPnl, 0);
});

test("an unknown current fee blocks new entries immediately even when the full fill history is retained", async () => {
  const h = history(), p = plan("entry", 1, 1, T); let positions: VenuePosition[] = [];
  const { engine, internals, sent } = engineFixture(h, { positions: () => positions });
  assert.equal(await engine.reconcileAccount(), true); internals.orderState.reserve(p);
  fill(h, p, 1, 100, 0, T); delete h.activities[0]!.fee_usd;
  positions = [{ symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition];
  internals.onPrivateEvent({ id: "missing-all-fee-evidence", event: "fill", orderId: "remote-entry", clientOrderId: "entry",
    symbol: "BTC/USD", filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: T, positionQty: 1 });
  const state = engine.state(); assert.equal(state.realizedPnl24h, null);
  assert.equal(state.rollingPnlDetails!.missingFeeEvents24h, 1);
  assert.equal(state.risk.health.accountReconciled, false); assert.equal(state.positions.length, 1);
  assert.equal(await internals.submit(plan("new-risk", 1, 1, T)), false); assert.equal(sent.length, 0);
  assert.equal(await engine.reconcileAccount(), false);
});

test("a missing fee can age out of measurement while account health requires a fresh reconciliation", async () => {
  let nowMs = T; const h = history(); fill(h, plan("old-entry", 1, 1, T - 1), 1, 100, 0, T - 1);
  delete h.activities[0]!.fee_usd;
  const positions = [{ symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition];
  const { engine, internals } = engineFixture(h, { now: () => nowMs, positions: () => positions });
  assert.equal(await engine.reconcileAccount(), false); let state = engine.state();
  assert.equal(state.realizedPnlMeasurement, "UNKNOWN"); assert.equal(state.rollingPnlDetails!.utcSessionNetPnlUsd, 0);
  near(state.realizedSessionPnl, 0); assert.equal(state.risk.health.accountReconciled, false);
  nowMs = T + DAY - 1; state = engine.state(); // The unknown fee is exactly at the excluded boundary.
  assert.equal(state.realizedPnlMeasurement, "KNOWN"); near(state.realizedPnl24h!, 0);
  assert.equal(state.rollingPnlDetails!.retainedMissingFeeEvents, 1);
  assert.equal(state.rollingPnlDetails!.missingFeeEvents24h, 0);
  assert.equal(state.risk.health.accountReconciled, false);
  assert.equal(await internals.submit(plan("new-risk", 1, 1, nowMs)), false);
  assert.equal(await engine.reconcileAccount(), true); assert.equal(engine.state().risk.health.accountReconciled, true);
});

test("a fill between REST positions and history capture triggers a fresh coherent snapshot", async () => {
  const h = history(), p = plan("racing-entry", 1, 1, T); let positions: VenuePosition[] = [];
  let internals: Internals | undefined; let injected = false;
  const fixture = engineFixture(h, { positions: () => positions, onPositions: call => {
    if (call !== 2 || injected) return; injected = true;
    queueMicrotask(() => { fill(h, p, 1, 100, .1, T);
      positions = [{ symbol: "BTC/USD", side: "long", qty: "1", avg_entry_price: "100" } as VenuePosition];
      internals!.onPrivateEvent({ id: "racing", event: "fill", orderId: "remote-racing-entry", clientOrderId: p.clientOrderId,
        symbol: p.symbol, filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: T, positionQty: 1, feeUsd: .1 }); });
  } }); internals = fixture.internals;
  assert.equal(await fixture.engine.reconcileAccount(), true, String(fixture.errors));
  assert.equal(injected, true); near(fixture.engine.state().realizedPnl24h!, -.1);
  assert.equal(fixture.engine.state().positions[0]!.qty, 1);
});

test("state generation shares one clock sample so advancing wall time does not cause false regression", () => {
  let nowMs = T; const { engine, internals } = engineFixture(history(), { now: () => nowMs++ });
  assert.equal(internals.rollingPnlLedger.restore(history(), T - 1, []), true);
  for (let i = 0; i < 5; i++) {
    const state = engine.state(); assert.equal(state.realizedPnlMeasurement, "KNOWN"); near(state.realizedPnl24h!, 0);
    assert.equal(state.rollingPnlDetails!.asOfMs, state.generatedAtMs);
  }
});

test("generic engines without complete-history callback label trailing PnL unavailable", () => {
  const cfg = loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config", CONTINUOUS_RECORDING_ENABLED: "false" });
  const engine = new TradingEngine(cfg, { now: () => T }); engine.restoreRealizedSessionPnl(-7);
  near(engine.state().realizedSessionPnl, -7); assert.equal(engine.state().realizedPnl24h, null);
  assert.equal(engine.state().realizedPnlMeasurement, "UNAVAILABLE");
});
