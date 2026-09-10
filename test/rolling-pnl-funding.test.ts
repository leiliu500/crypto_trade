import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { KrakenPaperHistory } from "../src/kraken/paper-broker.js";
import { newPaperFundingState, observePaperFundingFill, observePaperFundingRates, postPaperFunding,
  paperFundingSnapshot, type PaperFundingState } from "../src/kraken/paper-funding.js";
import { RollingRealizedPnlLedger } from "../src/risk/rolling-pnl.js";
import { paperFundingCashWindow } from "../src/risk/paper-funding-cash.js";
import type { VenueOrder } from "../src/venue/types.js";

const T = Date.UTC(2026, 8, 9), H = 3_600_000, DAY = 24 * H;
const near = (actual: number | null | undefined, expected: number) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function history(): KrakenPaperHistory {
  const fills = [{ id: "entry", side: 1, atMs: T + H / 4, px: 100 },
    { id: "exit", side: -1, atMs: T + 3 * H / 4, px: 101 }] as const;
  return { makerFeeBpsBySymbol: {}, takerFeeBpsBySymbol: {},
    orders: fills.map(f => ({ plan: { clientOrderId: f.id, symbol: "BTC/USD", side: f.side, qty: 1,
      createdMs: f.atMs, reduceOnlyIntent: f.side === -1 } as ExecutionPlan,
    remote: { id: f.id, client_order_id: f.id, symbol: "BTC/USD", side: f.side === 1 ? "buy" : "sell",
      qty: "1", filled_qty: "1", filled_avg_price: String(f.px), status: "filled" } as VenueOrder })),
    activities: [...fills].reverse().map(f => ({ id: f.id, order_id: f.id, activity_type: "FILL", symbol: "BTC/USD",
      qty: "1", price: String(f.px), fee_usd: ".1", transaction_time: new Date(f.atMs).toISOString() })) };
}
function inventory() {
  let state = newPaperFundingState({ startedAtMs: T, productsBySymbol: { "BTC/USD": "PF_XBTUSD" } });
  state = observePaperFundingFill(state, { id: "entry", symbol: "BTC/USD", occurredAtMs: T + H / 4, side: 1, qty: 1 }, T + H / 4);
  return observePaperFundingFill(state, { id: "exit", symbol: "BTC/USD", occurredAtMs: T + 3 * H / 4, side: -1, qty: 1 }, T + 3 * H / 4);
}
function funded(state: PaperFundingState, postedAtMs: number) {
  return postPaperFunding(observePaperFundingRates(state, [{ id: "rate", symbol: "BTC/USD", productId: "PF_XBTUSD",
    effectiveFromMs: T, effectiveToMs: T + H, knownAtMs: postedAtMs,
    absoluteUsdPerBasePerHour: 2, sourceResponseSha256: "a".repeat(64) }], postedAtMs), postedAtMs).state;
}
function context(state: PaperFundingState, asOfMs: number, priorHistoryFundingUnknown = false) {
  return { state, priorHistoryFundingUnknown, snapshot: { ...paperFundingSnapshot(state, asOfMs),
    priorHistoryFundingUnknown, lifetimeFundingAccountingKnown: !priorHistoryFundingUnknown } };
}

test("realized net combines exact fill fees and actual signed paper funding cash once", () => {
  const state = funded(inventory(), T + H), h = { ...history(), funding: context(state, T + H) };
  const ledger = new RollingRealizedPnlLedger(); assert.equal(ledger.restore(h, T + H, []), true);
  const s = ledger.snapshot(T + H);
  near(s.realizedPricePnl24hUsd, 1); near(s.fees24hUsd, .2); near(s.fundingCash24hUsd, -1);
  near(s.netRealizedPnl24hUsd, -.2); near(s.utcSessionNetPnlUsd, -.2);
  assert.equal(s.fundingIncluded, true); assert.match(s.measurement, /CASH_POSTINGS/);
  ledger.restore(h, T + H, []); near(ledger.snapshot(T + H).netRealizedPnl24hUsd, -.2);
});

test("missing rates hide funded totals, preserve known fee evidence, and recover after backfill", () => {
  const state = inventory(), ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore({ ...history(), funding: context(state, T + H) }, T + H, []), false);
  let s = ledger.snapshot(T + H); assert.equal(s.netRealizedPnl24hUsd, null); near(s.fees24hUsd, .2);
  assert.match(s.reason!, /PAPER_FUNDING_RATES_OR_CASH_POSTINGS_INCOMPLETE/);
  ledger.updateFunding(context(funded(state, T + 2 * H), T + 2 * H));
  s = ledger.snapshot(T + 2 * H); assert.equal(s.status, "KNOWN"); near(s.netRealizedPnl24hUsd, -.2);
});

test("late posting belongs to its actual cash session, with an exclusive rolling left boundary", () => {
  const state = funded(inventory(), T + DAY), ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore({ ...history(), funding: context(state, T + DAY) }, T + DAY, []), true);
  near(ledger.snapshot(T + DAY).utcSessionNetPnlUsd, -1);
  ledger.updateFunding(context(state, T + 2 * DAY));
  near(ledger.snapshot(T + 2 * DAY).netRealizedPnl24hUsd, 0);
  const c = context(state, T + DAY);
  near(paperFundingCashWindow(c, T + DAY, T + DAY, true, false).cashUsd, -1);
  near(paperFundingCashWindow(c, T + DAY, T + DAY, false, false).cashUsd, 0);
});

test("legacy funding gaps affect only windows that overlap prior inventory exposure", () => {
  const epoch = T + H, state = newPaperFundingState({ startedAtMs: epoch, productsBySymbol: { "BTC/USD": "PF_XBTUSD" } });
  const ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore({ ...history(), funding: context(state, epoch, true) }, epoch, []), false);
  assert.match(ledger.snapshot(epoch).reason!, /PRE_EPOCH_EXPOSURE/);
  ledger.updateFunding(context(state, T + DAY + H, true));
  assert.equal(ledger.snapshot(T + DAY + H).status, "KNOWN");
});

test("stale funding snapshots cannot unlock funded P&L even when their last status was known", () => {
  const state = funded(inventory(), T + H), c = context(state, T + H);
  assert.equal(paperFundingCashWindow(c, T, T + H + 1001, true, false).cashUsd, null);
  assert.equal(paperFundingCashWindow(c, T, T + H - 1, true, false).cashUsd, null);
});
