import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCarryEconomics, matchedCarryQuantityStep, type CarryEconomicsInput } from "../src/carry/economics.js";

const T = Date.UTC(2023, 0, 1), H = 3_600_000;
function fixture(): CarryEconomicsInput {
  return { nowMs: T,
    spot: { instrumentId: "kraken:spot:XBTUSD", base: "BTC", quote: "USD", kind: "SPOT",
      book: { bid: 99_990, ask: 100_000, bidBaseQty: 10, askBaseQty: 10, exchangeAtMs: T - 100, receivedAtMs: T - 50 },
      rules: { minimumBaseQty: .00005, quantityStep: ".00000001", minimumNotionalUsd: .5 } },
    derivative: { instrumentId: "kraken:perpetual:PF_XBTUSD", base: "BTC", quote: "USD", kind: "LINEAR_PERPETUAL",
      book: { bid: 100_100, ask: 100_110, bidBaseQty: 10, askBaseQty: 10, exchangeAtMs: T - 100, receivedAtMs: T - 50 },
      rules: { minimumBaseQty: .0001, quantityStep: ".0001", minimumNotionalUsd: 0 } },
    fees: { spotTakerBps: 80, derivativeTakerBps: 5, accountVerified: false }, executionEvidenceVerified: false,
    budget: { availableGrossUsd: 1000, availableCashUsd: 1000, availableCollateralUsd: 1000 },
    assumptions: { holdingHours: 24, annualCapitalHurdleFraction: .05, slippageBpsPerExecution: 0,
      settlementBasisReserveBps: 0, unwindReserveBps: 0, maximumQuoteAgeMs: 5000, maximumQuoteSkewMs: 1000,
      maximumFundingAgeMs: H },
    currentFunding: { absoluteUsdPerBasePerHour: .1, knownAtMs: T - 1000 } };
}
const near = (actual: number | null, expected: number, tolerance = 1e-10) => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};
function dated(): CarryEconomicsInput {
  const f = fixture(); f.spot.book.bid = 99.9; f.spot.book.ask = 100;
  f.derivative.book.bid = 110; f.derivative.book.ask = 110.1;
  f.spot.rules = { minimumBaseQty: 1, quantityStep: 1, minimumNotionalUsd: 0 };
  f.derivative.rules = { minimumBaseQty: 1, quantityStep: 1, minimumNotionalUsd: 0 };
  f.derivative.kind = "LINEAR_DATED"; f.derivative.expiryMs = T + 720 * H;
  f.assumptions.holdingHours = 720; f.assumptions.annualCapitalHurdleFraction = 0;
  f.assumptions.settlementSpotPriceScenariosUsd = [80, 100, 120];
  delete f.currentFunding; return f;
}

test("joint BASE lot step uses decimal LCM rather than rounding each leg independently", () => {
  near(matchedCarryQuantityStep("0.002", "0.003"), .006);
  near(matchedCarryQuantityStep("0.00000001", .0001), .0001);
  near(matchedCarryQuantityStep("1e-8", "3e-8"), .00000003);
  near(matchedCarryQuantityStep("0.0100", "0.002"), .01);
  for (const invalid of [0, -1, NaN, Infinity, "garbage", "0.0000000000001", "1e1000"])
    assert.throws(() => matchedCarryQuantityStep(invalid, .001), /CARRY_/);
});

test("the historical $12 sensitivity cannot fit a BTC pair while $1000 remains a separate feasible budget", () => {
  const f = fixture(); f.budget.availableGrossUsd = 12;
  const tiny = evaluateCarryEconomics(f); assert.equal(tiny.status, "INFEASIBLE");
  near(tiny.minimumMatchedBaseQty, .0001); near(tiny.minimumPairedGrossUsd, 20.011);
  assert.equal(tiny.allocatedBaseQty, 0); assert.ok(tiny.reasons.includes("CARRY_MINIMUM_PAIR_EXCEEDS_GROSS_BUDGET"));
  f.budget.availableGrossUsd = 1000;
  const larger = evaluateCarryEconomics(f); assert.equal(larger.status, "FEASIBLE"); near(larger.allocatedBaseQty, .0049);
  near(larger.allocatedPairedGrossUsd, .0049 * 200_110);
  assert.ok((larger.allocatedBaseQty + .0001) * 200_110 > 1000);
  assert.equal(larger.activationAllowed, false);
});

test("fees retain four executions and the distinct 80bp spot versus 5bp derivative assumptions", () => {
  const f = fixture(), r = evaluateCarryEconomics(f), q = r.allocatedBaseQty, fees = r.executionFees!;
  near(fees.spotEntryUsd, q * 100_000 * .008); near(fees.spotExitUsd, q * 99_990 * .008);
  near(fees.derivativeEntryUsd, q * 100_100 * .0005); near(fees.derivativeExitUsd, q * 100_110 * .0005);
  near(fees.totalUsd, q * (199_990 * .008 + 200_210 * .0005));
  assert.ok(fees.spotEntryUsd > 15 * fees.derivativeEntryUsd);
  f.fees.spotTakerBps = 0; const cheaper = evaluateCarryEconomics(f);
  assert.ok(cheaper.scenarios[1]!.netAfterCostsUsd > r.scenarios[1]!.netAfterCostsUsd);
});

test("cash and full derivative collateral independently constrain a pair", () => {
  const f = dated(); f.budget.availableGrossUsd = 100_000;
  f.budget.availableCashUsd = 101; // Below purchase plus both reserved spot fees.
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_MINIMUM_PAIR_EXCEEDS_CASH_BUDGET"));
  f.budget.availableCashUsd = 1000; f.budget.availableCollateralUsd = 100;
  const noCollateral = evaluateCarryEconomics(f); assert.equal(noCollateral.derivativeReserveFraction, 1);
  assert.ok(noCollateral.reasons.includes("CARRY_MINIMUM_PAIR_EXCEEDS_COLLATERAL_BUDGET"));
  f.budget.availableCollateralUsd = 221; const two = evaluateCarryEconomics(f);
  assert.equal(two.status, "FEASIBLE"); assert.equal(two.allocatedBaseQty, 2);
  assert.ok(two.requiredCashUsd <= f.budget.availableCashUsd && two.requiredCollateralUsd <= 221);
  near(two.reservedCapitalUsd, two.requiredCashUsd + two.requiredCollateralUsd);
});

test("minimum spot cost, unequal increments and both sides' entry depth all apply", () => {
  const f = dated(); f.spot.rules = { minimumBaseQty: .001, quantityStep: ".002", minimumNotionalUsd: 1.01 };
  f.derivative.rules = { minimumBaseQty: .003, quantityStep: ".003", minimumNotionalUsd: 0 };
  f.spot.book.askBaseQty = .02; f.derivative.book.bidBaseQty = .017;
  let r = evaluateCarryEconomics(f); near(r.matchedQuantityStep, .006); near(r.minimumMatchedBaseQty, .012);
  near(r.allocatedBaseQty, .012);
  f.derivative.book.bidBaseQty = .0119; r = evaluateCarryEconomics(f); assert.equal(r.status, "INFEASIBLE");
  assert.ok(r.reasons.includes("CARRY_MINIMUM_PAIR_EXCEEDS_DEPTH_OR_MAXIMUM_QUANTITY"));
  f.derivative.book.bidBaseQty = 10; f.spot.rules.maximumBaseQty = .011;
  assert.equal(evaluateCarryEconomics(f).status, "INFEASIBLE");
});

test("no upward lot rounding breaches a gross limit just below the minimum", () => {
  const f = dated(); f.spot.rules.quantityStep = ".01"; f.spot.rules.minimumBaseQty = .01;
  f.derivative.rules.quantityStep = ".03"; f.derivative.rules.minimumBaseQty = .03;
  f.budget.availableGrossUsd = .03 * 210.1 - 1e-9;
  assert.equal(evaluateCarryEconomics(f).status, "INFEASIBLE");
  f.budget.availableGrossUsd = .03 * 210.1;
  const exact = evaluateCarryEconomics(f); assert.equal(exact.status, "FEASIBLE"); near(exact.allocatedBaseQty, .03);
  assert.ok(exact.allocatedPairedGrossUsd <= f.budget.availableGrossUsd);
});

test("dated convergence sensitivities reconcile independent leg cash flows and varying exit fees", () => {
  const f = dated(), r = evaluateCarryEconomics(f); assert.equal(r.status, "FEASIBLE"); assert.equal(r.allocatedBaseQty, 4);
  for (const s of r.scenarios) {
    const p = s.assumedSettlementSpotPriceUsd!;
    const legPricePnl = 4 * ((p - 100) + (110 - p));
    const separateFees = 4 * ((100 + p) * .008 + (110 + p) * .0005);
    near(s.grossBasisCaptureUsd, legPricePnl); near(s.netAfterCostsUsd, legPricePnl - separateFees);
    assert.equal(s.fundingIncomeUsd, 0); assert.equal(s.assumedAbsoluteFundingUsdPerBasePerHour, null);
  }
  near(r.scenarios[2]!.netAfterCostsUsd - r.scenarios[0]!.netAfterCostsUsd, -4 * 40 * .0085);
  assert.equal(r.breakEvenAbsoluteFundingUsdPerBasePerHour, null);
});

test("slippage, capital hurdle and basis/unwind reserves are separate explicit deductions", () => {
  const f = dated(); f.assumptions.slippageBpsPerExecution = 10;
  f.assumptions.annualCapitalHurdleFraction = .12;
  f.assumptions.settlementBasisReserveBps = 20; f.assumptions.unwindReserveBps = 30;
  const r = evaluateCarryEconomics(f), s = r.scenarios[1]!, q = r.allocatedBaseQty;
  const priceCashflow = q * ((100 * .999 - 100 * 1.001) + (110 * .999 - 100 * 1.001));
  near(s.slippageCostUsd, q * .001 * 410);
  near(s.capitalHurdleCostUsd, r.reservedCapitalUsd * .12 * 720 / 8760);
  near(s.settlementBasisReserveUsd, q * .2); near(s.unwindReserveUsd, q * .3);
  near(s.netAfterCostsUsd, priceCashflow - s.fees.totalUsd - s.capitalHurdleCostUsd - q * .5);
});

test("perpetual scenarios do not monetize entry basis or predict continuation of funding", () => {
  const f = fixture(), r = evaluateCarryEconomics(f), q = r.allocatedBaseQty;
  const [current, zero, adverse] = r.scenarios;
  assert.ok(r.entryBasisPerBaseUsd! > 0); assert.equal(current!.grossBasisCaptureUsd, 0);
  near(zero!.executionSpreadCostUsd, q * 20);
  near(current!.netAfterCostsUsd - zero!.netAfterCostsUsd, q * .1 * 24);
  near(adverse!.netAfterCostsUsd - zero!.netAfterCostsUsd, -q * .1 * 24);
  assert.ok(zero!.netAfterCostsUsd < 0 && adverse!.netAfterCostsUsd < zero!.netAfterCostsUsd);
  f.currentFunding!.absoluteUsdPerBasePerHour = -.1;
  const negative = evaluateCarryEconomics(f); near(negative.scenarios[0]!.fundingIncomeUsd, negative.scenarios[2]!.fundingIncomeUsd);
});

test("funding break-even units and annualization reproduce exactly zero scenario net", () => {
  const f = fixture(), first = evaluateCarryEconomics(f);
  near(first.breakEvenAnnualFundingFractionOnSpotNotional,
    first.breakEvenAbsoluteFundingUsdPerBasePerHour! * 8760 / 100_000);
  f.currentFunding!.absoluteUsdPerBasePerHour = first.breakEvenAbsoluteFundingUsdPerBasePerHour!;
  const atBreakEven = evaluateCarryEconomics(f); near(atBreakEven.scenarios[0]!.netAfterCostsUsd, 0);
});

test("unverified account fees or execution evidence never allow activation", () => {
  const f = fixture(); let r = evaluateCarryEconomics(f);
  assert.equal(r.status, "FEASIBLE"); assert.equal(r.evidenceComplete, false); assert.equal(r.activationAllowed, false);
  assert.ok(r.reasons.includes("CARRY_ACCOUNT_FEES_UNVERIFIED") && r.reasons.includes("CARRY_EXECUTION_EVIDENCE_UNVERIFIED"));
  f.fees.accountVerified = true; f.executionEvidenceVerified = true; r = evaluateCarryEconomics(f);
  assert.equal(r.evidenceComplete, true); assert.equal(r.activationAllowed, false);
});

test("stale, future, crossed and unsynchronized books are rejected without mark substitution", () => {
  const cases: Array<[(f: CarryEconomicsInput) => void, string]> = [
    [f => { f.spot.book.exchangeAtMs = T - 5001; }, "CARRY_STALE_BOOK"],
    [f => { f.spot.book.receivedAtMs = T + 1; }, "CARRY_FUTURE_OR_INVALID_QUOTE_TIME"],
    [f => { f.spot.book.exchangeAtMs = T; }, "CARRY_FUTURE_OR_INVALID_QUOTE_TIME"],
    [f => { f.spot.book.bid = f.spot.book.ask; }, "CARRY_INVALID_OR_CROSSED_BOOK"],
    [f => { f.spot.book.ask = NaN; }, "CARRY_INVALID_OR_CROSSED_BOOK"],
    [f => { f.spot.book.exchangeAtMs = T - 1200; }, "CARRY_UNSYNCHRONIZED_BOOKS"],
  ];
  for (const [mutate, reason] of cases) { const f = fixture(); mutate(f); const r = evaluateCarryEconomics(f);
    assert.equal(r.status, "INVALID"); assert.ok(r.reasons.includes(reason)); assert.equal(r.allocatedBaseQty, 0); }
});

test("funding availability is causal and its stale-age policy is explicit", () => {
  let f = fixture(); f.currentFunding!.knownAtMs = T + 1;
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_FUTURE_OR_INVALID_FUNDING"));
  f = fixture(); f.currentFunding!.knownAtMs = T - H - 1;
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_STALE_FUNDING"));
  f = fixture(); delete f.currentFunding;
  const missing = evaluateCarryEconomics(f); assert.equal(missing.status, "FEASIBLE"); assert.equal(missing.scenarios.length, 1);
  assert.equal(missing.scenarios[0]!.name, "PERPETUAL_ZERO_FUNDING"); assert.equal(missing.evidenceComplete, false);
  f = fixture(); delete f.assumptions.maximumFundingAgeMs;
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_FUNDING_AGE_LIMIT_UNSPECIFIED"));
});

test("dated expiry, settlement scenarios and instrument identity cannot be silently substituted", () => {
  let f = dated(); f.derivative.expiryMs = T - 1;
  assert.equal(evaluateCarryEconomics(f).status, "INVALID");
  f = dated(); f.assumptions.holdingHours = 24;
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_INVALID_OR_MISMATCHED_EXPIRY"));
  f = dated(); f.assumptions.settlementSpotPriceScenariosUsd = [];
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_DATED_SETTLEMENT_SCENARIOS_REQUIRED"));
  f = fixture(); f.derivative.base = "ETH";
  assert.ok(evaluateCarryEconomics(f).reasons.includes("CARRY_UNSUPPORTED_INSTRUMENT_PAIR"));
  f = fixture(); f.derivative.instrumentId = f.spot.instrumentId;
  assert.equal(evaluateCarryEconomics(f).status, "INVALID");
});

test("ETH pair allocation uses its own rules and never nets two legs' gross exposure", () => {
  const f = fixture(); f.spot.base = "ETH"; f.derivative.base = "ETH";
  f.spot.instrumentId = "kraken:spot:ETHUSD"; f.derivative.instrumentId = "kraken:perpetual:PF_ETHUSD";
  f.spot.book.bid = 1999; f.spot.book.ask = 2000; f.derivative.book.bid = 2010; f.derivative.book.ask = 2011;
  f.spot.rules = { minimumBaseQty: .001, quantityStep: ".00001", minimumNotionalUsd: .5 };
  f.derivative.rules = { minimumBaseQty: .001, quantityStep: ".001", minimumNotionalUsd: 0 };
  f.budget.availableGrossUsd = 12; const r = evaluateCarryEconomics(f);
  assert.equal(r.status, "FEASIBLE"); near(r.minimumPairedGrossUsd, 4.011); near(r.allocatedBaseQty, .002);
  near(r.allocatedPairedGrossUsd, 8.022); assert.ok(r.allocatedPairedGrossUsd > 2 * .002 * 2000);
});

test("malformed costs and quantities fail explicitly; repeated calls do not mutate inputs", () => {
  for (const mutate of [
    (f: CarryEconomicsInput) => { f.fees.spotTakerBps = NaN; },
    (f: CarryEconomicsInput) => { f.budget.availableCashUsd = -1; },
    (f: CarryEconomicsInput) => { f.assumptions.slippageBpsPerExecution = 10_000; },
    (f: CarryEconomicsInput) => { f.derivative.rules.quantityStep = "not a number"; },
    (f: CarryEconomicsInput) => { f.assumptions.holdingHours = Number.MIN_VALUE; },
  ]) { const f = fixture(); mutate(f); assert.equal(evaluateCarryEconomics(f).status, "INVALID"); }
  const f = fixture(), before = structuredClone(f), first = evaluateCarryEconomics(f);
  assert.deepEqual(evaluateCarryEconomics(f), first); assert.deepEqual(f, before);
});
