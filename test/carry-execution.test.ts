import assert from "node:assert/strict";
import test from "node:test";
import { CARRY_EXECUTION_SPEC, newCarryState, beginCarryEntry, beginCarryExit, applyCarryFill,
  rejectCarryOrder, advanceCarryRepair, applyCarryFunding, carryLiquidation, validateCarryState, restoreCarryState,
  type CarryConfig, type CarryState, type CarryQuotes, type CarryFill } from "../src/carry/execution.js";

const T = Date.UTC(2026, 8, 1), H = 3_600_000;
function config(): CarryConfig {
  return { spot: { id: "venue:SPOT:BTC/USD", venue: "venue", kind: "SPOT", symbol: "BTC/USD", baseAsset: "BTC",
    quoteAsset: "USD", minQty: .1, qtyIncrement: .1, priceIncrement: .1 },
  future: { id: "venue:LINEAR_PERPETUAL:PF_XBTUSD", venue: "venue", kind: "LINEAR_PERPETUAL", symbol: "PF_XBTUSD", baseAsset: "BTC",
    quoteAsset: "USD", minQty: .1, qtyIncrement: .1, priceIncrement: .1 },
  spotCashUsd: 1000, derivativeCollateralUsd: 1000, spotFeeBps: 10, futureFeeBps: 20,
  derivativeInitialMarginFraction: 1, maximumGrossNotionalUsd: 250, maximumUnmatchedNotionalUsd: 150,
  maximumQuoteAgeMs: 5000, legTimeoutMs: 10_000, fundingIntervalMs: H };
}
function quotes(atMs: number, c = config(), depth = 10): CarryQuotes {
  return { spot: { instrumentId: c.spot.id, atMs, bid: 99, ask: 100, bidQty: depth, askQty: depth },
    future: { instrumentId: c.future.id, atMs, bid: 102, ask: 103, bidQty: depth, askQty: depth } };
}
const missing: CarryQuotes = { spot: null, future: null };
const pending = (s: CarryState) => s.orders.find(o => o.id === s.pendingOrderId)!;
function receipt(s: CarryState, atMs: number, qty = pending(s).remainingQty, final = true): CarryFill {
  const o = pending(s), rate = o.leg === "spot" ? s.config.spotFeeBps : s.config.futureFeeBps;
  return { id: `receipt:${s.fills.length}`, orderId: o.id, instrumentId: o.instrumentId, atMs, side: o.side,
    qty, price: o.limitPrice, feeUsd: qty * o.limitPrice * rate / 10_000, final };
}
function entry(c = config(), qty = 1) { return beginCarryEntry(newCarryState(c), { id: "cycle-1", atMs: T, baseQty: qty, quotes: quotes(T, c) }); }
function spotFilled(c = config(), qty = 1) { const s = entry(c, qty); return applyCarryFill(s, receipt(s, T + 1)); }
function hedged(c = config()) {
  let s = spotFilled(c); s = advanceCarryRepair(s, { atMs: T + 2, quotes: quotes(T + 2, c) });
  return applyCarryFill(s, receipt(s, T + 3));
}
const near = (a: number | null, b: number) => { assert.notEqual(a, null); assert.ok(Math.abs(a! - b) < 1e-8, `${a} != ${b}`); };

test("paper-only config requires qualified distinct same-base instruments and explicit independent limits", () => {
  assert.equal(CARRY_EXECUTION_SPEC.externalOrdersAllowed, false);
  for (const edit of [
    (c: CarryConfig) => { c.future.id = c.spot.id; },
    (c: CarryConfig) => { c.future.baseAsset = "ETH"; },
    (c: CarryConfig) => { c.spot.id = "BTC/USD"; },
    (c: CarryConfig) => { c.maximumGrossNotionalUsd = 0; },
    (c: CarryConfig) => { c.maximumUnmatchedNotionalUsd = 251; },
    (c: CarryConfig) => { c.derivativeInitialMarginFraction = 0; },
    (c: CarryConfig) => { c.fundingIntervalMs = 0; },
    (c: CarryConfig) => { c.maximumQuoteAgeMs = c.legTimeoutMs + 1; },
    (c: CarryConfig) => { c.spotFeeBps = -1; },
  ]) { const c = config(); edit(c); assert.throws(() => newCarryState(c), /CONFIG/); }
  assert.equal(entry().reservation.grossNotionalUsd, 203); // Deliberately greater than the unrelated old $12 cap.
});

test("entry reserves both legs and unmatched risk, and never nets spot/future inventory", () => {
  let s = entry(); assert.equal(s.status, "ENTERING"); assert.equal(s.orders.length, 1);
  assert.equal(pending(s).leg, "spot"); assert.equal(s.spot.qty, 0); assert.equal(s.future.qty, 0);
  near(s.reservation.spotCashUsd, 100.1); near(s.reservation.derivativeCollateralUsd, 103.206);
  near(s.reservation.grossNotionalUsd, 203); near(s.reservation.unmatchedNotionalUsd, 103);
  s = applyCarryFill(s, receipt(s, T + 1)); assert.equal(s.spot.qty, 1); assert.equal(s.future.qty, 0);
  assert.equal(s.pendingOrderId, null); assert.equal(s.reservation.spotCashUsd, 0);
  assert.ok(s.reservation.derivativeCollateralUsd > 100); assert.equal(s.reservation.grossNotionalUsd, 203);
  s = advanceCarryRepair(s, { atMs: T + 2, quotes: quotes(T + 2) });
  assert.equal(s.orders.length, 2); assert.equal(pending(s).leg, "future"); assert.equal(s.fills.length, 1);
  s = applyCarryFill(s, receipt(s, T + 3)); assert.equal(s.status, "HEDGED");
  assert.equal(s.spot.qty, 1); assert.equal(s.future.qty, -1); assert.equal(s.spot.averagePrice, 100); assert.equal(s.future.averagePrice, 102);
  assert.notEqual(s.config.spot.id, s.config.future.id); near(s.spot.cashUsd, 899.9); near(s.future.collateralUsd, 999.796);
});

test("separate funded spot cash and derivative collateral cannot borrow from each other", () => {
  for (const edit of [(c: CarryConfig) => { c.spotCashUsd = 100; }, (c: CarryConfig) => { c.derivativeCollateralUsd = 103; },
    (c: CarryConfig) => { c.maximumGrossNotionalUsd = 202; }, (c: CarryConfig) => { c.maximumUnmatchedNotionalUsd = 102; }]) {
    const c = config(); edit(c); const s = newCarryState(c);
    assert.throws(() => beginCarryEntry(s, { id: "bad", atMs: T, baseQty: 1, quotes: quotes(T, c) }), /BUDGET/);
    assert.equal(s.status, "CLOSED"); assert.equal(s.orders.length, 0);
  }
});

test("entry requires causal fresh executable quotes, aligned common quantity and sufficient depth", () => {
  for (const q of [missing, quotes(T - 5001), quotes(T + 1), quotes(T, config(), .9)])
    assert.throws(() => beginCarryEntry(newCarryState(config()), { id: "a", atMs: T, baseQty: 1, quotes: q }), /FRESH/);
  assert.throws(() => beginCarryEntry(newCarryState(config()), { id: "a", atMs: T, baseQty: .15, quotes: quotes(T) }), /ENTRY/);
  const q = quotes(T); q.future!.instrumentId = q.spot!.instrumentId;
  assert.throws(() => beginCarryEntry(newCarryState(config()), { id: "a", atMs: T, baseQty: 1, quotes: q }), /QUOTE/);
});

test("independent fill receipts are exact-idempotent; conflicts, wrong legs and reversed new events reject atomically", () => {
  const original = entry(), f = receipt(original, T + 2), s = applyCarryFill(original, f);
  assert.equal(applyCarryFill(s, { ...f }), s); assert.equal(original.spot.qty, 0);
  assert.throws(() => applyCarryFill(s, { ...f, price: 99 }), /DUPLICATE/);
  assert.throws(() => applyCarryFill(original, { ...f, instrumentId: original.config.future.id }), /FILL/);
  assert.throws(() => applyCarryFill(original, { ...f, side: -1 }), /FILL/);
  assert.throws(() => applyCarryFill(original, { ...f, qty: 1.1 }), /FILL/);
  assert.throws(() => applyCarryFill(original, { ...f, feeUsd: 0 }), /FEE/);
  assert.throws(() => advanceCarryRepair(s, { atMs: T + 1, quotes: missing }), /TIME/);
});

test("multiple partial receipts update weighted average and cash once without synthetic hedge", () => {
  let s = entry(); s = applyCarryFill(s, receipt(s, T + 1, .4, false));
  assert.equal(s.spot.qty, .4); assert.equal(s.future.qty, 0); near(pending(s).remainingQty, .6);
  near(s.reservation.spotCashUsd, 60.06);
  s = applyCarryFill(s, receipt(s, T + 2, .6, true)); assert.equal(s.spot.qty, 1); assert.equal(s.fills.length, 2);
  near(s.spot.cashUsd, 899.9); near(s.spot.feesUsd, .1); assert.equal(s.future.qty, 0);
});

test("partial first leg hedges only actual filled base and releases unused reservation", () => {
  let s = entry(); s = applyCarryFill(s, receipt(s, T + 1, .4));
  near(s.reservation.grossNotionalUsd, 81.2);
  s = advanceCarryRepair(s, { atMs: T + 2, quotes: quotes(T + 2) }); assert.equal(pending(s).qty, .4);
  s = applyCarryFill(s, receipt(s, T + 3)); assert.equal(s.status, "HEDGED");
  assert.equal(s.spot.qty, .4); assert.equal(s.future.qty, -.4);
});

test("partial second leg unwinds unmatched spot only and preserves the confirmed partial hedge", () => {
  let s = advanceCarryRepair(spotFilled(), { atMs: T + 2, quotes: quotes(T + 2) });
  s = applyCarryFill(s, receipt(s, T + 3, .4)); assert.equal(s.status, "REPAIR_REQUIRED");
  s = advanceCarryRepair(s, { atMs: T + 4, quotes: quotes(T + 4) });
  assert.equal(pending(s).leg, "spot"); assert.equal(pending(s).side, -1); assert.equal(pending(s).qty, .6); assert.equal(pending(s).reduceOnly, true);
  s = applyCarryFill(s, receipt(s, T + 5)); assert.equal(s.status, "HEDGED"); assert.equal(s.spot.qty, .4); assert.equal(s.future.qty, -.4);
});

test("a rejected second leg retains repair intent through missing/stale quotes and retries on fresh depth", () => {
  let s = advanceCarryRepair(spotFilled(), { atMs: T + 2, quotes: quotes(T + 2) });
  s = rejectCarryOrder(s, { id: "reject-2", orderId: s.pendingOrderId!, atMs: T + 3 });
  assert.equal(s.status, "REPAIR_REQUIRED"); assert.equal(s.spot.qty, 1); assert.equal(s.orders[1]!.status, "REJECTED");
  s = advanceCarryRepair(s, { atMs: T + 6000, quotes: quotes(T) }); assert.equal(s.pendingOrderId, null);
  s = advanceCarryRepair(s, { atMs: T + 6001, quotes: missing }); assert.equal(s.status, "REPAIR_REQUIRED");
  s = advanceCarryRepair(s, { atMs: T + 6002, quotes: quotes(T + 6002, config(), 0) }); assert.equal(s.pendingOrderId, null);
  s = advanceCarryRepair(s, { atMs: T + 6003, quotes: quotes(T + 6003) });
  assert.equal(pending(s).purpose, "REPAIR"); s = applyCarryFill(s, receipt(s, T + 6004)); assert.equal(s.status, "CLOSED");
});

test("timeout cancels only virtual reservations and late receipts cannot fabricate fills", () => {
  const before = entry(), oldFill = receipt(before, T + 10_000);
  assert.throws(() => applyCarryFill(before, oldFill), /FILL/);
  const untouched = advanceCarryRepair(before, { atMs: T + 10_000, quotes: missing });
  assert.equal(untouched.status, "CLOSED"); assert.equal(untouched.fills.length, 0);
  let s = advanceCarryRepair(spotFilled(), { atMs: T + 2, quotes: quotes(T + 2) });
  const late = receipt(s, T + 10_003);
  s = advanceCarryRepair(s, { atMs: T + 10_002, quotes: missing });
  assert.equal(s.status, "REPAIR_REQUIRED"); assert.equal(s.spot.qty, 1);
  assert.throws(() => applyCarryFill(s, late), /FILL/);
  s = advanceCarryRepair(s, { atMs: T + 10_004, quotes: quotes(T + 10_004) });
  assert.equal(pending(s).reduceOnly, true);
});

test("unwind failure and partial repair retry never add unmatched inventory", () => {
  let s = advanceCarryRepair(spotFilled(), { atMs: T + 10_001, quotes: quotes(T + 10_001) });
  assert.equal(pending(s).purpose, "REPAIR");
  s = rejectCarryOrder(s, { id: "repair-rejected", atMs: T + 10_002, orderId: s.pendingOrderId! });
  s = advanceCarryRepair(s, { atMs: T + 10_003, quotes: quotes(T + 10_003) });
  s = applyCarryFill(s, receipt(s, T + 10_004, .3)); assert.equal(s.spot.qty, .7);
  s = advanceCarryRepair(s, { atMs: T + 10_005, quotes: quotes(T + 10_005) });
  assert.equal(pending(s).qty, .7); s = applyCarryFill(s, receipt(s, T + 10_006)); assert.equal(s.status, "CLOSED");
});

test("different quantity grids cause full unwind when an exact matched remainder cannot be repaired", () => {
  const c = config(); c.spot.minQty = c.spot.qtyIncrement = .2; c.future.minQty = c.future.qtyIncrement = .3;
  let s = entry(c, .6); s = applyCarryFill(s, receipt(s, T + 1, .4));
  s = advanceCarryRepair(s, { atMs: T + 2, quotes: quotes(T + 2, c) }); assert.equal(pending(s).qty, .3);
  s = applyCarryFill(s, receipt(s, T + 3)); assert.equal(s.status, "REPAIR_REQUIRED");
  s = advanceCarryRepair(s, { atMs: T + 4, quotes: quotes(T + 4, c) }); assert.equal(pending(s).leg, "future");
  s = applyCarryFill(s, receipt(s, T + 5)); s = advanceCarryRepair(s, { atMs: T + 6, quotes: quotes(T + 6, c) });
  assert.equal(pending(s).leg, "spot"); s = applyCarryFill(s, receipt(s, T + 7)); assert.equal(s.status, "CLOSED");
});

test("exit closes future then spot through separate receipts, with liquidation fees matching final cash", () => {
  let s = hedged(); const marked = carryLiquidation(s, { atMs: T + 4, quotes: quotes(T + 4) });
  near(marked.estimatedClosingFeesUsd, .305); near(marked.syntheticDeclaredSettlementNetPnlUsd, -2.609);
  near(marked.grossNotionalUsd, 203); assert.equal(marked.unmatchedBaseQty, 0);
  s = beginCarryExit(s, { id: "exit-1", atMs: T + 5, quotes: quotes(T + 5) });
  assert.equal(s.status, "EXITING"); assert.equal(pending(s).leg, "future");
  s = applyCarryFill(s, receipt(s, T + 6)); assert.equal(s.future.qty, 0); assert.equal(s.spot.qty, 1);
  s = advanceCarryRepair(s, { atMs: T + 7, quotes: quotes(T + 7) }); assert.equal(pending(s).leg, "spot");
  s = applyCarryFill(s, receipt(s, T + 8)); assert.equal(s.status, "CLOSED");
  near(s.spot.realizedPricePnlUsd, -1); near(s.future.realizedPricePnlUsd, -1);
  near(carryLiquidation(s, { atMs: T + 9, quotes: missing }).syntheticDeclaredSettlementNetPnlUsd, -2.609);
});

test("failed exit retains FLAT repair goal rather than reverting to a hedge", () => {
  let s = beginCarryExit(hedged(), { id: "exit-1", atMs: T + 5, quotes: quotes(T + 5) });
  s = applyCarryFill(s, receipt(s, T + 6, .4));
  s = advanceCarryRepair(s, { atMs: T + 7, quotes: quotes(T + 7) });
  s = rejectCarryOrder(s, { id: "exit-reject", orderId: s.pendingOrderId!, atMs: T + 8 });
  s = advanceCarryRepair(s, { atMs: T + 9, quotes: quotes(T + 9) }); assert.equal(s.repairGoal, "FLAT");
  assert.equal(pending(s).leg, "future"); s = applyCarryFill(s, receipt(s, T + 10));
  s = advanceCarryRepair(s, { atMs: T + 11, quotes: quotes(T + 11) });
  s = applyCarryFill(s, receipt(s, T + 12)); assert.equal(s.status, "CLOSED");
});

test("declared discrete funding debits/credits derivative cash once and never touches spot cash", () => {
  let s = hedged(); const spotCash = s.spot.cashUsd, initialCollateral = s.future.collateralUsd;
  const f = { id: "funding-1", instrumentId: s.config.future.id, atMs: T + H, absoluteRateUsdPerBase: .01 };
  s = applyCarryFunding(s, f); near(s.future.collateralUsd, initialCollateral + .01); near(s.future.fundingCostUsd, -.01);
  assert.equal(s.spot.cashUsd, spotCash); assert.equal(applyCarryFunding(s, f), s);
  assert.throws(() => applyCarryFunding(s, { ...f, absoluteRateUsdPerBase: .02 }), /DUPLICATE/);
  s = applyCarryFunding(s, { ...f, id: "funding-2", atMs: T + 2 * H, absoluteRateUsdPerBase: -.02 });
  near(s.future.collateralUsd, initialCollateral - .01); near(s.future.fundingCostUsd, .01);
  near(carryLiquidation(s, { atMs: T + 2 * H, quotes: quotes(T + 2 * H) }).syntheticDeclaredSettlementNetPnlUsd, -2.619);
});

test("missing funding keeps net unknown even after close; projection does not mutate receipts or clock", () => {
  let s = hedged(); const before = JSON.stringify(s);
  const unknown = carryLiquidation(s, { atMs: T + H, quotes: quotes(T + H) });
  assert.equal(unknown.syntheticDeclaredSettlementNetPnlUsd, null); assert.equal(unknown.unknownFundingSettlements, 1);
  assert.equal(JSON.stringify(s), before);
  s = beginCarryExit(s, { id: "exit", atMs: T + H, quotes: quotes(T + H) });
  s = applyCarryFill(s, receipt(s, T + H + 1)); s = advanceCarryRepair(s, { atMs: T + H + 2, quotes: quotes(T + H + 2) });
  s = applyCarryFill(s, receipt(s, T + H + 3)); assert.equal(s.status, "CLOSED");
  const result = carryLiquidation(s, { atMs: T + 2 * H, quotes: missing });
  assert.equal(result.declaredSettlementObligationsKnown, false); assert.equal(result.syntheticDeclaredSettlementNetPnlUsd, null);
  assert.equal(result.unknownFundingSettlements, 1); assert.notEqual(result.indicativeLiquidationEquityUsd, null);
});

test("settlement at an exit timestamp uses pre-exit quantity; explicit unknown rate is never zero", () => {
  let s = beginCarryExit(hedged(), { id: "exit", atMs: T + H, quotes: quotes(T + H) });
  s = applyCarryFill(s, receipt(s, T + H)); assert.equal(s.future.qty, 0);
  assert.equal(s.funding[0]!.signedBaseQty, -1);
  s = applyCarryFunding(s, { id: "funding", instrumentId: s.config.future.id, atMs: T + H, absoluteRateUsdPerBase: .03 });
  near(s.future.fundingCostUsd, -.03);
  const h = hedged(); const unknown = applyCarryFunding(h, { id: "unknown", instrumentId: h.config.future.id,
    atMs: T + H, absoluteRateUsdPerBase: null });
  assert.equal(unknown.funding[0]!.costUsd, null);
  assert.equal(carryLiquidation(unknown, { atMs: T + H, quotes: quotes(T + H) }).syntheticDeclaredSettlementNetPnlUsd, null);
});

test("stale liquidation quotes report unknown; journal checkpoint validates and restart repairs pending inventory", () => {
  const h = hedged(); assert.equal(carryLiquidation(h, { atMs: T + 6000, quotes: quotes(T) }).syntheticDeclaredSettlementNetPnlUsd, null);
  let s = advanceCarryRepair(spotFilled(), { atMs: T + 2, quotes: quotes(T + 2) });
  const saved = JSON.parse(JSON.stringify(s)); assert.equal(validateCarryState(saved, T + 2), true);
  assert.equal(validateCarryState(saved, T + 1), false);
  const corrupt = structuredClone(saved); corrupt.spot.cashUsd += 1;
  assert.equal(validateCarryState(corrupt), false); assert.throws(() => restoreCarryState(corrupt, T + 3), /CHECKPOINT/);
  s = restoreCarryState(saved, T + 3); assert.equal(s.pendingOrderId, null); assert.equal(s.status, "REPAIR_REQUIRED");
  assert.equal(s.spot.qty, 1); assert.equal(s.future.qty, 0); assert.equal(s.fills.length, 1);
  assert.equal(validateCarryState(JSON.parse(JSON.stringify(s)), T + 3), true);
  s = advanceCarryRepair(s, { atMs: T + 4, quotes: quotes(T + 4) }); assert.equal(pending(s).leg, "spot");
  assert.equal(pending(s).reduceOnly, true);
});

test("intrahour round trip cannot claim verified exchange funding or fully costed profit", () => {
  let s = beginCarryExit(hedged(), { id: "intrahour-exit", atMs: T + 5, quotes: quotes(T + 5) });
  s = applyCarryFill(s, receipt(s, T + 6));
  s = advanceCarryRepair(s, { atMs: T + 7, quotes: quotes(T + 7) });
  s = applyCarryFill(s, receipt(s, T + 8)); assert.equal(s.status, "CLOSED");
  const result = carryLiquidation(s, { atMs: T + 9, quotes: missing });
  assert.equal(result.unknownFundingSettlements, 0);
  assert.equal(result.declaredSettlementObligationsKnown, true);
  assert.equal(result.fundingAccounting, "DISCRETE_SETTLEMENT_PROXY_ONLY");
  assert.equal(result.exchangeFundingAccountingVerified, false);
  assert.equal(result.fullyCostedNetPnlUsd, null);
  assert.equal(result.liquidationNetPnlUsd, null);
  near(result.syntheticDeclaredSettlementNetPnlUsd, -2.609);
  assert.equal(CARRY_EXECUTION_SPEC.exchangeFundingAccountingVerified, false);
});
