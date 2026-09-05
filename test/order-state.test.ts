import assert from "node:assert/strict";
import test from "node:test";
import { OrderStateReconciler } from "../src/execution/order-state.js";
import type { ExecutionPlan } from "../src/execution/planner.js";

const plan = (): ExecutionPlan => ({
  clientOrderId: "client-1", decisionId: "decision", riskApprovalId: "risk", symbol: "BTC/USD", side: 1, qty: 1, limitPx: 100,
  style: "taker", timeInForce: "ioc", createdMs: 1, expiresMs: 2, originatingSequence: 1n, featureHash: "hash",
  strategyVersion: "1", modelVersion: "1", expectedCost: { roundTripBps: 1, spreadBps: 1, feeBps: 0, impactBps: 0, latencyBps: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
  risk: { qty: 1, riskBudget: 10, maximumLossPerUnit: 1, modeledMaximumLoss: 1, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
  fillProbability: 1, expectedValue: 1, reduceOnlyIntent: false,
});

test("private fill events are idempotent and partial fills create exposure deltas", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan()); state.markSending("client-1"); state.markAccepted("client-1", "order-1", 10);
  const event = { id: "execution-1", event: "partial_fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD", filledQty: .4, eventQty: .4, eventPx: 100, timestampMs: 11 };
  assert.deepEqual(state.apply(event), { symbol: "BTC/USD", side: 1, qty: .4, price: 100, clientOrderId: "client-1", final: false });
  assert.equal(state.apply(event), null);
  assert.equal(state.apply({ ...event, id: "duplicate-with-new-event-id" }), null,
    "duplicate cumulative quantity cannot be applied twice under a new event ID");
  assert.equal(state.get("client-1")?.filledQty, .4);
});

test("protective reduce-only order can proceed during entry cancellation without allowing competing exposure", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan()); state.markSending("client-1"); state.markAccepted("client-1", "order-1", 10);
  state.apply({ id: "partial", event: "partial_fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: .4, eventQty: .4, eventPx: 100, timestampMs: 11 });
  const close: ExecutionPlan = { ...plan(), clientOrderId: "close", side: -1, qty: .4, reduceOnlyIntent: true };
  assert.throws(() => state.reserve(close));
  state.requestCancel("client-1", "POSITION_PROTECTION", 12);
  state.reserve(close);
  assert.throws(() => state.reserve({ ...close, clientOrderId: "second-close" }));
  assert.throws(() => state.reserve({ ...plan(), clientOrderId: "new-entry" }));
  const late = state.apply({ id: "late-fill", event: "fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: 1, eventQty: .6, eventPx: 99, timestampMs: 13, feeUsd: .0297 });
  assert.equal(late!.qty, .6);
  assert.equal(late!.feeUsd, .0297);
});

test("a late POST acknowledgment cannot regress an already filled IOC order", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.apply({ id: "execution-fast", event: "fill", orderId: "order-fast", clientOrderId: "client-1", symbol: "BTC/USD", filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: 11 });
  state.markAccepted("client-1", "order-fast", 10);
  assert.equal(state.get("client-1")?.status, "FILLED");
  assert.equal(state.get("client-1")?.lastUpdateMs, 11);
});

test("a late cancel rejection cannot regress an already filled order", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.apply({ id: "execution-fast", event: "fill", orderId: "order-fast", clientOrderId: "client-1",
    symbol: "BTC/USD", filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: 11 });

  state.apply({ id: "cancel-rejected", event: "order_cancel_rejected", orderId: "order-fast",
    clientOrderId: "client-1", symbol: "BTC/USD", filledQty: 1, eventQty: 0, eventPx: 0,
    timestampMs: 12 });

  assert.equal(state.get("client-1")?.status, "FILLED");
});

test("private fills retain the venue's authoritative position quantity", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  const fill = state.apply({ id: "execution-fee", event: "fill", orderId: "order-fee", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: 11, positionQty: .9975 });
  assert.equal(fill?.positionQty, .9975);
  assert.equal(fill?.qty, 1);
});

test("a cancellation after a partial fill is terminal and releases the symbol", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.markAccepted("client-1", "order-1", 10);
  state.apply({ id: "partial", event: "partial_fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: .4, eventQty: .4, eventPx: 100, timestampMs: 11 });
  state.requestCancel("client-1", "TTL_EXPIRED", 12);
  state.apply({ id: "canceled", event: "canceled", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: .4, eventQty: 0, eventPx: 0, timestampMs: 13 });
  assert.equal(state.get("client-1")?.status, "CANCELED");
  assert.equal(state.get("client-1")?.cancelRequestReason, "TTL_EXPIRED");
  assert.equal(state.get("client-1")?.cancellationReason, "PARTIAL_REMAINDER_CANCELED");
  assert.equal(state.hasPendingEntry("BTC/USD"), false);
});

test("an unfilled IOC receives a distinct terminal cancellation reason", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.markAccepted("client-1", "order-1", 10);
  state.apply({ id: "canceled", event: "canceled", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: 0, eventQty: 0, eventPx: 0, timestampMs: 11 });
  assert.equal(state.get("client-1")?.status, "CANCELED");
  assert.equal(state.get("client-1")?.cancelRequestReason, undefined);
  assert.equal(state.get("client-1")?.cancellationReason, "IOC_NO_FILL");
});

test("an engine cancellation retains its strategy reason", () => {
  const state = new OrderStateReconciler();
  const maker = { ...plan(), style: "maker" as const, timeInForce: "gtc" as const };
  state.reserve(maker);
  state.markSending("client-1");
  state.markAccepted("client-1", "order-1", 10);
  state.requestCancel("client-1", "SIGNAL_INVALIDATED", 12);
  state.apply({ id: "canceled", event: "canceled", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: 0, eventQty: 0, eventPx: 0, timestampMs: 13 });
  assert.equal(state.get("client-1")?.cancelRequestReason, "SIGNAL_INVALIDATED");
  assert.equal(state.get("client-1")?.cancellationReason, "SIGNAL_INVALIDATED");
});

test("authoritative REST cancellation clears a stuck partially filled order", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.markAccepted("client-1", "order-1", 10);
  state.apply({ id: "partial", event: "partial_fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: .4, eventQty: .4, eventPx: 100, timestampMs: 11 });
  state.requestCancel("client-1", "COST_INVALIDATED", 12);
  state.reconcileOrder({ id: "order-1", clientOrderId: "client-1", filledQty: .4, averageFillPx: 100,
    status: "canceled", updatedMs: 13 });
  assert.equal(state.get("client-1")?.status, "CANCELED");
  assert.equal(state.get("client-1")?.cancelRequestReason, "COST_INVALIDATED");
  assert.equal(state.get("client-1")?.cancellationReason, "PARTIAL_REMAINDER_CANCELED");
  assert.equal(state.get("client-1")?.lastUpdateMs, 13);
  assert.equal(state.hasPendingEntry("BTC/USD"), false);
});

test("open-order reconciliation never guesses a terminal state for an absent partial fill", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  state.markAccepted("client-1", "order-1", 10);
  state.apply({ id: "partial", event: "partial_fill", orderId: "order-1", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: .4, eventQty: .4, eventPx: 100, timestampMs: 11 });
  state.reconcile([]);
  assert.equal(state.get("client-1")?.status, "PARTIALLY_FILLED");
  assert.equal(state.get("client-1")?.cancellationReason, undefined);
  assert.equal(state.hasPendingEntry("BTC/USD"), true);
});
