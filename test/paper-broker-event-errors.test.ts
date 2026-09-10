import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KrakenPaperBroker, type KrakenPaperBrokerConfig } from "../src/kraken/paper-broker.js";
import type { ExecutionPlan } from "../src/execution/planner.js";

const T = Date.UTC(2026, 8, 9), SYMBOL = "BTC/USD";
function config(now: () => number, stateFile?: string): KrakenPaperBrokerConfig {
  return { initialEquity: 100_000, productsBySymbol: { [SYMBOL]: "PF_XBTUSD" },
    instruments: new Map([[SYMBOL, { symbol: SYMBOL, productId: "PF_XBTUSD", tickSize: 1,
      quantityIncrement: .001, maximumOrderQty: 1000 }]]), makerFeeBpsBySymbol: { [SYMBOL]: 5 },
    takerFeeBpsBySymbol: { [SYMBOL]: 5 }, fundingEnabled: true, now, ...(stateFile ? { stateFile } : {}) };
}
function plan(id: string, atMs: number): ExecutionPlan {
  return { clientOrderId: id, symbol: SYMBOL, side: 1, qty: 1, limitPx: 100, createdMs: atMs,
    expiresMs: atMs + 1000, style: "taker", timeInForce: "ioc", reduceOnlyIntent: false,
    originatingSequence: 1n, strategyVersion: "test", modelVersion: "test",
    expectedCost: { roundTripBps: 0 }, risk: { maximumLossPerUnit: 1, modeledMaximumLoss: 1 } } as ExecutionPlan;
}
function book(broker: KrakenPaperBroker, atMs: number) {
  broker.onBook({ symbol: SYMBOL, bids: [{ px: 99, qty: 10 }], asks: [{ px: 100, qty: 10 }],
    reset: true, exchangeTsMs: atMs, receiveTsMs: atMs, sourceId: `book-${atMs}` });
}

test("an asynchronous IOC funding clock error is reported and canceled without a fabricated fill", async () => {
  let now = T; const broker = new KrakenPaperBroker(config(() => now)), errors: unknown[] = [];
  broker.tradeStream.on("streamError", error => errors.push(error)); book(broker, now);
  const submission = broker.send(plan("clock-error", now));
  now = T - 1; // The IOC microtask now sees a clock before the funding epoch.
  const order = await submission; await Promise.resolve();
  assert.equal(errors.length, 1); assert.match(String(errors[0]), /PAPER_FUNDING_/);
  assert.equal((await broker.getOrder(order.id)).data.status, "canceled");
  assert.equal((await broker.getOrder(order.id)).data.filled_qty, "0");
  assert.equal(broker.history().activities.length, 0);
  assert.equal(Number((await broker.getAccount()).data.cash), 100_000);
  assert.deepEqual((await broker.listPositions()).data, []);
  now = T + 1; book(broker, now); await broker.send(plan("valid-retry", now)); await Promise.resolve();
  assert.equal(broker.history().activities.length, 1);
  assert.equal(Number((await broker.getAccount()).data.cash), 99_999.95);
});

test("failed IOC fill persistence and failed cancellation stay bounded and preserve pending state until a valid retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-event-error-"));
  try {
    const stateFile = join(directory, "state.json"), broker = new KrakenPaperBroker(config(() => T, stateFile));
    const errors: unknown[] = []; broker.tradeStream.on("streamError", error => errors.push(error)); book(broker, T);
    const submission = broker.send(plan("disk-error", T));
    const obstruction = `${stateFile}.${process.pid}.tmp`; mkdirSync(obstruction);
    const order = await submission; await Promise.resolve();
    assert.equal(errors.length, 2); assert.match(String(errors[1]), /PAPER_EXECUTION_RECOVERY_FAILED/);
    assert.equal((await broker.getOrder(order.id)).data.status, "new");
    assert.equal((await broker.getOrder(order.id)).data.filled_qty, "0");
    assert.equal(broker.history().activities.length, 0);
    assert.equal(Number((await broker.getAccount()).data.cash), 100_000);
    const durable = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(durable.cashEquity, 100_000); assert.equal(durable.orders[0].remote.status, "new");
    assert.deepEqual(durable.positions, []); assert.deepEqual(durable.activities, []);
    rmSync(obstruction, { recursive: true });
    await broker.cancel(order.id); assert.equal((await broker.getOrder(order.id)).data.status, "canceled");
    await broker.send(plan("disk-recovered", T)); await Promise.resolve();
    assert.equal(broker.history().activities.length, 1);
    assert.equal(Number((await broker.getAccount()).data.cash), 99_999.95);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
