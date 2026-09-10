import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { OrderStateReconciler, type FillDelta } from "../src/execution/order-state.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import { RiskState } from "../src/risk/risk-state.js";
import type { OrderGateway } from "../src/venue/client.js";

const healthy = { connected: true, status: "connected", droppedRecords: 0 };
const unavailable = { connected: false, status: "degraded", droppedRecords: 0 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function plan(id: string, symbol = "BTC/USD", reduceOnlyIntent = false): ExecutionPlan {
  return { clientOrderId: id, decisionId: id, riskApprovalId: id, symbol,
    side: reduceOnlyIntent ? -1 : 1, qty: .001, limitPx: 100, style: "maker", timeInForce: "gtc",
    createdMs: 1_000, expiresMs: 61_000, originatingSequence: 1n, featureHash: "synthetic",
    strategyVersion: "test", modelVersion: "none", expectedCost: { roundTripBps: 10, spreadBps: 0,
      feeBps: 10, impactBps: 0, latencyBps: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
    risk: { qty: .001, riskBudget: 1, maximumLossPerUnit: 1, modeledMaximumLoss: .001,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: .5, expectedValue: .01, reduceOnlyIntent };
}
function harness(required = true) {
  const cfg = { ...loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", MODEL_ONLY_ENTRIES: "false" }),
    databaseRequired: required, continuousRecordingEnabled: false, distributionalEngineEnabled: false,
    distributionalPaperTrialEnabled: false, distributionalEfficientTrainingEnabled: false,
    distributionalRegimeModelEnabled: false, policyEngineEnabled: false };
  const sent: ExecutionPlan[] = [], canceled: string[] = [];
  let cancelAll = 0;
  const remote = new Map<string, { id: string; client_order_id: string; symbol: string; filled_qty: string;
    filled_avg_price: null; status: string; updated_at: string }>();
  const register = (p: ExecutionPlan, id = `venue-${p.clientOrderId}`) => {
    remote.set(id, { id, client_order_id: p.clientOrderId, symbol: p.symbol,
      filled_qty: "0", filled_avg_price: null, status: "accepted", updated_at: new Date(1_000).toISOString() });
    return { id };
  };
  const gateway: OrderGateway = {
    send: async p => { sent.push(p); return register(p) as never; },
    cancel: async id => { canceled.push(id); const r = remote.get(id); if (r) r.status = "canceled"; },
    cancelAll: async () => { cancelAll++; },
  };
  const account = () => ({ data: { equity: "100000", account_blocked: false, trading_blocked: false, crypto_status: "ACTIVE" } });
  const assets = ["BTC/USD", "ETH/USD"].map(symbol => ({ symbol, tradable: true, min_order_size: ".001",
    min_trade_increment: ".001", price_increment: ".01", maximum_order_qty: "1000", shortable: true }));
  const rest = { getAccount: async () => account(), listAssets: async () => ({ data: assets }),
    getAsset: async (symbol: string) => ({ data: assets.find(a => a.symbol === symbol) }),
    listOrders: async () => ({ data: [...remote.values()].filter(r => r.status === "accepted") }),
    listPositions: async () => ({ data: [] }), getPortfolioHistory: async () => ({ data: {} }),
    getActivities: async () => ({ data: [] }), getOrder: async (id: string) => ({ data: remote.get(id)! }),
    getOrderByClientId: async (id: string) => ({ data: [...remote.values()].find(r => r.client_order_id === id)! }) };
  const engine = new TradingEngine(cfg, { gateway, rest: rest as never, now: () => 1_000 });
  const errors: unknown[] = [];
  engine.on("engineError", error => errors.push(error));
  const internal = engine as unknown as { orderState: OrderStateReconciler; riskState: RiskState;
    submit(p: ExecutionPlan): Promise<boolean>; applyFill(fill: FillDelta): void; started: boolean };
  internal.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true,
    bookValid: true, clockValid: true, riskRecomputed: true });
  return { engine, internal, gateway, rest, sent, canceled, register, account, errors, cancelAll: () => cancelAll };
}

test("required persistence cancels entries only and keeps a reduce-only exit executable", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  assert.equal(h.engine.state().risk.health.persistenceReady, true);
  const entry = plan("entry"), exit = plan("existing-exit", "ETH/USD", true);
  assert.equal(await h.internal.submit(entry), true);
  assert.equal(await h.internal.submit(exit), true);
  h.engine.setPersistenceHealth(unavailable);
  await tick();
  assert.deepEqual(h.canceled, ["venue-entry"]);
  assert.equal(h.cancelAll(), 0);
  assert.equal(h.internal.orderState.get(exit.clientOrderId)?.status, "OPEN");
  assert.equal(await h.internal.submit(plan("blocked-entry")), false);
  assert.equal(await h.internal.submit(plan("new-exit", "BTC/USD", true)), true);
  assert.deepEqual(h.engine.state().risk.reasons, ["PERSISTENCE_UNAVAILABLE"]);
  assert.deepEqual(h.errors, []);
});

test("a sending entry retains the outage cancellation through a late acknowledgment", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  const ack = deferred<{ id: string }>(), p = plan("in-flight");
  h.gateway.send = async () => await ack.promise as never;
  const submission = h.internal.submit(p);
  assert.equal(h.internal.orderState.get(p.clientOrderId)?.status, "SENDING");
  h.engine.setPersistenceHealth(unavailable);
  assert.equal(h.internal.orderState.get(p.clientOrderId)?.cancelRequestReason, "PERSISTENCE_UNAVAILABLE");
  assert.deepEqual(h.canceled, []);
  ack.resolve(h.register(p));
  assert.equal(await submission, true);
  assert.deepEqual(h.canceled, ["venue-in-flight"]);
  assert.equal(h.internal.orderState.get(p.clientOrderId)?.cancellationReason, "PERSISTENCE_UNAVAILABLE");
  assert.equal(h.internal.orderState.get(p.clientOrderId)?.status, "CANCELED");
});

test("synchronous telemetry persistence failure prevents the gateway send entirely", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  h.engine.once("orderSending", () => h.engine.setPersistenceHealth(unavailable));
  assert.equal(await h.internal.submit(plan("not-sent")), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.internal.orderState.get("not-sent")?.status, "CANCELED");
  assert.equal(h.internal.orderState.get("not-sent")?.cancellationReason, "PERSISTENCE_UNAVAILABLE");
});

test("an in-flight fill during outage is retained and its protective exit still closes the position", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  const ack = deferred<{ id: string }>(), entry = plan("late-fill");
  const send = h.gateway.send;
  h.gateway.send = async () => await ack.promise as never;
  const submission = h.internal.submit(entry);
  h.engine.setPersistenceHealth(unavailable);
  const fill = h.internal.orderState.apply({ id: "late-fill-receipt", event: "fill", orderId: "venue-late-fill",
    clientOrderId: entry.clientOrderId, symbol: entry.symbol, filledQty: entry.qty, eventQty: entry.qty,
    eventPx: 100, timestampMs: 1_000, positionQty: entry.qty });
  assert.ok(fill); h.internal.applyFill(fill);
  ack.resolve(h.register(entry));
  assert.equal(await submission, true);
  assert.equal(h.engine.state().positions[0]?.qty, entry.qty);
  assert.equal(h.internal.orderState.get(entry.clientOrderId)?.status, "FILLED");
  h.gateway.send = send;
  const exit = plan("late-fill-exit", "BTC/USD", true);
  assert.equal(await h.internal.submit(exit), true);
  const exitFill = h.internal.orderState.apply({ id: "late-exit-receipt", event: "fill", orderId: "venue-late-fill-exit",
    clientOrderId: exit.clientOrderId, symbol: exit.symbol, filledQty: exit.qty, eventQty: exit.qty,
    eventPx: 100, timestampMs: 1_000, positionQty: 0 });
  assert.ok(exitFill); h.internal.applyFill(exitFill);
  assert.equal(h.engine.state().positions.length, 0);
  assert.equal(h.internal.riskState.entriesAllowed(), false);
});

test("reconnection requires a successful account reconciliation; a book health update cannot reopen entries", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  h.engine.setPersistenceHealth(unavailable);
  h.engine.setPersistenceHealth(healthy);
  h.internal.riskState.setHealth({ riskRecomputed: true });
  assert.equal(h.internal.riskState.resumeAfterReconciliation(), false);
  assert.equal(await h.internal.submit(plan("blocked")), false);
  assert.equal(await h.engine.reconcileAccount(), true);
  assert.equal(h.engine.state().risk.health.persistenceReady, true);
  assert.equal(h.internal.riskState.entriesAllowed(), true);
  assert.equal(await h.internal.submit(plan("reconciled")), true);
});

test("running engine initiates fresh reconciliation on recovery and cannot reopen while it is unresolved", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  h.internal.started = true;
  const account = deferred<ReturnType<typeof h.account>>();
  h.rest.getAccount = () => account.promise;
  h.engine.setPersistenceHealth(unavailable);
  h.engine.setPersistenceHealth(healthy);
  assert.equal(h.engine.state().risk.health.accountReconciled, false);
  assert.equal(h.engine.state().risk.health.persistenceReady, false);
  account.resolve(h.account()); await tick();
  assert.equal(h.internal.riskState.entriesAllowed(), true);
});

test("failed account reconciliation after DB recovery keeps the entry gate closed", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  h.engine.setPersistenceHealth(unavailable);
  h.engine.setPersistenceHealth(healthy);
  h.rest.getAccount = async () => { throw new Error("account unavailable"); };
  assert.equal(await h.engine.reconcileAccount(), false);
  h.internal.riskState.setHealth({ riskRecomputed: true });
  assert.equal(h.internal.riskState.resumeAfterReconciliation(), false);
  assert.equal(h.engine.state().risk.health.persistenceReady, false);
  assert.equal(await h.internal.submit(plan("failed-reconcile")), false);
});

test("a reconciliation begun before the latest DB failure cannot clear that failure", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  const account = deferred<ReturnType<typeof h.account>>();
  h.rest.getAccount = () => account.promise;
  const reconciliation = h.engine.reconcileAccount();
  h.engine.setPersistenceHealth(unavailable);
  h.engine.setPersistenceHealth(healthy);
  account.resolve(h.account());
  assert.equal(await reconciliation, true);
  assert.equal(h.engine.state().risk.health.persistenceReady, false);
  assert.equal(h.internal.riskState.entriesAllowed(), false);
  assert.equal(await h.engine.reconcileAccount(), true);
  assert.equal(h.internal.riskState.entriesAllowed(), true);
});

test("dropped audit records latch across connection recovery, counter reset, and normal reconciliation", async t => {
  const h = harness(); t.after(() => h.engine.stop());
  h.engine.setPersistenceHealth({ ...healthy, droppedRecords: 1 });
  h.engine.setPersistenceHealth(healthy);
  assert.equal(await h.engine.reconcileAccount(), true);
  assert.ok(h.engine.state().risk.reasons.includes("AUDIT_DATA_LOSS"));
  assert.equal(h.engine.state().risk.health.persistenceReady, false);
  assert.equal(await h.internal.submit(plan("lost-audit-entry")), false);
  assert.equal(await h.internal.submit(plan("protective-exit", "ETH/USD", true)), true);
  // Even ordinary RiskState reconciliation cannot remove the permanent reason.
  h.internal.riskState.setHealth({ persistenceReady: true, riskRecomputed: true });
  assert.equal(h.internal.riskState.resumeAfterReconciliation(), false);
});

test("optional persistence does not change entry permission or cancel orders", async t => {
  const h = harness(false); t.after(() => h.engine.stop());
  assert.equal(await h.internal.submit(plan("optional")), true);
  h.engine.setPersistenceHealth({ ...unavailable, droppedRecords: 10 });
  assert.equal(h.internal.riskState.entriesAllowed(), true);
  assert.deepEqual(h.canceled, []);
});

test("inconsistent or malformed persistence health fails closed without blocking reduce-only orders", async t => {
  for (const health of [{ ...healthy, status: "degraded" }, { ...healthy, droppedRecords: Number.NaN }]) {
    const h = harness(); t.after(() => h.engine.stop());
    h.engine.setPersistenceHealth(health);
    assert.equal(await h.internal.submit(plan("invalid-health")), false);
    assert.equal(await h.internal.submit(plan("exit-invalid-health", "BTC/USD", true)), true);
  }
});
