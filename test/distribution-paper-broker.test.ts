import assert from "node:assert/strict";
import test from "node:test";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { PrivateOrderEvent } from "../src/execution/order-state.js";
import type { BookState } from "../src/core/market.js";
import { DistributionExecutionCase, distributionExitLimit } from "../src/distribution/execution.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS } from "../src/distribution/spec.js";

function broker(): KrakenPaperBroker {
  return new KrakenPaperBroker({ initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
    instruments: new Map([["BTC/USD", { symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: .01,
      quantityIncrement: .001, maximumOrderQty: 1 }]]), makerFeeBpsBySymbol: { "BTC/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5 } });
}
function plan(id: string, createdMs = 1000, side: 1 | -1 = 1, qty = .1, limitPx = 100, reduceOnlyIntent = false): ExecutionPlan {
  return { clientOrderId: id, decisionId: `${id}-decision`, riskApprovalId: `${id}-risk`, symbol: "BTC/USD", side,
    qty, limitPx, style: "taker", timeInForce: "ioc", createdMs, expiresMs: createdMs + 1000,
    originatingSequence: BigInt(createdMs), featureHash: "test", strategyVersion: "distribution-test", modelVersion: "distribution-test",
    policy: { version: "executable-policy-v3", id: "distribution-5m", feeBps: 5, reserveBps: 3 },
    expectedCost: { roundTripBps: 13, spreadBps: 0, feeBps: 10, impactBps: 0, latencyBps: 0,
      adverseSelectionBps: 3, fundingBps: 0, borrowBps: 0 },
    risk: { qty, riskBudget: 1, maximumLossPerUnit: 1, modeledMaximumLoss: qty, drawdownScale: 1,
      qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" }, fillProbability: 1, expectedValue: 0, reduceOnlyIntent };
}
function book(atMs: number, bid = 99.98, ask = 100, qty = 1): BookState {
  return { symbol: "BTC/USD", bids: [{ px: bid, qty }], asks: [{ px: ask, qty }],
    exchangeTsMs: atMs, receiveTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: true };
}
function observe(broker: KrakenPaperBroker, b: BookState): void {
  broker.onBook({ ...b, reset: true, sourceId: `snapshot-${b.receiveTsMs}` });
}

test("distribution paper IOC waits for a fresh arrival quote and keeps observed nonfills", async () => {
  const b = broker(); observe(b, book(1000));
  const order = await b.send(plan("delayed")); await Promise.resolve();
  assert.equal((await b.getOrder(order.id)).data.status, "new");
  observe(b, book(1249)); assert.equal((await b.getOrder(order.id)).data.status, "new");
  observe(b, book(1250, 100.01, 100.03));
  assert.equal((await b.getOrder(order.id)).data.status, "canceled");
  assert.equal((await b.listPositions()).data.length, 0);
});

test("distribution broker and forward base case agree on partial fills, capped delayed exits and fee cashflows", async () => {
  const b = broker(), initial = book(1000, 99.98, 100, .05); observe(b, initial);
  const events: PrivateOrderEvent[] = []; b.tradeStream.on("order", (event: PrivateOrderEvent) => events.push(event));
  const research = new DistributionExecutionCase(DISTRIBUTION_ACTIONS[0]!, DISTRIBUTION_SCENARIOS[0], initial, .1,
    { feeBps: 5, reserveBps: 3 }, .01);
  await b.send(plan("partial-entry"));
  const arrival = book(1250, 99.98, 100, .05); observe(b, arrival); research.observe(arrival);
  assert.equal(Number((await b.listPositions()).data[0]!.qty), .05);
  assert.equal(events.find(e => e.event === "partial_fill")!.timestampMs, research.snapshot().entryAtMs);
  const trigger = book(1500, 99, 99.02); observe(b, trigger); research.observe(trigger);
  await b.send(plan("delayed-exit", 1500, -1, .05, distributionExitLimit(99, -1, .01), true));
  assert.equal((await b.listPositions()).data.length, 1);
  const exit = book(1750, 98.95, 98.97); observe(b, exit); const outcome = research.observe(exit)!;
  assert.equal((await b.listPositions()).data.length, 0); assert.equal(outcome.status, "FILLED");
  assert.equal(events.find(e => e.clientOrderId === "delayed-exit" && e.event === "fill")!.timestampMs, outcome.exitAtMs);
  const realized = Number((await b.getAccount()).data.equity) - 100_000;
  assert.ok(Math.abs(outcome.netBps! - (realized / 10 * 10_000 - 3 * .5)) < 1e-7);
});

test("distribution broker cancels stale, expired and reversed arrival observations without synthetic fills", async () => {
  for (const bad of [book(2001), { ...book(1250), exchangeTsMs: 0 }, book(999), book(1250, 101, 100)]) {
    const b = broker(); observe(b, book(1000)); const order = await b.send(plan(`bad-${bad.receiveTsMs}-${bad.exchangeTsMs}`));
    observe(b, bad); assert.equal((await b.getOrder(order.id)).data.status, "canceled");
    assert.equal((await b.listPositions()).data.length, 0);
  }
});
