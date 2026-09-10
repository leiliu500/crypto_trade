import assert from "node:assert/strict";
import test from "node:test";
import { applyCarryInventoryPair, boundCarryInventoryEquity, carryInventoryExecution, markCarryInventory,
  newCarryInventory, observeCarryInventoryFunding, restoreCarryInventoryState, validateCarryInventoryState,
  type CarryInventoryConfig, type CarryInventoryPair } from "../src/carry/inventory.js";
const T = Date.UTC(2026, 0, 1), H = 3_600_000;
function config(overrides: Partial<CarryInventoryConfig> = {}): CarryInventoryConfig {
  return { startedAtMs: T, spot: { instrumentId: "kraken:SPOT:BTC/USD", minQty: .0001, qtyIncrement: .0001, priceIncrement: .1 },
    future: { instrumentId: "kraken:LINEAR_PERPETUAL:PF_XBTUSD", minQty: .0001, qtyIncrement: .0001, priceIncrement: 1 },
    spotCashUsd: 1010, derivativeCollateralUsd: 2000, maximumLegNotionalUsd: 1000,
    initialMarginFraction: .2, maintenanceMarginFraction: .2, spotExitFeeBps: 80, futureExitFeeBps: 5, ...overrides };
}
function pair(id: string, atMs = T, kind: "ENTER" | "REDUCE" = "ENTER", qty = 2,
  spotPrice = 100, futurePrice = 102, spotFee = 1, futureFee = .1): CarryInventoryPair {
  return { id, atMs, kind, qty, spot: { price: spotPrice, feeUsd: spotFee }, future: { price: futurePrice, feeUsd: futureFee } };
}
function rate(endMs = T + H, amount = .2, knownAtMs = endMs) {
  return { id: `rate:${endMs}`, intervalEndMs: endMs, absoluteUsdPerBasePerHour: amount, knownAtMs };
}
function near(actual: number | null, expected: number) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test("matched partial reductions preserve separate spot cash, derivative cash and every fee", () => {
  let state = applyCarryInventoryPair(newCarryInventory(config()), pair("entry"));
  near(state.spotCashUsd, 809); near(state.derivativeCollateralUsd, 1999.9);
  state = applyCarryInventoryPair(state, pair("partial", T + H / 2, "REDUCE", 1, 110, 112, .5, .05));
  state = observeCarryInventoryFunding(state, rate(), T + H);
  near(state.fundingCashUsd, .3);
  state = applyCarryInventoryPair(state, pair("exit", T + H, "REDUCE", 1, 115, 114, .6, .06));
  const marked = markCarryInventory(state, { atMs: T + H, spotPrice: 115, futurePrice: 114 });
  near(marked.spot.grossPricePnlUsd, 25); near(marked.future.grossPricePnlUsd, -22);
  near(marked.spot.feesUsd, 2.1); near(marked.future.feesUsd, .21);
  near(marked.cash.spotUsd, 1032.9); near(marked.cash.derivativeCollateralUsd, 1978.09);
  near(marked.cashNetPnlUsd, .99); near(marked.markedNetPnlUsd, .99);
  near(marked.equityUsd, 3010.99); near(marked.liquidationEquityUsd, 3010.99);
  assert.equal(marked.matchedBaseQty, 0); assert.equal(marked.margin.covered, true);
  near(marked.peakCapitalDeployedUsd, 2201);
});

test("absolute funding uses actual partial-hour quantity and credits or debits the short", () => {
  let state = applyCarryInventoryPair(newCarryInventory(config()), pair("entry", T + H / 4, "ENTER", 2, 100, 102, 0, 0));
  state = applyCarryInventoryPair(state, pair("exit", T + H * .75, "REDUCE", 2, 100, 102, 0, 0));
  state = observeCarryInventoryFunding(state, rate(T + H, -3), T + H);
  near(state.fundingCashUsd, -3);
  const mark = markCarryInventory(state, { atMs: T + 2 * H, spotPrice: 100, futurePrice: 102 });
  assert.equal(mark.fundingKnown, true); near(mark.cashNetPnlUsd, -3);
  assert.equal(mark.missingFundingMs, 0, "flat future hours do not require rates");
});

test("missing held intervals remain unknown until actual late rate evidence fills the gap", () => {
  let state = applyCarryInventoryPair(newCarryInventory(config()), pair("entry", T, "ENTER", 1, 100, 102, 0, 0));
  state = observeCarryInventoryFunding(state, rate(), T + H);
  state = applyCarryInventoryPair(state, pair("exit", T + 3 * H, "REDUCE", 1, 100, 102, 0, 0));
  state = observeCarryInventoryFunding(state, rate(T + 3 * H, .4), T + 3 * H);
  let mark = markCarryInventory(state, { atMs: T + 3 * H, spotPrice: 100, futurePrice: 102 });
  assert.equal(mark.fundingKnown, false); assert.equal(mark.fundingCashUsd, null);
  assert.equal(mark.equityUsd, null); assert.equal(mark.margin.covered, null);
  near(mark.knownFundingCashUsd, .6); assert.equal(mark.missingFundingMs, H);
  assert.throws(() => applyCarryInventoryPair(state, pair("new-entry", T + 3 * H, "ENTER", 1)), /PRIOR_FUNDING_UNKNOWN/);
  state = observeCarryInventoryFunding(state, rate(T + 2 * H, .3, T + 3 * H), T + 3 * H);
  mark = markCarryInventory(state, { atMs: T + 3 * H, spotPrice: 100, futurePrice: 102 });
  assert.equal(mark.fundingKnown, true); near(mark.fundingCashUsd, .9); near(mark.cashNetPnlUsd, .9);
});

test("half-open hour boundaries do not charge entry for the preceding hour and do charge a boundary exit", () => {
  let state = newCarryInventory(config());
  state = observeCarryInventoryFunding(state, rate(), T + H);
  state = applyCarryInventoryPair(state, pair("entry", T + H, "ENTER", 1, 100, 102, 0, 0));
  near(state.fundingCashUsd, 0);
  const unknown = markCarryInventory(state, { atMs: T + H * 1.5, spotPrice: 100, futurePrice: 102 });
  assert.equal(unknown.fundingKnown, false); assert.equal(unknown.missingFundingMs, H / 2);
  state = observeCarryInventoryFunding(state, rate(T + 2 * H, .5), T + 2 * H);
  state = applyCarryInventoryPair(state, pair("exit", T + 2 * H, "REDUCE", 1, 100, 102, 0, 0));
  near(state.fundingCashUsd, .5);
});

test("spot gains cannot cover a segregated derivative margin deficit", () => {
  const cfg = config({ spotCashUsd: 250, derivativeCollateralUsd: 200 });
  const state = applyCarryInventoryPair(newCarryInventory(cfg), pair("entry", T, "ENTER", 2, 100, 100, 0, 0));
  const mark = markCarryInventory(state, { atMs: T, spotPrice: 200, futurePrice: 200 });
  near(mark.markedNetPnlUsd, 0); near(mark.equityUsd, 450);
  near(mark.margin.requiredMarginUsd, 80); near(mark.margin.derivativeEquityUsd, 0);
  assert.equal(mark.margin.covered, false); assert.equal(mark.cash.spotUsd, 50);
  assert.equal(mark.cash.derivativeCollateralUsd, 200, "marking does not transfer or settle unrealized P&L");
  assert.throws(() => applyCarryInventoryPair(newCarryInventory(config({ spotCashUsd: 100, derivativeCollateralUsd: 10_000 })),
    pair("spot-insufficient")), /SPOT_CASH_INSUFFICIENT/);
  assert.throws(() => applyCarryInventoryPair(newCarryInventory(config({ spotCashUsd: 10_000, derivativeCollateralUsd: 10 })),
    pair("future-insufficient")), /DERIVATIVE_COLLATERAL_INSUFFICIENT/);
});

test("independent spot/future extrema give explicit conservative equity bounds without inventing chronology", () => {
  const state = applyCarryInventoryPair(newCarryInventory(config()), pair("entry", T, "ENTER", 2, 100, 102, 0, 0));
  const bounds = boundCarryInventoryEquity(state, { atMs: T, spotLow: 90, spotHigh: 110, futureLow: 98, futureHigh: 130 });
  near(bounds.equityLowerUsd, 3010 - 76); near(bounds.equityUpperUsd, 3010 + 28);
  assert.equal(bounds.synchronizedDrawdownUsd, null); assert.match(bounds.interpretation, /NOT_SYNCHRONIZED_DRAWDOWN/);
  near(bounds.worstDerivativeMargin.requiredMarginUsd, 52);
  assert.ok(bounds.liquidationEquityLowerUsd! < bounds.equityLowerUsd!);
});

test("independent adverse execution prices retain each fee and tick cost", () => {
  const buy = carryInventoryExecution({ side: 1, qty: 2, referencePrice: 100.04, slippageBps: 2, feeBps: 80, priceIncrement: .1 });
  const sell = carryInventoryExecution({ side: -1, qty: 2, referencePrice: 102.04, slippageBps: 2, feeBps: 5, priceIncrement: 1 });
  near(buy.price, 100.1); near(sell.price, 102);
  near(buy.feeUsd, 2 * 100.1 * .008); near(sell.feeUsd, 2 * 102 * .0005);
  assert.ok(buy.slippageUsd > 0); assert.ok(sell.slippageUsd > 0);
  const aligned = carryInventoryExecution({ side: -1, qty: 1, referencePrice: 100.1, slippageBps: 0, feeBps: 0, priceIncrement: .1 });
  assert.equal(aligned.price, 100.1); assert.equal(aligned.slippageUsd, 0, "binary division cannot create a phantom adverse tick");
});

test("receipt replay and JSON checkpoint recovery are idempotent and reject altered accounting", () => {
  const entry = pair("entry"), funding = rate();
  let state = applyCarryInventoryPair(newCarryInventory(config()), entry);
  state = observeCarryInventoryFunding(state, funding, T + H);
  const raw = JSON.parse(JSON.stringify(state)), restored = restoreCarryInventoryState(raw, T + H);
  assert.equal(applyCarryInventoryPair(restored, entry), restored);
  assert.equal(observeCarryInventoryFunding(restored, funding, T + H), restored);
  assert.throws(() => applyCarryInventoryPair(restored, { ...entry, qty: 1 }), /CONFLICTING_PAIR/);
  assert.throws(() => observeCarryInventoryFunding(restored, { ...funding, absoluteUsdPerBasePerHour: 10 }, T + H), /CONFLICTING_FUNDING/);
  assert.throws(() => observeCarryInventoryFunding(restored, { ...funding, id: "other-id" }, T + H), /DUPLICATE_FUNDING_INTERVAL/);
  raw.derivativeCollateralUsd += 1; assert.equal(validateCarryInventoryState(raw), false);
  assert.throws(() => restoreCarryInventoryState(raw, T + H), /CHECKPOINT/);
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.events));
});

test("invalid clocks, mismatched assets, invalid lots, future knowledge and over-reduction fail closed", () => {
  const cfg = config(), state = newCarryInventory(cfg);
  assert.throws(() => newCarryInventory({ ...cfg, future: { ...cfg.future, instrumentId: "kraken:LINEAR_PERPETUAL:PF_ETHUSD" } }), /CONFIG/);
  assert.throws(() => applyCarryInventoryPair(state, pair("small", T, "ENTER", .00001)), /INVALID_PAIR/);
  assert.throws(() => applyCarryInventoryPair(state, pair("old", T - 1)), /TIME/);
  assert.throws(() => applyCarryInventoryPair(state, pair("cap", T, "ENTER", 20)), /NOTIONAL_CAP/);
  assert.throws(() => observeCarryInventoryFunding(state, rate(), T + H - 1), /FUTURE_FUNDING/);
  assert.throws(() => observeCarryInventoryFunding(state, rate(T + H, .1, T), T + H), /FUTURE_FUNDING/);
  const entered = applyCarryInventoryPair(state, pair("entry"));
  assert.throws(() => applyCarryInventoryPair(entered, pair("over", T, "REDUCE", 3)), /OVER_REDUCTION/);
  assert.throws(() => markCarryInventory(entered, { atMs: T, spotPrice: NaN, futurePrice: 100 }), /INVALID_MARK/);
  assert.throws(() => boundCarryInventoryEquity(entered, { atMs: T, spotLow: 110, spotHigh: 100, futureLow: 100, futureHigh: 110 }), /BOUNDS/);
});

test("tiny but representable continuous funding survives exact-rational denominators", () => {
  let state = applyCarryInventoryPair(newCarryInventory(config()), pair("tiny", T, "ENTER", .0001, 100, 102, 0, 0));
  state = observeCarryInventoryFunding(state, rate(T + H, 1e-300), T + H);
  assert.ok(state.fundingCashUsd > 0); assert.equal(state.fundingCashUsd, 1e-304);
});
