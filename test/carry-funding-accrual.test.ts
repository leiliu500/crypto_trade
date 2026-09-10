import assert from "node:assert/strict";
import test from "node:test";
import { FUNDING_ACCRUAL_SPEC, newFundingAccrualState, observeFundingRate, applyFundingPositionChange,
  applyFundingCashReceipt, advanceFundingAccrual, fundingAccrualSnapshot, fundingObligationId,
  validateFundingAccrualState, restoreFundingAccrualState, createFundingAccrualProjection,
  type FundingAccrualState, type FundingRateInterval, type FundingCashReceipt } from "../src/carry/funding-accrual.js";

const T = Date.UTC(2026, 8, 1), H = 3_600_000, M = 60_000, I = "kraken:LINEAR_PERPETUAL:PF_XBTUSD";
const fresh = (qty = 0, tolerance = 1e-8) => newFundingAccrualState({ instrumentId: I, startedAtMs: T,
  initialSignedBaseQty: qty, reconciliationToleranceUsd: tolerance });
const rate = (from = T, to = T + H, cost = .1, known = from, name = `rate:${from}`): FundingRateInterval =>
  ({ id: name, instrumentId: I, effectiveFromMs: from, effectiveToMs: to, absoluteUsdPerBasePerHour: cost, knownAtMs: known });
function position(s: FundingAccrualState, atMs: number, qty: number, sequence = s.positions.length + 1) {
  return applyFundingPositionChange(s, { id: `fill:${sequence}`, instrumentId: I, sequence, atMs, newSignedBaseQty: qty }, atMs);
}
function cash(s: FundingAccrualState, from: number, to: number, costUsd: number, knownAtMs = to): FundingCashReceipt {
  return { id: `cash:${from}:${to}`, instrumentId: I, currency: "USD", obligationId: fundingObligationId(I, from, to),
    settledAtMs: to, knownAtMs, costUsd };
}
const near = (v: number | null, expected: number) => { assert.notEqual(v, null); assert.ok(Math.abs(v! - expected) < 1e-10, `${v} != ${expected}`); };

test("half-hour entry accrues only actual holding time and keeps accrued funding separate from cash", () => {
  let s = observeFundingRate(fresh(), rate(T, T + H, 18.5), T);
  s = position(s, T + 30 * M, -4);
  let snap = fundingAccrualSnapshot(s, T + 45 * M);
  near(snap.accruedUnsettledCostUsd, -18.5); near(snap.actualCashCostUsd, 0);
  assert.equal(snap.obligations.length, 0); assert.equal(snap.fundingAccountingKnown, true);
  snap = fundingAccrualSnapshot(s, T + H);
  near(snap.expectedSettledCostUsd, -37); near(snap.accruedUnsettledCostUsd, 0);
  assert.equal(snap.fundingAccountingKnown, false); assert.equal(snap.missingCashReceipts, 1);
  assert.deepEqual(snap.obligations[0]!.exactExpectedCostUsd, { numerator: "-37", denominator: "1" });
  s = applyFundingCashReceipt(s, cash(s, T + 30 * M, T + H, -37), T + H);
  snap = fundingAccrualSnapshot(s); assert.equal(snap.fundingAccountingKnown, true);
  near(snap.actualCashPnlUsd, 37); near(snap.reconciledFundingComponentPnlUsd, 37);
  assert.equal(snap.fullyCostedNetPnlUsd, null);
});

test("intrahour round trip creates a position-change settlement rather than zero funding", () => {
  let s = observeFundingRate(fresh(), rate(T, T + H, .12), T);
  s = position(s, T + 10 * M, -2); s = position(s, T + 40 * M, 0);
  let snap = fundingAccrualSnapshot(s); assert.equal(snap.obligations.length, 1);
  assert.equal(snap.obligations[0]!.reason, "POSITION_CHANGE"); near(snap.expectedTotalCostUsd, -.12);
  assert.equal(snap.fundingAccountingKnown, false);
  s = applyFundingCashReceipt(s, cash(s, T + 10 * M, T + 40 * M, -.12), T + 40 * M);
  snap = fundingAccrualSnapshot(s, T + 4 * H); assert.equal(snap.fundingAccountingKnown, true);
  near(snap.actualCashPnlUsd, .12); assert.equal(snap.obligations.length, 1);
});

test("increases, reductions and sign reversals settle prior inventory before changing quantity", () => {
  let s = observeFundingRate(fresh(1), rate(T, T + H, .1), T);
  s = position(s, T + 15 * M, 2); s = position(s, T + 45 * M, -3); s = position(s, T + H, 0);
  const snap = fundingAccrualSnapshot(s);
  assert.deepEqual(snap.obligations.map(o => o.signedBaseQty), [1, 2, -3]);
  assert.deepEqual(snap.obligations.map(o => o.reason), ["POSITION_CHANGE", "POSITION_CHANGE", "HOUR_END_AND_POSITION_CHANGE"]);
  near(snap.obligations[0]!.expectedCostUsd, .025); near(snap.obligations[1]!.expectedCostUsd, .1);
  near(snap.obligations[2]!.expectedCostUsd, -.075); near(snap.expectedTotalCostUsd, .05);
  assert.equal(snap.accruedUnsettledCostUsd, 0);
});

test("hour boundary rate transition uses the old rate before the boundary and the new rate after it", () => {
  let s = observeFundingRate(fresh(-1), rate(T, T + H, .1), T);
  s = observeFundingRate(s, rate(T + H, T + 2 * H, -.2, T), T);
  const snap = fundingAccrualSnapshot(s, T + 90 * M);
  near(snap.expectedSettledCostUsd, -.1); near(snap.accruedUnsettledCostUsd, .1);
  near(snap.expectedTotalCostUsd, 0); assert.equal(snap.obligations.length, 1);
  assert.equal(snap.fundingAccountingKnown, false); assert.equal(snap.missingCashReceipts, 1);
});

test("piecewise rate integration retains exact rational math and never imputes a missing interval", () => {
  let s = observeFundingRate(fresh(3), rate(T, T + 20 * M, .1), T);
  s = observeFundingRate(s, rate(T + 40 * M, T + H, .2, T), T);
  let snap = fundingAccrualSnapshot(s, T + H);
  assert.equal(snap.missingRateMs, 20 * M); assert.equal(snap.expectedTotalCostUsd, null);
  near(snap.knownPartialAccrualCostUsd, .3); assert.equal(snap.obligations[0]!.exactExpectedCostUsd, null);
  s = observeFundingRate(s, rate(T + 20 * M, T + 40 * M, 0, T), T);
  snap = fundingAccrualSnapshot(s, T + H); near(snap.expectedTotalCostUsd, .3);
  assert.deepEqual(snap.obligations[0]!.exactExpectedCostUsd, { numerator: "3", denominator: "10" });
  assert.equal(snap.ratesKnown, true); assert.equal(snap.fundingAccountingKnown, false);
});

test("late rates can reconcile past obligations only in the newly observed state", () => {
  let s = position(fresh(), T + 30 * M, -1); s = position(s, T + H, 0);
  const old = s, oldSnapshot = fundingAccrualSnapshot(old);
  assert.equal(oldSnapshot.expectedTotalCostUsd, null);
  s = applyFundingCashReceipt(s, cash(s, T + 30 * M, T + H, -.05, T + H + 1), T + H + 1);
  assert.equal(fundingAccrualSnapshot(s).fundingAccountingKnown, false);
  s = observeFundingRate(s, rate(T, T + H, .1, T + H + 2), T + H + 2);
  assert.equal(fundingAccrualSnapshot(s).fundingAccountingKnown, true);
  assert.deepEqual(fundingAccrualSnapshot(old), oldSnapshot);
  assert.throws(() => fundingAccrualSnapshot(s, T + H), /CLOCK/);
});

test("future-known rates and cash cannot enter state or earlier funding projections", () => {
  const s = fresh(-1);
  assert.throws(() => observeFundingRate(s, rate(T, T + H, .1, T + 1), T), /FUTURE/);
  assert.throws(() => applyFundingPositionChange(s, { id: "future", instrumentId: I, sequence: 1, atMs: T + 1, newSignedBaseQty: 0 }, T), /FUTURE/);
  const known = observeFundingRate(s, rate(), T);
  assert.throws(() => applyFundingCashReceipt(known, cash(known, T, T + H, -.1), T), /FUTURE/);
  const snapshot = fundingAccrualSnapshot(known, T + 30 * M);
  assert.equal(snapshot.actualCashCostUsd, 0); near(snapshot.accruedUnsettledCostUsd, -.05);
});

test("an incorrect cash receipt remains recorded but never silently replaces modeled accrual", () => {
  let s = observeFundingRate(fresh(-1), rate(), T);
  s = applyFundingCashReceipt(s, cash(s, T, T + H, -.09), T + H);
  const snap = fundingAccrualSnapshot(s);
  near(snap.actualCashCostUsd, -.09); near(snap.expectedSettledCostUsd, -.1);
  near(snap.expectedCashCostOutstandingUsd, -.01); near(snap.obligations[0]!.differenceUsd, .01);
  assert.equal(snap.obligations[0]!.reconciliation, "MISMATCH"); assert.equal(snap.fundingAccountingKnown, false);
  assert.equal(snap.reconciledFundingComponentPnlUsd, null);
});

test("cash tolerance is explicit and exact, including tiny nonzero rates with zero tolerance", () => {
  let s = observeFundingRate(fresh(1, .000001), rate(T, T + H, .1), T);
  s = applyFundingCashReceipt(s, cash(s, T, T + H, .100001), T + H);
  assert.equal(fundingAccrualSnapshot(s).fundingAccountingKnown, true);
  let tiny = observeFundingRate(fresh(1, 0), rate(T, T + H, 1e-20), T);
  tiny = applyFundingCashReceipt(tiny, cash(tiny, T, T + H, 0), T + H);
  const snap = fundingAccrualSnapshot(tiny); assert.equal(snap.expectedSettledCostUsd, 1e-20);
  assert.equal(snap.obligations[0]!.reconciliation, "MISMATCH");
  assert.deepEqual(snap.obligations[0]!.exactExpectedCostUsd, { numerator: "1", denominator: "100000000000000000000" });
});

test("cash and rate receipts are idempotent by identity, while conflicts and second cash for one obligation reject", () => {
  const r = rate(); let s = observeFundingRate(fresh(-1), r, T);
  assert.equal(observeFundingRate(s, { ...r }, T), s);
  assert.throws(() => observeFundingRate(s, { ...r, absoluteUsdPerBasePerHour: .2 }, T), /DUPLICATE/);
  const receipt = cash(s, T, T + H, -.1); s = applyFundingCashReceipt(s, receipt, T + H);
  assert.equal(applyFundingCashReceipt(s, { ...receipt }, T + H), s);
  assert.throws(() => applyFundingCashReceipt(s, { ...receipt, costUsd: -.2 }, T + H), /DUPLICATE/);
  assert.throws(() => applyFundingCashReceipt(s, { ...receipt, id: "second-cash" }, T + H), /DUPLICATE/);
  assert.equal(s.cashReceipts.length, 1);
});

test("same-timestamp position receipts require increasing sequence and create no artificial zero-duration charge", () => {
  let s = observeFundingRate(fresh(), rate(), T);
  s = position(s, T + 30 * M, -1, 1); s = position(s, T + 30 * M, -2, 2);
  assert.throws(() => position(s, T + 30 * M, -3, 1), /DUPLICATE|POSITION/);
  const snap = fundingAccrualSnapshot(s, T + H); assert.equal(snap.obligations.length, 1);
  assert.equal(snap.obligations[0]!.fromMs, T + 30 * M); near(snap.expectedTotalCostUsd, -.1);
  assert.throws(() => position(s, T + 29 * M, 0, 3), /POSITION|CLOCK/);
});

test("a position change at the hour boundary settles the ending hour once and starts the new quantity afterward", () => {
  let s = observeFundingRate(fresh(-1), rate(T, T + 2 * H, .1), T);
  s = position(s, T + H, -2);
  const snap = fundingAccrualSnapshot(s, T + 2 * H);
  assert.equal(snap.obligations.length, 2); near(snap.obligations[0]!.expectedCostUsd, -.1);
  near(snap.obligations[1]!.expectedCostUsd, -.2); near(snap.expectedTotalCostUsd, -.3);
});

test("zero rate is explicit evidence; zero cash receipt is still required at a due settlement", () => {
  let s = observeFundingRate(fresh(-1), rate(T, T + H, 0), T);
  let snap = fundingAccrualSnapshot(s, T + H); assert.equal(snap.ratesKnown, true);
  assert.equal(snap.fundingAccountingKnown, false); assert.equal(snap.expectedTotalCostUsd, 0);
  s = applyFundingCashReceipt(s, cash(s, T, T + H, 0), T + H);
  snap = fundingAccrualSnapshot(s); assert.equal(snap.fundingAccountingKnown, true);
  assert.equal(snap.fullyCostedNetPnlUsd, null); assert.equal(snap.inputProvenanceVerified, false);
});

test("instrument mismatch, overlapping intervals, non-USD cash and cash without settlement reject", () => {
  const s = observeFundingRate(fresh(-1), rate(), T);
  assert.throws(() => observeFundingRate(s, { ...rate(T + H, T + 2 * H), instrumentId: "kraken:LINEAR_PERPETUAL:PF_ETHUSD" }, T + H), /RATE/);
  assert.throws(() => observeFundingRate(s, rate(T + M, T + H, .1, T), T), /OVERLAPPING/);
  const c = cash(s, T, T + H, -.1);
  assert.throws(() => applyFundingCashReceipt(s, { ...c, currency: "ETH" as "USD" }, T + H), /CASH/);
  assert.throws(() => applyFundingCashReceipt(s, { ...c, obligationId: "other" }, T + H), /OBLIGATION/);
  assert.throws(() => applyFundingCashReceipt(s, { ...c, settledAtMs: T + H + 1, knownAtMs: T + H + 1 }, T + H + 1), /OBLIGATION/);
});

test("projection is immutable, chronological and unsupported elapsed intervals stay unknown", () => {
  const s = observeFundingRate(fresh(-1), rate(), T), saved = JSON.stringify(s);
  const future = fundingAccrualSnapshot(s, T + 2 * H);
  assert.equal(future.expectedTotalCostUsd, null); assert.equal(future.missingRateMs, H);
  assert.equal(future.actualCashCostUsd, 0); assert.equal(JSON.stringify(s), saved);
  const next = advanceFundingAccrual(s, T + H);
  assert.throws(() => advanceFundingAccrual(next, T + H - 1), /CLOCK/);
  assert.equal(advanceFundingAccrual(next, T + H), next);
  assert.throws(() => position(next, T + 30 * M, 0), /CLOCK|POSITION/);
});

test("restart validates journal, rejects future and altered checkpoints, and preserves unresolved obligations", () => {
  let s = observeFundingRate(fresh(-1), rate(), T); s = position(s, T + H, 0);
  const copy = JSON.parse(JSON.stringify(s)); assert.equal(validateFundingAccrualState(copy, T + H), true);
  assert.equal(validateFundingAccrualState(copy, T + H - 1), false);
  const restored = restoreFundingAccrualState(copy, T + 2 * H);
  assert.equal(fundingAccrualSnapshot(restored).missingCashReceipts, 1);
  near(fundingAccrualSnapshot(restored).expectedTotalCostUsd, -.1);
  const bad = structuredClone(copy); bad.positions[0].newSignedBaseQty = 10;
  assert.equal(validateFundingAccrualState(bad), false); assert.throws(() => restoreFundingAccrualState(bad, T + H), /CHECKPOINT/);
  assert.equal(validateFundingAccrualState(JSON.parse(JSON.stringify(restored)), T + 2 * H), true);
});

test("invalid numeric inputs and arithmetic overflow fail without corrupting the previous state", () => {
  assert.throws(() => newFundingAccrualState({ instrumentId: I, startedAtMs: T, reconciliationToleranceUsd: -1 }), /CONFIG/);
  assert.throws(() => newFundingAccrualState({ instrumentId: "BTC/USD", startedAtMs: T, reconciliationToleranceUsd: 0 }), /CONFIG/);
  const s = fresh(1e308); assert.throws(() => observeFundingRate(s, { ...rate(), absoluteUsdPerBasePerHour: NaN }, T), /RATE/);
  const big = observeFundingRate(s, rate(T, T + H, 1e308), T);
  assert.throws(() => advanceFundingAccrual(big, T + H), /OVERFLOW/); assert.equal(big.lastAsOfMs, T);
  assert.throws(() => fundingAccrualSnapshot(s, T + (FUNDING_ACCRUAL_SPEC.maximumWindowHours + 1) * H), /CLOCK/);
});

test("bulk incremental projection exactly matches journal replay across gaps, signed quantities and hour boundaries", () => {
  let state = fresh(.3, 0);
  for (const [atMs, qty] of [[T + M, .1], [T + 30 * M, -.2], [T + 2 * H, 0], [T + 3 * H + M, .3]])
    state = position(state, atMs!, qty!);
  const observed = T + 5 * H + 13 * M;
  for (let hour = 0; hour < 12; hour++) {
    if (hour === 4 || hour === 7) continue;
    state = observeFundingRate(state, rate(T + hour * H, T + (hour + 1) * H,
      hour % 2 ? -.123456789 : 1e-10, observed), observed);
  }
  const projection = createFundingAccrualProjection(state.config, state.positions, state.rates, observed);
  for (const at of [observed, observed + 1, observed + 1_000, T + 6 * H, T + 8 * H + M,
    T + 13 * H, observed + 2_000, T + 15 * H]) {
    assert.deepEqual(projection.snapshot(at), fundingAccrualSnapshot(state, at));
  }
});

test("incremental projection preserves immutable settled evidence and only appends newly due intervals", () => {
  const observed = T + 30 * M;
  const projection = createFundingAccrualProjection(fresh(.1).config, [], [rate(T, T + 4 * H, .01)], observed);
  const one = projection.snapshot(T + H + M), two = projection.snapshot(T + H + 2 * M);
  assert.equal(one.obligations, two.obligations);
  assert.equal(one.obligations.length, 1); assert.ok(Object.isFrozen(one)); assert.ok(Object.isFrozen(one.obligations));
  const three = projection.snapshot(T + 2 * H + M);
  assert.equal(three.obligations.length, 2); assert.equal(one.obligations.length, 1);
  assert.deepEqual(three.obligations[0], one.obligations[0]);
  near(three.expectedSettledCostUsd, .002); near(three.accruedUnsettledCostUsd, .001 / 60);
});

test("bulk projection validates the same rate and position identities without relaxing checkpoint verification", () => {
  const cfg = fresh().config, p = { id: "p", instrumentId: I, sequence: 1, atMs: T, newSignedBaseQty: 1 };
  assert.throws(() => createFundingAccrualProjection(cfg, [p, p], [], T), /POSITION/);
  assert.throws(() => createFundingAccrualProjection(cfg, [p], [rate(), rate()], T), /RATE/);
  assert.throws(() => createFundingAccrualProjection(cfg, [p], [rate(T, T + H, .1, T + 1)], T), /FUTURE_RATE/);
  assert.throws(() => createFundingAccrualProjection(cfg, [p], [rate(T, T + H), rate(T + M, T + 2 * H)], T + M), /OVERLAPPING/);
  assert.throws(() => createFundingAccrualProjection(cfg, [{ ...p, atMs: T + 1 }], [], T), /POSITION/);
  assert.throws(() => createFundingAccrualProjection(cfg, [p], [], T).snapshot(T - 1), /CLOCK/);
  assert.equal(validateFundingAccrualState(createFundingAccrualProjection(cfg, [p], [], T)), false);
});
