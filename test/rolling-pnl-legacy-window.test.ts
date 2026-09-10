import assert from "node:assert/strict";
import test from "node:test";
import { RollingRealizedPnlLedger } from "../src/risk/rolling-pnl.js";
import type { KrakenPaperHistory } from "../src/kraken/paper-broker.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { VenueOrder } from "../src/venue/types.js";

const H = 3_600_000, T = Date.UTC(2026, 0, 4, 12);
function legacyRoundTrip(entryAtMs: number, exitAtMs: number): KrakenPaperHistory {
  const orders = [
    { id: "entry", side: 1 as const, price: 100, atMs: entryAtMs, reduce: false },
    { id: "exit", side: -1 as const, price: 90, atMs: exitAtMs, reduce: true },
  ].map(x => ({ plan: { clientOrderId: x.id, symbol: "BTC/USD", side: x.side,
    qty: 1, createdMs: x.atMs, reduceOnlyIntent: x.reduce } as ExecutionPlan,
    remote: { id: x.id, client_order_id: x.id, symbol: "BTCUSD", side: x.side === 1 ? "buy" : "sell",
      qty: "1", filled_qty: "1", filled_avg_price: String(x.price) } as VenueOrder }));
  return { orders, makerFeeBpsBySymbol: {}, takerFeeBpsBySymbol: {}, activities: [
    { id: "close", activity_type: "FILL", order_id: "exit", symbol: "BTC/USD", qty: "1", price: "90",
      fee_usd: "2", transaction_time: new Date(exitAtMs).toISOString() },
    { id: "open", activity_type: "FILL", order_id: "entry", symbol: "BTC/USD", qty: "1", price: "100",
      transaction_time: new Date(entryAtMs).toISOString() },
  ] };
}

test("unknown legacy entry fee does not hide a fully observed later exit loss", () => {
  const ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore(legacyRoundTrip(T - 48 * H, T - H), T, []), true);
  const snapshot = ledger.snapshot(T);
  assert.equal(snapshot.status, "KNOWN");
  assert.equal(snapshot.realizedPricePnl24hUsd, -10);
  assert.equal(snapshot.fees24hUsd, 2);
  assert.equal(snapshot.netRealizedPnl24hUsd, -12);
  assert.equal(snapshot.utcSessionNetPnlUsd, -12);
});

test("an unknown fee is excluded only when its timestamp reaches the open left boundary", () => {
  const history = legacyRoundTrip(T - 24 * H, T - H), ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore(history, T - 1, []), false);
  assert.equal(ledger.snapshot(T - 1).netRealizedPnl24hUsd, null);
  // The same unknown receipt is now outside the queried window; it has not acquired a zero fee.
  assert.equal(ledger.restore(history, T, []), true);
  assert.equal(ledger.snapshot(T).netRealizedPnl24hUsd, -12);
});

test("zero current activity stays unknown when older inventory reconstruction is incomplete", () => {
  const history = legacyRoundTrip(T - 48 * H, T - 47 * H), ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore({ ...history, activities: history.activities.slice(0, 1) }, T, []), false);
  assert.equal(ledger.snapshot(T).netRealizedPnl24hUsd, null);
});
