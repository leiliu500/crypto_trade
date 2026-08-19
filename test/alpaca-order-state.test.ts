import assert from "node:assert/strict";
import test from "node:test";
import { AlpacaRestClient } from "../src/alpaca/rest.js";
import { AlpacaOrderGateway } from "../src/alpaca/gateway.js";
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
  assert.equal(state.get("client-1")?.filledQty, .4);
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

test("private fills retain Alpaca's fee-adjusted authoritative position quantity", () => {
  const state = new OrderStateReconciler();
  state.reserve(plan());
  state.markSending("client-1");
  const fill = state.apply({ id: "execution-fee", event: "fill", orderId: "order-fee", clientOrderId: "client-1", symbol: "BTC/USD",
    filledQty: 1, eventQty: 1, eventPx: 100, timestampMs: 11, positionQty: .9975 });
  assert.equal(fill?.positionQty, .9975);
  assert.equal(fill?.qty, 1);
});

test("REST client uses Alpaca auth, crypto endpoints, and request IDs without exposing credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ orderbooks: {} }), { status: 200, headers: { "x-request-id": "request-1" } });
  };
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true, cryptoLocation: "us" }, fakeFetch);
  const response = await client.latestOrderbooks(["BTC/USD"]);
  assert.equal(response.requestId, "request-1");
  assert.match(calls[0]!.url, /v1beta3\/crypto\/us\/latest\/orderbooks/);
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["APCA-API-KEY-ID"], "key");
  assert.equal(headers["APCA-API-SECRET-KEY"], "secret");
});

test("POST order requests are never automatically retried", async () => {
  let calls = 0;
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true, maximumGetRetries: 3 }, async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "temporary" }), { status: 500 });
  });
  await assert.rejects(() => client.createOrder({ symbol: "BTC/USD", qty: "0.001", side: "buy", type: "limit", time_in_force: "ioc", limit_price: "100", client_order_id: "x" }));
  assert.equal(calls, 1);
});

test("crypto gateway never sends more than Alpaca's nine decimal places", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true }, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "paper-order" }), { status: 200 });
  });
  const floatingPlan = { ...plan(), qty: .000015531, limitPx: 68_788.1 };
  await new AlpacaOrderGateway(client).send(floatingPlan);
  assert.equal(body?.qty, "0.000015531");
  assert.equal(body?.limit_price, "68788.1");
  assert.match(String(body?.qty), /^\d+(?:\.\d{1,9})?$/);
  assert.match(String(body?.limit_price), /^\d+(?:\.\d{1,9})?$/);
});
