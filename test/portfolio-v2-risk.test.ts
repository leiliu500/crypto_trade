import assert from "node:assert/strict";
import test from "node:test";
import { newRiskGovernorState, restoreRiskGovernorState, riskGovernorDecision, RISK_SPEC, updateRiskGovernor,
  validateRiskGovernorState, type RiskGovernorState } from "../src/portfolio-v2/risk.js";
import { applyPortfolioFill, newPortfolioState, planPortfolioAdjustment, reservePortfolioOrders, validatePortfolioState,
  type PortfolioPlannerInput } from "../src/portfolio-v2/kernel.js";
import { planPortfolioAdjustment as legacyPlan } from "../src/portfolio/kernel.js";
import { PORTFOLIO_VERSION, type AssetRules, type Pair, type PortfolioState, type PortfolioTarget } from "../src/portfolio/types.js";

const T = Date.UTC(2024, 0, 1), DAY = 86_400_000;
const near = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance,
  `${actual} != ${expected}`);
const observe = (state: RiskGovernorState, atMs: number, liquidationEquityUsd: number | null, accountingKnown = true) =>
  updateRiskGovernor(state, { atMs, liquidationEquityUsd, accountingKnown });

test("fixed governor starts at the initial equity peak and requires a known pretrade observation", () => {
  const state = newRiskGovernorState(100);
  assert.equal(state.peakLiquidationEquityUsd, 100); assert.equal(riskGovernorDecision(state).maximumGrossNotionalUsd, 0);
  const ready = observe(state, T, 100);
  assert.equal(ready.decision.maximumGrossNotionalUsd, 12); assert.equal(ready.state.dailyReferenceEquityUsd, 100);
  assert.equal(ready.decision.forceFlat, false); assert.equal(RISK_SPEC.drawdownBudgetUsd, 3);
  assert.equal(RISK_SPEC.dailyLossBudgetUsd, 1.2); assert.equal(validateRiskGovernorState(state), true);
});

test("soft capacity is the minimum remaining daily and trailing drawdown budget, not a parameter fit", () => {
  const initial = observe(newRiskGovernorState(100), T, 100).state;
  const daily = observe(initial, T + 1, 99.4); near(daily.decision.maximumGrossNotionalUsd, 6);
  const improved = observe(initial, T + 1, 101).state;
  const drawdown = observe(improved, T + 2, 99.5);
  near(drawdown.decision.drawdownUsd!, 1.5); near(drawdown.decision.dailyLossUsd!, .5);
  near(drawdown.decision.maximumGrossNotionalUsd, 6); near(drawdown.decision.exposureScale, .5);
  const recovered = observe(daily.state, T + 2, 99.8); near(recovered.decision.maximumGrossNotionalUsd, 10);
  assert.equal(recovered.state.peakLiquidationEquityUsd, 100); assert.equal(initial.observations.length, 1);
});

test("daily budget latches at the exact decimal boundary and recovery cannot clear it in the same UTC day", () => {
  const initial = observe(newRiskGovernorState(100_000), T, 100_000).state;
  const breach = observe(initial, T + 1, 99_998.8);
  assert.equal(breach.decision.dailyHalted, true); assert.equal(breach.decision.drawdownHalted, false);
  assert.equal(breach.decision.maximumGrossNotionalUsd, 0);
  const recovery = observe(breach.state, T + 2, 100_001);
  assert.equal(recovery.decision.maximumGrossNotionalUsd, 0); assert.equal(recovery.decision.dailyHalted, true);
  const newDay = observe(recovery.state, T + DAY, 100_001);
  assert.equal(newDay.decision.dailyHalted, false); assert.equal(newDay.decision.maximumGrossNotionalUsd, 12);
});

test("midnight pretrade price/funding belongs to the old day, then same-time fill fees belong to the new day", () => {
  let state = observe(newRiskGovernorState(100), T, 100).state;
  state = observe(state, T + DAY - 1, 99.2).state;
  const boundary = observe(state, T + DAY, 98.7);
  near(boundary.decision.previousDayLossUsd!, 1.3); assert.equal(boundary.decision.previousDayHalted, true);
  near(boundary.state.maximumObservedDailyLossUsd, 1.3);
  assert.equal(boundary.state.dailyReferenceEquityUsd, 98.7); assert.equal(boundary.decision.dailyLossUsd, 0);
  assert.equal(boundary.decision.dailyHalted, false);
  const postfill = observe(boundary.state, T + DAY, 98.6);
  near(postfill.decision.dailyLossUsd!, .1); assert.equal(postfill.state.dailyReferenceEquityUsd, 98.7);
  assert.equal(postfill.decision.previousDayLossUsd, null);
});

test("hard drawdown breach is permanent across equity recovery, new peaks, new days and JSON restart", () => {
  const first = observe(newRiskGovernorState(100), T, 100).state;
  const breach = observe(first, T + DAY, 97);
  assert.equal(breach.decision.previousDayHalted, true); assert.equal(breach.decision.drawdownHalted, true);
  assert.equal(breach.decision.maximumGrossNotionalUsd, 0);
  const restored = restoreRiskGovernorState(JSON.parse(JSON.stringify(breach.state)), T + DAY + 1);
  const recovery = observe(restored, T + DAY + 1, 105);
  assert.equal(recovery.state.peakLiquidationEquityUsd, 105); assert.equal(recovery.state.maximumDrawdownUsd, 3);
  assert.equal(recovery.decision.drawdownUsd, 0); assert.equal(recovery.decision.drawdownHalted, true);
  assert.equal(observe(recovery.state, T + 2 * DAY, 105).decision.maximumGrossNotionalUsd, 0);
});

test("unknown accounting permanently forces flat and uncertain equities cannot manufacture a new peak", () => {
  for (const [equity, known] of [[null, true], [null, false], [500, false]] as const) {
    const initial = observe(newRiskGovernorState(100), T, 100).state;
    const unknown = observe(initial, T + 1, equity, known);
    assert.equal(unknown.decision.accountingHalted, true); assert.equal(unknown.decision.forceFlat, true);
    assert.equal(unknown.state.peakLiquidationEquityUsd, 100); assert.equal(unknown.decision.drawdownUsd, null);
    const restored = restoreRiskGovernorState(JSON.parse(JSON.stringify(unknown.state)), T + 2);
    assert.equal(observe(restored, T + DAY, 101).decision.maximumGrossNotionalUsd, 0);
  }
});

test("missing a daily boundary reference is unknown accounting, never an invented delayed reset", () => {
  const initial = observe(newRiskGovernorState(100), T, 100).state;
  assert.equal(observe(initial, T + DAY + 1, 100).decision.accountingHalted, true);
  assert.equal(observe(initial, T + 2 * DAY, 100).decision.accountingHalted, true);
  assert.equal(observe(initial, T + DAY, 100).decision.accountingHalted, false);
});

test("ordered same-time receipts are causal; reversed time rejects without mutating prior state", () => {
  const first = observe(newRiskGovernorState(100), T, 100).state;
  const postfill = observe(first, T, 99.99); near(postfill.decision.dailyLossUsd!, .01);
  assert.equal(first.lastLiquidationEquityUsd, 100); assert.equal(first.observations.length, 1);
  assert.throws(() => observe(postfill.state, T - 1, 101), /REVERSED_TIME/);
  const priorHash = postfill.state.stateSha256; observe(postfill.state, T + 1, 200);
  assert.equal(postfill.state.stateSha256, priorHash);
  assert.equal(Object.isFrozen(postfill.state), true); assert.equal(Object.isFrozen(postfill.state.observations), true);
  assert.equal(Object.isFrozen(postfill.state.observations[0]), true);
});

test("risk checkpoints validate full history and hashes, reject future receipts and preserve exact decisions", () => {
  let state = observe(newRiskGovernorState(100), T, 100).state;
  state = observe(state, T + 1, 99).state;
  const decoded = JSON.parse(JSON.stringify(state)), restored = restoreRiskGovernorState(decoded, T + 1);
  assert.deepEqual(restored, state); assert.deepEqual(riskGovernorDecision(restored), riskGovernorDecision(state));
  assert.equal(validateRiskGovernorState(decoded, T), false);
  assert.throws(() => restoreRiskGovernorState(decoded, T), /INVALID_CHECKPOINT/);
  for (const mutate of [((s: typeof decoded) => { s.peakLiquidationEquityUsd = 99; }),
    ((s: typeof decoded) => { s.observations[1].liquidationEquityUsd = 100; }),
    ((s: typeof decoded) => { s.observations.reverse(); }),
    ((s: typeof decoded) => { s.observationsSha256 = "0".repeat(64); }),
    ((s: typeof decoded) => { s.dailyHalted = true; })]) {
    const bad = structuredClone(decoded); mutate(bad); assert.equal(validateRiskGovernorState(bad, T + 2), false);
    assert.throws(() => updateRiskGovernor(bad, { atMs: T + 2, liquidationEquityUsd: 100, accountingKnown: true }), /INVALID_STATE/);
  }
});

test("malformed observations and overflowing accounting reject rather than assigning zero risk", () => {
  const initial = newRiskGovernorState(100);
  for (const bad of [{ atMs: NaN, liquidationEquityUsd: 100, accountingKnown: true },
    { atMs: T, liquidationEquityUsd: Infinity, accountingKnown: true },
    { atMs: T, liquidationEquityUsd: 100, accountingKnown: "yes" }])
    assert.throws(() => updateRiskGovernor(initial, bad as never), /INVALID_OBSERVATION/);
  assert.throws(() => newRiskGovernorState(0), /INVALID_INITIAL/);
  const huge = observe(newRiskGovernorState(Number.MAX_VALUE), T, Number.MAX_VALUE).state;
  assert.throws(() => observe(huge, T + 1, -Number.MAX_VALUE), /OVERFLOW/);
});

const rules: Pair<AssetRules> = {
  "BTC/USD": { symbol: "BTC/USD", minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: 1, maximumOrderQty: 1200, shortable: true },
  "ETH/USD": { symbol: "ETH/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .1, maximumOrderQty: 21000, shortable: true },
};
function target(btc: number, eth: number, atMs = T): PortfolioTarget {
  return { version: PORTFOLIO_VERSION, policy: "multiscale-trend", decisionMs: atMs, availableAtMs: atMs,
    validUntilMs: atMs + 2 * DAY, inputSha256: "fixture", targetUsd: { "BTC/USD": btc, "ETH/USD": eth }, signals: [] };
}
function input(btc = 0, eth = 0, state = newPortfolioState(), cap = 12): PortfolioPlannerInput {
  return { state, target: target(btc, eth), atMs: T, feeBps: 5, maximumGrossNotionalUsd: cap, rules: structuredClone(rules), quotes: {
    "BTC/USD": { symbol: "BTC/USD", atMs: T, bid: 100_000, ask: 100_000, bidQty: 1, askQty: 1 },
    "ETH/USD": { symbol: "ETH/USD", atMs: T, bid: 2000, ask: 2000, bidQty: 1, askQty: 1 } } };
}
function fillAll(i: PortfolioPlannerInput): PortfolioState {
  const plan = planPortfolioAdjustment(i); let state = reservePortfolioOrders(i.state, plan);
  for (const order of plan.orders) state = applyPortfolioFill(state, { id: `fill:${order.id}`, orderId: order.id, symbol: order.symbol,
    atMs: T, signedQty: order.signedQty, price: order.limitPrice, feeUsd: Math.abs(order.signedQty) * order.limitPrice * i.feeBps / 10_000 });
  return state;
}

test("v2 cap defaults to12 and reproduces v1 allocation without changing the sealed kernel", () => {
  const i = input(6, 6); delete i.maximumGrossNotionalUsd;
  const { maximumGrossNotionalUsd, ...v2 } = planPortfolioAdjustment(i);
  assert.equal(maximumGrossNotionalUsd, 12); assert.deepEqual(v2, legacyPlan(i));
});

test("smaller caps choose feasible lots and leave cash instead of secretly rounding BTC up", () => {
  const plan = planPortfolioAdjustment(input(3, 3, undefined, 6));
  assert.equal(plan.executableQty["BTC/USD"], 0); assert.ok(plan.grossNotionalUsd <= 6);
  assert.equal(plan.maximumGrossNotionalUsd, 6);
  const belowLot = planPortfolioAdjustment(input(.5, .5, undefined, 1));
  assert.equal(belowLot.orders.length, 0); assert.equal(belowLot.grossNotionalUsd, 0); assert.equal(belowLot.unusedCapacityUsd, 1);
  const state = reservePortfolioOrders(newPortfolioState(), plan); assert.equal(validatePortfolioState(state), true);
});

test("a smaller dynamic cap bypasses the same-side deadband when current inventory is over cap", () => {
  const state = fillAll(input(0, 8)), legacy = planPortfolioAdjustment(input(0, 7, state, 12));
  assert.equal(legacy.status, "HOLD");
  const reduced = planPortfolioAdjustment(input(0, 7, state, 6));
  assert.equal(reduced.status, "REDUCE"); assert.equal(reduced.executableQty["ETH/USD"], .003);
  assert.equal(reduced.grossNotionalUsd, 6); assert.ok(reduced.orders.every(o => o.reduceOnly));
  reservePortfolioOrders(state, reduced);
});

test("zero cap is a valid flat objective and safely reduces existing inventory without dividing by zero", () => {
  const empty = planPortfolioAdjustment(input(12, 0, undefined, 0));
  assert.equal(empty.status, "HOLD"); assert.equal(empty.grossNotionalUsd, 0); assert.equal(empty.unusedCapacityUsd, 0);
  assert.deepEqual(empty.desiredUsd, { "BTC/USD": 0, "ETH/USD": 0 });
  const state = fillAll(input(0, 8)), reduce = planPortfolioAdjustment(input(12, 0, state, 0));
  assert.equal(reduce.status, "REDUCE"); assert.equal(reduce.grossNotionalUsd, 0);
  assert.ok(Number.isFinite(reduce.estimatedAdjustmentCostUsd)); assert.equal(reservePortfolioOrders(state, reduce).pending.length, 1);
});

test("risk reduction may execute partially above the new cap but can never mix in increases", () => {
  const state = fillAll(input(0, 8)), i = input(6, 0, state, 0); i.quotes["ETH/USD"].bidQty = .001;
  const plan = planPortfolioAdjustment(i);
  assert.equal(plan.status, "REDUCE"); assert.equal(plan.grossNotionalUsd, 6);
  assert.equal(plan.orders.length, 1); assert.equal(plan.orders[0]!.symbol, "ETH/USD");
  assert.equal(plan.orders[0]!.reduceOnly, true); reservePortfolioOrders(state, plan);
});

test("dynamic cap is mandatory reservation metadata and invalid values or overstated lots reject", () => {
  const i = input(0, 6, undefined, 6), plan = planPortfolioAdjustment(i);
  assert.equal(plan.grossNotionalUsd, 6);
  assert.throws(() => reservePortfolioOrders(i.state, { ...plan, maximumGrossNotionalUsd: 5 }), /CAP_OR_QUANTITY/);
  const noCap = { ...plan }; delete (noCap as Partial<typeof noCap>).maximumGrossNotionalUsd;
  assert.throws(() => reservePortfolioOrders(i.state, noCap), /INVALID_PLAN/);
  for (const cap of [-1, 12.01, NaN, Infinity, null, "6"]) {
    const bad = { ...i, maximumGrossNotionalUsd: cap } as PortfolioPlannerInput;
    assert.throws(() => planPortfolioAdjustment(bad), /INVALID_DYNAMIC_CAP/);
  }
});

test("the tracking objective retains its fixed12 USD denominator as dynamic capacity shrinks", () => {
  const i = input(.8, 0, undefined, 6); i.feeBps = 700;
  for (const symbol of ["BTC/USD", "ETH/USD"] as const) {
    i.rules[symbol] = { ...i.rules[symbol], minOrderSize: 1, minTradeIncrement: 1, priceIncrement: .01 };
    Object.assign(i.quotes[symbol], { bid: 1, ask: 1, bidQty: 10, askQty: 10 });
  }
  // Flat loss=.8^2/12=.0533. One lot loss=.2^2/12+.07=.0733.
  // Dividing by6 instead would wrongly prefer the one-lot order.
  assert.equal(planPortfolioAdjustment(i).orders.length, 0);
  assert.equal(planPortfolioAdjustment({ ...i, maximumGrossNotionalUsd: 12 }).orders.length, 0);
});

test("governor cap is applied to original targets exactly once and survives ledger roundtrip", () => {
  const initial = observe(newRiskGovernorState(100), T, 100).state;
  const risk = observe(initial, T + 1, 99.4).decision;
  const i = input(0, 12 * risk.exposureScale, undefined, risk.maximumGrossNotionalUsd);
  const plan = planPortfolioAdjustment(i); assert.equal(plan.grossNotionalUsd, 6);
  const state = fillAll(i); assert.equal(validatePortfolioState(JSON.parse(JSON.stringify(state))), true);
  near(state.positions["ETH/USD"].qty, .003);
});
