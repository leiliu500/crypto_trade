import assert from "node:assert/strict";
import test from "node:test";
import { applyPortfolioFill, applyPortfolioFunding, cancelPortfolioOrder, newPortfolioState,
  planPortfolioAdjustment, portfolioEquity, reservePortfolioOrders, validatePortfolioState } from "../src/portfolio/kernel.js";
import { PORTFOLIO_VERSION, type AssetRules, type Pair, type PortfolioFill, type PortfolioPlannerInput,
  type PortfolioState, type PortfolioTarget } from "../src/portfolio/types.js";

const T = Date.UTC(2024, 0, 1);
const rules: Pair<AssetRules> = {
  "BTC/USD": { symbol: "BTC/USD", minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: 1, maximumOrderQty: 1200, shortable: true },
  "ETH/USD": { symbol: "ETH/USD", minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .1, maximumOrderQty: 21000, shortable: true },
};
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function target(btc: number, eth: number, atMs = T): PortfolioTarget {
  return { version: PORTFOLIO_VERSION, policy: "multiscale-trend", decisionMs: atMs, availableAtMs: atMs,
    validUntilMs: atMs + 172_800_000, inputSha256: "fixture", targetUsd: { "BTC/USD": btc, "ETH/USD": eth }, signals: [] };
}
function input(btc = 0, eth = 0, state = newPortfolioState(), atMs = T): PortfolioPlannerInput {
  return { state, target: target(btc, eth, atMs), atMs, feeBps: 5, rules: structuredClone(rules), quotes: {
    "BTC/USD": { symbol: "BTC/USD", atMs, bid: 99_999, ask: 100_000, bidQty: 1, askQty: 1 },
    "ETH/USD": { symbol: "ETH/USD", atMs, bid: 1999.9, ask: 2000, bidQty: 1, askQty: 1 },
  } };
}
function setPrice(i: PortfolioPlannerInput, s: "BTC/USD" | "ETH/USD", price: number) {
  i.quotes[s].bid = price; i.quotes[s].ask = price;
}
function fillAll(i: PortfolioPlannerInput): PortfolioState {
  const p = planPortfolioAdjustment(i);
  let s = reservePortfolioOrders(i.state, p);
  for (const o of p.orders) s = applyPortfolioFill(s, { id: `fill:${o.id}`, orderId: o.id, symbol: o.symbol,
    atMs: i.atMs, signedQty: o.signedQty, price: o.limitPrice, feeUsd: Math.abs(o.signedQty) * o.limitPrice * i.feeBps / 10000 });
  return s;
}

test("joint lot allocation finds BTC10 + ETH2 for a 6/6 USD target under one12 USD cap", () => {
  const i = input(6, 6), p = planPortfolioAdjustment(i);
  assert.equal(p.status, "INCREASE"); assert.equal(p.orders.length, 2);
  assert.equal(p.executableQty["BTC/USD"], .0001); assert.equal(p.executableQty["ETH/USD"], .001);
  assert.equal(p.grossNotionalUsd, 12); assert.equal(p.unusedCapacityUsd, 0);
  assert.ok(p.orders.every(o => !o.reduceOnly)); assert.deepEqual(planPortfolioAdjustment(i), p);
  assert.deepEqual(i.state, newPortfolioState());
});

test("lot allocation can leave BTC flat when its minimum lot makes the pair worse", () => {
  const i = input(6, 6); setPrice(i, "ETH/USD", 3000);
  const p = planPortfolioAdjustment(i);
  assert.equal(p.executableQty["BTC/USD"], 0); assert.equal(p.executableQty["ETH/USD"], .002);
  assert.equal(p.grossNotionalUsd, 6);
});

test("constant target holds existing lots without fees or periodic close-and-reopen", () => {
  const s = fillAll(input(12, 0)), i = input(12, 0, s, T + 3600000);
  const p = planPortfolioAdjustment(i); assert.equal(p.status, "HOLD"); assert.equal(p.orders.length, 0);
  assert.equal(p.estimatedAdjustmentCostUsd, 0);
  assert.deepEqual(reservePortfolioOrders(s, p), s);
  close(s.totalFeesUsd, .005); close(s.totalTurnoverUsd, 10);
});

test("25 percent same-side deadband suppresses resize while target zero always reduces", () => {
  const s = fillAll(input(0, 8));
  assert.equal(planPortfolioAdjustment(input(0, 6.5, s)).status, "HOLD");
  const zero = planPortfolioAdjustment(input(0, 0, s));
  assert.equal(zero.status, "REDUCE"); assert.equal(zero.orders[0]!.signedQty, -.004);
  assert.equal(zero.executableQty["ETH/USD"], 0);
});

test("reversal closes confirmed inventory first, then separately opens opposite lots", () => {
  const s = fillAll(input(0, 8)), i = input(0, -8, s, T + 1000), reduction = planPortfolioAdjustment(i);
  assert.equal(reduction.status, "REDUCE"); assert.equal(reduction.orders.length, 1);
  assert.equal(reduction.orders[0]!.signedQty, -.004); assert.equal(reduction.executableQty["ETH/USD"], 0);
  const pending = reservePortfolioOrders(s, reduction);
  assert.equal(planPortfolioAdjustment(input(0, -8, pending, T + 2000)).status, "WAIT");
  const flat = fillAll(i), reopening = planPortfolioAdjustment(input(0, -8, flat, T + 2000));
  assert.equal(reopening.status, "INCREASE"); assert.ok(reopening.orders[0]!.signedQty < 0);
  assert.equal(reopening.orders[0]!.reduceOnly, false);
  assert.notEqual(reopening.orders[0]!.id, reduction.orders[0]!.id);
});

test("switching assets releases old risk only after reduction receipts", () => {
  const s = fillAll(input(12, 0)), p = planPortfolioAdjustment(input(0, 12, s));
  assert.equal(p.status, "REDUCE"); assert.equal(p.orders.length, 1); assert.equal(p.orders[0]!.symbol, "BTC/USD");
  assert.equal(p.executableQty["ETH/USD"], 0);
});

test("partial fills retain pending quantity and block all second-asset reservations", () => {
  const i = input(0, 8), p = planPortfolioAdjustment(i), o = p.orders[0]!;
  const reserved = reservePortfolioOrders(i.state, p);
  const partial: PortfolioFill = { id: "partial", orderId: o.id, symbol: o.symbol, atMs: T,
    signedQty: .001, price: o.limitPrice, feeUsd: .001 };
  const s = applyPortfolioFill(reserved, partial);
  close(s.positions["ETH/USD"].qty, .001); close(s.pending[0]!.remainingQty, .003);
  assert.equal(planPortfolioAdjustment(input(12, 0, s)).status, "WAIT");
  assert.throws(() => reservePortfolioOrders(s, p), /PENDING/);
  assert.deepEqual(applyPortfolioFill(s, partial), s);
  assert.throws(() => applyPortfolioFill(s, { ...partial, feeUsd: .002 }), /CONFLICTING_FILL/);
  const canceled = cancelPortfolioOrder(s, o.id);
  assert.equal(canceled.pending.length, 0); assert.equal(canceled.positions["ETH/USD"].qty, .001);
  assert.deepEqual(cancelPortfolioOrder(canceled, o.id), canceled);
});

test("decimal partial-fill remainder refills to exactly the cap without a floating overage", () => {
  const i = input(12, 0); setPrice(i, "BTC/USD", 100);
  Object.assign(i.rules["BTC/USD"], { minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01 });
  const p = planPortfolioAdjustment(i), o = p.orders[0]!;
  let s = applyPortfolioFill(reservePortfolioOrders(i.state, p), { id: "decimal-partial", orderId: o.id,
    symbol: o.symbol, atMs: T, signedQty: .05, price: 100, feeUsd: .0025 });
  assert.equal(s.pending[0]!.remainingQty, .07); s = cancelPortfolioOrder(s, o.id);
  const nextInput = { ...i, state: s, atMs: T + 1000 }, next = planPortfolioAdjustment(nextInput);
  assert.equal(next.orders[0]!.signedQty, .07); assert.equal(next.grossNotionalUsd, 12);
  s = applyPortfolioFill(reservePortfolioOrders(s, next), { id: "decimal-rest", orderId: next.orders[0]!.id,
    symbol: o.symbol, atMs: T + 1000, signedQty: .07, price: 100, feeUsd: .0035 });
  assert.equal(s.positions["BTC/USD"].qty, .12);
  assert.equal(portfolioEquity(s, { "BTC/USD": 100, "ETH/USD": 2000 }).grossNotionalUsd, 12);
  assert.equal(validatePortfolioState(JSON.parse(JSON.stringify(s))), true);
});

test("fills reject overfills, wrong symbols, prior times and execution outside limit", () => {
  const i = input(0, 8), p = planPortfolioAdjustment(i), o = p.orders[0]!, s = reservePortfolioOrders(i.state, p);
  const f: PortfolioFill = { id: "fill", orderId: o.id, symbol: o.symbol, atMs: T, signedQty: o.signedQty, price: o.limitPrice, feeUsd: .001 };
  for (const bad of [{ ...f, signedQty: Number((o.signedQty + 1e-12).toFixed(12)) }, { ...f, signedQty: -o.signedQty },
    { ...f, symbol: "BTC/USD" as const }, { ...f, atMs: T - 1 }, { ...f, price: o.limitPrice + .01 }])
    assert.throws(() => applyPortfolioFill(s, bad), /FILL_ORDER_MISMATCH/);
  assert.equal(s.positions["ETH/USD"].qty, 0);
});

test("weighted additions and partial closes reconcile realized/unrealized PnL with fees once", () => {
  let s = fillAll(input(0, 4));
  const add = input(0, 12, s, T + 1000); setPrice(add, "ETH/USD", 1800); s = fillAll(add);
  close(s.positions["ETH/USD"].qty, .006); close(s.positions["ETH/USD"].averagePrice, 11.2 / .006);
  const reduce = input(0, 5.7, s, T + 2000); setPrice(reduce, "ETH/USD", 1900);
  s = fillAll(reduce); close(s.positions["ETH/USD"].qty, .003); close(s.realizedPricePnlUsd, .1);
  close(s.totalFeesUsd, (4 + 7.2 + 5.7) * .0005); close(s.totalTurnoverUsd, 16.9);
  const equity = portfolioEquity(s, { "BTC/USD": 100000, "ETH/USD": 1900 });
  close(equity.unrealizedPnlUsd, .1); close(equity.equityUsd, 100000 + .2 - s.totalFeesUsd);
});

test("short positions realize correct signs and close without reversing", () => {
  const i = input(0, -8); setPrice(i, "ETH/USD", 2000); let s = fillAll(i);
  const closeInput = input(0, 0, s, T + 1000); setPrice(closeInput, "ETH/USD", 1800); s = fillAll(closeInput);
  close(s.realizedPricePnlUsd, .8); close(s.cashUsd, 100000 + .8 - .0076);
  assert.deepEqual(s.positions["ETH/USD"], { qty: 0, averagePrice: 0 }); assert.equal(validatePortfolioState(s), true);
});

test("marked-over-cap inventory reduces even inside its normal resizing band", () => {
  const s = fillAll(input(12, 0)), i = input(12, 0, s); setPrice(i, "BTC/USD", 140000);
  const p = planPortfolioAdjustment(i); assert.equal(p.status, "REDUCE"); assert.equal(p.executableQty["BTC/USD"], 0);
  assert.equal(reservePortfolioOrders(s, p).pending[0]!.reduceOnly, true);
});

test("partial risk reductions remain legal above cap but no increase joins them", () => {
  const s = fillAll(input(0, 12)), i = input(6, 6, s); setPrice(i, "ETH/USD", 4000); i.quotes["ETH/USD"].bidQty = .001;
  const p = planPortfolioAdjustment(i); assert.equal(p.status, "REDUCE"); assert.equal(p.orders.length, 1);
  assert.equal(p.orders[0]!.signedQty, -.001); assert.ok(p.grossNotionalUsd > 12);
  assert.doesNotThrow(() => reservePortfolioOrders(s, p));
});

test("stale/future quotes and insufficient depth never create an order", () => {
  for (const delta of [-5001, 1]) {
    const i = input(12, 0); i.quotes["BTC/USD"].atMs += delta;
    const p = planPortfolioAdjustment(i); assert.equal(p.status, "BLOCKED"); assert.equal(p.orders.length, 0);
  }
  const thin = input(12, 0); thin.quotes["BTC/USD"].askQty = .00009;
  assert.equal(planPortfolioAdjustment(thin).orders.length, 0);
});

test("nonshortable assets cannot open shorts, but an existing short can reduce", () => {
  const i = input(0, -8); i.rules["ETH/USD"].shortable = false;
  assert.equal(planPortfolioAdjustment(i).orders.length, 0);
  const s = fillAll(input(0, -8)), closeInput = input(0, 0, s); closeInput.rules["ETH/USD"].shortable = false;
  assert.equal(planPortfolioAdjustment(closeInput).status, "REDUCE");
});

test("adverse tick prices and maximum order quantity apply before reservation", () => {
  const i = input(0, 12); Object.assign(i.quotes["ETH/USD"], { bid: 1999.89, ask: 2000.01 });
  i.rules["ETH/USD"].maximumOrderQty = .002;
  const p = planPortfolioAdjustment(i); assert.equal(p.orders[0]!.limitPrice, 2000.1);
  assert.equal(p.orders[0]!.signedQty, .002); assert.ok(p.grossNotionalUsd <= 12);
  assert.doesNotThrow(() => reservePortfolioOrders(i.state, p));
});

test("expired targets become zero risk and reduce on fresh quotes without opening exposure", () => {
  const s = fillAll(input(12, 0)), i = input(12, 0, s, T + 172800000); i.target = target(12, 0);
  assert.equal(planPortfolioAdjustment(i).status, "REDUCE");
  assert.deepEqual(planPortfolioAdjustment(i).desiredUsd, { "BTC/USD": 0, "ETH/USD": 0 });
  assert.equal(planPortfolioAdjustment({ ...i, forceFlat: true }).status, "REDUCE");
  assert.equal(planPortfolioAdjustment({ ...i, state: newPortfolioState() }).orders.length, 0);
  i.quotes["BTC/USD"].atMs -= 5001; assert.equal(planPortfolioAdjustment(i).status, "BLOCKED");
});

test("force-flat cannot bypass invalid or future target causality", () => {
  const s = fillAll(input(12, 0));
  for (const mutate of [(t: PortfolioTarget) => { t.availableAtMs = T + 1; },
    (t: PortfolioTarget) => { t.targetUsd["BTC/USD"] = NaN; }]) {
    const i = input(12, 0, s); mutate(i.target); i.forceFlat = true;
    assert.equal(planPortfolioAdjustment(i).status, "BLOCKED");
  }
});

test("reservations reject forged phase, quantity, grid, cap, order ID and stale state", () => {
  const i = input(6, 6), p = planPortfolioAdjustment(i);
  const mutate = (f: (plan: typeof p) => void) => { const bad = structuredClone(p); f(bad); assert.throws(() => reservePortfolioOrders(i.state, bad), /PORTFOLIO_/); };
  mutate(b => b.orders[0]!.signedQty = .00015); mutate(b => b.orders[0]!.id += "x");
  mutate(b => b.orders[0]!.reduceOnly = true); mutate(b => b.executableQty["BTC/USD"] = 0);
  mutate(b => b.grossNotionalUsd = 13); mutate(b => b.status = "HOLD");
  mutate(b => { b.orders[0]!.signedQty = .0002; b.orders[0]!.remainingQty = .0002;
    b.executableQty["BTC/USD"] = .0002; b.grossNotionalUsd = 22; b.unusedCapacityUsd = 0; });
  const reserved = reservePortfolioOrders(i.state, p), canceled = p.orders.reduce((s, o) => cancelPortfolioOrder(s, o.id), reserved);
  assert.throws(() => reservePortfolioOrders(canceled, p), /INVALID_RESERVATION/);
});

test("funding costs and credits apply once and conflicting receipts fail after restart", () => {
  let s = fillAll(input(12, 0));
  s = applyPortfolioFunding(s, { id: "fund-1", atMs: T + 3600000, costUsd: .03 });
  s = applyPortfolioFunding(s, { id: "fund-2", atMs: T + 7200000, costUsd: -.01 });
  close(s.totalFundingCostUsd, .02); close(s.cashUsd, 100000 - .005 - .02);
  const restored: PortfolioState = JSON.parse(JSON.stringify(s));
  assert.equal(validatePortfolioState(restored), true);
  assert.deepEqual(applyPortfolioFunding(restored, { id: "fund-1", atMs: T + 3600000, costUsd: .03 }), s);
  assert.throws(() => applyPortfolioFunding(restored, { id: "fund-1", atMs: T + 3600000, costUsd: .031 }), /CONFLICTING_FUNDING/);
  assert.deepEqual(applyPortfolioFill(restored, restored.fillReceipts[0]!), s);
  assert.throws(() => applyPortfolioFill(restored, { ...restored.fillReceipts[0]!, price: 90000 }), /CONFLICTING_FILL/);
});

test("checkpoint validation detects changed balances, averages, receipts and remaining reservation", () => {
  const i = input(0, 8), p = planPortfolioAdjustment(i), o = p.orders[0]!;
  const s = applyPortfolioFill(reservePortfolioOrders(i.state, p), { id: "first", orderId: o.id, symbol: o.symbol,
    atMs: T, signedQty: .001, price: 2000, feeUsd: .001 });
  assert.equal(validatePortfolioState(JSON.parse(JSON.stringify(s))), true);
  for (const mutation of [
    (v: PortfolioState) => { v.cashUsd += 1; }, (v: PortfolioState) => { v.positions["ETH/USD"].averagePrice = 1999; },
    (v: PortfolioState) => { v.pending[0]!.remainingQty = .004; }, (v: PortfolioState) => { v.processedFillIds = []; },
    (v: PortfolioState) => { v.fillReceipts.push(v.fillReceipts[0]!); }, (v: PortfolioState) => { v.nextOrderSequence = 0; },
  ]) { const bad = structuredClone(s); mutation(bad); assert.equal(validatePortfolioState(bad), false); }
});

test("states and receipt records are immutable; raw restored inputs are safely detached", () => {
  const s = fillAll(input(12, 0)); assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.fillReceipts[0]));
  const raw: PortfolioState = structuredClone(s), next = applyPortfolioFunding(raw, { id: "f", atMs: T, costUsd: .01 });
  raw.fillReceipts[0]!.feeUsd = 10; raw.positions["BTC/USD"].qty = 0;
  assert.equal(validatePortfolioState(next), true); close(next.fillReceipts[0]!.feeUsd, .005);
});

test("checkpoint cannot reset a completed order sequence and finite inputs cannot overflow cash", () => {
  const raw = structuredClone(fillAll(input(12, 0))); raw.nextOrderSequence = 0;
  assert.equal(validatePortfolioState(raw), false);
  const large = newPortfolioState(1e308);
  assert.throws(() => applyPortfolioFunding(large, { id: "overflow", atMs: T, costUsd: -1e308 }), /ARITHMETIC_OVERFLOW/);
  assert.equal(large.cashUsd, 1e308);
});
