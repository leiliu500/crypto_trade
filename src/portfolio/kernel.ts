import { PORTFOLIO_SPEC, PORTFOLIO_SYMBOLS, PORTFOLIO_VERSION,
  type AssetRules, type Pair, type PortfolioFill, type PortfolioOrder, type PortfolioPlan,
  type PortfolioPlannerInput, type PortfolioPosition, type PortfolioState, type PortfolioSymbol } from "./types.js";

const CAP = PORTFOLIO_SPEC.maximumGrossNotionalUsd;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const time = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x >= 0;
const positive = (x: unknown): x is number => finite(x) && x > 0;
const id = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const symbol = (x: unknown): x is PortfolioSymbol => PORTFOLIO_SYMBOLS.includes(x as PortfolioSymbol);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const qtyNear = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * 32 * Math.max(Math.abs(a), Math.abs(b));
const qtyGreater = (a: number, b: number) => a > b && !qtyNear(a, b);
const pair = <T>(f: (s: PortfolioSymbol) => T): Pair<T> => ({ "BTC/USD": f("BTC/USD"), "ETH/USD": f("ETH/USD") });
const sum = (f: (s: PortfolioSymbol) => number) => PORTFOLIO_SYMBOLS.reduce((n, s) => n + f(s), 0);
const copy = <T>(value: T): T => structuredClone(value);
const trustedStates = new WeakSet<object>();
function copyArray<T>(rows: readonly T[]): T[] {
  return Array.from(rows);
}
function receiptById<T extends { id: string }>(rows: readonly T[], value: string): T | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.id === value) return rows[i];
  return undefined;
}
/** Receipt records are immutable and safely shared between state versions.
 * Only the arrays are copied; hourly funding never deep-copies old receipts. */
function copyState(s: PortfolioState): PortfolioState {
  return { ...s, positions: pair(name => ({ ...s.positions[name] })), pending: s.pending.map(o => ({ ...o })),
    processedFillIds: copyArray(s.processedFillIds), processedFundingIds: copyArray(s.processedFundingIds),
    fillReceipts: trustedStates.has(s) ? copyArray(s.fillReceipts) : s.fillReceipts.map(f => Object.freeze({ ...f })),
    fundingReceipts: trustedStates.has(s) ? copyArray(s.fundingReceipts) : s.fundingReceipts.map(f => Object.freeze({ ...f })) };
}
function finish(s: PortfolioState): PortfolioState {
  if (!time(s.nextOrderSequence) || ![s.cashUsd, s.totalFeesUsd, s.totalFundingCostUsd, s.totalTurnoverUsd, s.realizedPricePnlUsd].every(finite)
    || PORTFOLIO_SYMBOLS.some(name => !finite(s.positions[name].qty) || !finite(s.positions[name].averagePrice)))
    throw new Error("PORTFOLIO_ACCOUNT_ARITHMETIC_OVERFLOW");
  for (const name of PORTFOLIO_SYMBOLS) Object.freeze(s.positions[name]);
  for (const o of s.pending) Object.freeze(o);
  Object.freeze(s.positions); Object.freeze(s.pending); Object.freeze(s.processedFillIds); Object.freeze(s.processedFundingIds);
  Object.freeze(s.fillReceipts); Object.freeze(s.fundingReceipts); Object.freeze(s); trustedStates.add(s); return s;
}
function decimals(value: number): number {
  const [mantissa, exponent = "0"] = String(value).split("e");
  return Math.max(0, (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent));
}
function grid(units: number, increment: number): number { return Number((units * increment).toFixed(decimals(increment))); }
function addQuantity(a: number, b: number): number {
  return Number((a + b).toFixed(Math.min(12, Math.max(decimals(Math.abs(a)), decimals(Math.abs(b))))));
}
function gridAligned(value: number, increment: number): boolean {
  const units = value / increment;
  return Number.isSafeInteger(Math.round(units)) && Math.abs(units - Math.round(units)) <= 1e-8;
}
function floorUnits(value: number, increment: number): number {
  const units = value / increment, nearest = Math.round(units);
  return Math.abs(units - nearest) <= 1e-10 ? nearest : Math.floor(units);
}
function priceAt(value: number, increment: number, side: number): number {
  const units = value / increment, nearest = Math.round(units);
  return grid(Math.abs(units - nearest) <= 1e-10 ? nearest : side > 0 ? Math.ceil(units) : Math.floor(units), increment);
}
function validRules(r: AssetRules | undefined, s: PortfolioSymbol): r is AssetRules {
  return !!r && r.symbol === s && typeof r.shortable === "boolean"
    && [r.minOrderSize, r.minTradeIncrement, r.priceIncrement, r.maximumOrderQty].every(positive)
    && r.maximumOrderQty >= r.minOrderSize && decimals(r.minTradeIncrement) <= 12 && decimals(r.priceIncrement) <= 12;
}
function validFill(f: PortfolioFill): boolean {
  return !!f && id(f.id) && id(f.orderId) && symbol(f.symbol) && time(f.atMs)
    && finite(f.signedQty) && f.signedQty !== 0 && decimals(Math.abs(f.signedQty)) <= 12
    && positive(f.price) && finite(f.feeUsd) && f.feeUsd >= 0;
}
function updatePosition(p: PortfolioPosition, signedQty: number, price: number): number {
  const old = p.qty;
  if (!old || Math.sign(old) === Math.sign(signedQty)) {
    p.averagePrice = (Math.abs(old) * p.averagePrice + Math.abs(signedQty) * price) / (Math.abs(old) + Math.abs(signedQty));
    p.qty = addQuantity(p.qty, signedQty); return 0;
  }
  if (qtyGreater(Math.abs(signedQty), Math.abs(old))) throw new Error("PORTFOLIO_FILL_REVERSAL");
  const realized = Math.sign(old) * Math.min(Math.abs(old), Math.abs(signedQty)) * (price - p.averagePrice);
  p.qty = qtyNear(Math.abs(old), Math.abs(signedQty)) ? 0 : addQuantity(old, signedQty);
  if (p.qty === 0) p.averagePrice = 0;
  return realized;
}

export function newPortfolioState(initialEquityUsd = 100_000): PortfolioState {
  if (!positive(initialEquityUsd)) throw new Error("PORTFOLIO_INITIAL_EQUITY");
  return finish({ version: PORTFOLIO_VERSION, initialEquityUsd, cashUsd: initialEquityUsd,
    positions: pair(() => ({ qty: 0, averagePrice: 0 })), pending: [], processedFillIds: [], processedFundingIds: [],
    fillReceipts: [], fundingReceipts: [], totalFeesUsd: 0, totalFundingCostUsd: 0, totalTurnoverUsd: 0,
    realizedPricePnlUsd: 0, nextOrderSequence: 0 });
}

/** Durable receipts are retained in v1. Replaying them validates the inventory,
 * average costs and account identity, not merely the checkpoint's field types. */
export function validatePortfolioState(value: unknown): value is PortfolioState {
  try {
    const s = value as PortfolioState;
    if (!s || s.version !== PORTFOLIO_VERSION || !positive(s.initialEquityUsd) || !finite(s.cashUsd)
      || !time(s.nextOrderSequence) || !Array.isArray(s.pending) || s.pending.length > PORTFOLIO_SPEC.maximumPendingOrders
      || !Array.isArray(s.fillReceipts) || !Array.isArray(s.fundingReceipts)
      || !Array.isArray(s.processedFillIds) || !Array.isArray(s.processedFundingIds)
      || ![s.totalFeesUsd, s.totalFundingCostUsd, s.totalTurnoverUsd, s.realizedPricePnlUsd].every(finite)
      || s.totalFeesUsd < 0 || s.totalTurnoverUsd < 0) return false;
    const positions = pair(() => ({ qty: 0, averagePrice: 0 }));
    const fills = new Set<string>(), funds = new Set<string>(), fillOrders = new Map<string, PortfolioFill>();
    let fees = 0, funding = 0, turnover = 0, realized = 0;
    for (const f of s.fillReceipts) {
      if (!validFill(f) || fills.has(f.id)) return false;
      const parts = f.orderId.slice(PORTFOLIO_VERSION.length + 1).split(":"), sequence = Number(parts[0]), decision = Number(parts[1]);
      if (parts.length !== 3 || !time(decision) || orderSequence(f.orderId, f.symbol, decision) !== sequence
        || sequence >= s.nextOrderSequence || f.atMs < decision) return false;
      const earlier = fillOrders.get(f.orderId);
      if (earlier && (Math.sign(earlier.signedQty) !== Math.sign(f.signedQty) || earlier.symbol !== f.symbol || f.atMs < earlier.atMs)) return false;
      fillOrders.set(f.orderId, f);
      fills.add(f.id); realized += updatePosition(positions[f.symbol], f.signedQty, f.price);
      fees += f.feeUsd; turnover += Math.abs(f.signedQty) * f.price;
    }
    for (const f of s.fundingReceipts) {
      if (!f || !id(f.id) || !time(f.atMs) || !finite(f.costUsd) || funds.has(f.id)) return false;
      funds.add(f.id); funding += f.costUsd;
    }
    if (s.processedFillIds.length !== fills.size || new Set(s.processedFillIds).size !== fills.size
      || s.processedFillIds.some(x => !fills.has(x)) || s.processedFundingIds.length !== funds.size
      || new Set(s.processedFundingIds).size !== funds.size || s.processedFundingIds.some(x => !funds.has(x))) return false;
    for (const name of PORTFOLIO_SYMBOLS) {
      const p = s.positions?.[name], actual = positions[name];
      if (!p || !finite(p.qty) || !finite(p.averagePrice) || !qtyNear(p.qty, actual.qty)
        || !near(p.averagePrice, actual.averagePrice) || (p.qty === 0 ? p.averagePrice !== 0 : p.averagePrice <= 0)) return false;
    }
    if (!near(s.totalFeesUsd, fees) || !near(s.totalFundingCostUsd, funding) || !near(s.totalTurnoverUsd, turnover)
      || !near(s.realizedPricePnlUsd, realized) || !near(s.cashUsd, s.initialEquityUsd + realized - fees - funding)) return false;
    const orders = new Set<string>(), assets = new Set<PortfolioSymbol>();
    for (const o of s.pending) {
      if (!validOrder(o) || orders.has(o.id) || assets.has(o.symbol)) return false;
      orders.add(o.id); assets.add(o.symbol);
      const executed = s.fillReceipts.filter(f => f.orderId === o.id);
      if (executed.some(f => f.symbol !== o.symbol || Math.sign(f.signedQty) !== Math.sign(o.signedQty)
        || f.atMs < o.createdAtMs || Math.sign(o.signedQty) * (f.price - o.limitPrice) > 1e-10)) return false;
      if (!qtyNear(o.remainingQty + executed.reduce((n, f) => n + Math.abs(f.signedQty), 0), Math.abs(o.signedQty))) return false;
      const p = s.positions[o.symbol];
      if (o.reduceOnly ? (!p.qty || Math.sign(o.signedQty) === Math.sign(p.qty) || qtyGreater(o.remainingQty, Math.abs(p.qty)))
        : p.qty !== 0 && Math.sign(o.signedQty) !== Math.sign(p.qty)) return false;
      const sequence = orderSequence(o.id, o.symbol, o.targetDecisionMs);
      if (sequence === null || sequence >= s.nextOrderSequence) return false;
    }
    if (s.pending.some(o => o.reduceOnly) && s.pending.some(o => !o.reduceOnly)) return false;
    return true;
  } catch { return false; }
}
function validOrder(o: PortfolioOrder): boolean {
  return !!o && id(o.id) && symbol(o.symbol) && finite(o.signedQty) && o.signedQty !== 0
    && positive(o.remainingQty) && !qtyGreater(o.remainingQty, Math.abs(o.signedQty))
    && typeof o.reduceOnly === "boolean" && positive(o.limitPrice) && time(o.createdAtMs)
    && time(o.targetDecisionMs) && o.targetDecisionMs <= o.createdAtMs;
}
function orderId(sequence: number, target: number, s: PortfolioSymbol) { return `${PORTFOLIO_VERSION}:${sequence}:${target}:${s}`; }
function orderSequence(value: string, s: PortfolioSymbol, target: number): number | null {
  const prefix = `${PORTFOLIO_VERSION}:`, suffix = `:${target}:${s}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const text = value.slice(prefix.length, -suffix.length), result = Number(text);
  return time(result) && String(result) === text ? result : null;
}
function assertState(s: PortfolioState) {
  if (!trustedStates.has(s) && !validatePortfolioState(s)) throw new Error("PORTFOLIO_INVALID_STATE");
}

interface Candidate { qty: number; notional: number; loss: number; cost: number; turnover: number; }
function better(a: Candidate, b: Candidate): boolean {
  const tolerance = 1e-12 * Math.max(1, Math.abs(a.loss), Math.abs(b.loss));
  return a.loss < b.loss - tolerance || Math.abs(a.loss - b.loss) <= tolerance
    && (a.turnover < b.turnover - 1e-12 || near(a.turnover, b.turnover) && a.notional < b.notional - 1e-12);
}

/** A tracking objective with transaction costs, not a forecast of expected
 * profit. Both assets compete jointly for the same executable $12 capacity. */
export function planPortfolioAdjustment(input: PortfolioPlannerInput): PortfolioPlan {
  const { state, target, quotes, rules, atMs, feeBps } = input;
  assertState(state);
  if (!time(atMs) || !finite(feeBps) || feeBps < 0 || PORTFOLIO_SYMBOLS.some(s => !validRules(rules?.[s], s)))
    throw new Error("PORTFOLIO_PLANNER_CONFIG");
  const expired = time(target?.validUntilMs) && atMs >= target.validUntilMs;
  const desired = pair(s => input.forceFlat || expired ? 0 : target?.targetUsd?.[s] ?? 0);
  const riskPrices = pair(s => positive(quotes?.[s]?.ask) ? priceAt(quotes[s].ask, rules[s].priceIncrement, 1) : 0);
  const current = pair(s => state.positions[s].qty);
  const make = (status: PortfolioPlan["status"], reason: string, orders: PortfolioOrder[] = []): PortfolioPlan => {
    const executableQty = pair(s => orders.filter(o => o.symbol === s).reduce((n, o) => addQuantity(n, o.signedQty), current[s]));
    const grossNotionalUsd = sum(s => Math.abs(executableQty[s]) * riskPrices[s]);
    const estimatedAdjustmentCostUsd = orders.reduce((n, o) => n + adjustmentCost(o.symbol, o.signedQty), 0);
    return { atMs, targetDecisionMs: time(target?.decisionMs) ? target.decisionMs : 0, status, reason,
      executableQty, desiredUsd: copy(desired), riskPrices: copy(riskPrices), rules: copy(rules), grossNotionalUsd,
      unusedCapacityUsd: Math.max(0, CAP - grossNotionalUsd), estimatedAdjustmentCostUsd, orders };
  };
  const executionPrice = (s: PortfolioSymbol, side: number) => priceAt(side > 0 ? quotes[s].ask : quotes[s].bid, rules[s].priceIncrement, side);
  const adjustmentCost = (s: PortfolioSymbol, delta: number) => {
    if (!delta) return 0;
    const mid = (quotes[s].ask + quotes[s].bid) / 2, px = executionPrice(s, delta);
    return Math.abs(delta) * (feeBps / 10000 * px + Math.sign(delta) * (px - mid));
  };
  if (state.pending.length) return make("WAIT", "PENDING_ORDER_RECEIPTS");
  if (!target || target.version !== PORTFOLIO_VERSION || !time(target.decisionMs) || !time(target.availableAtMs)
    || target.availableAtMs < target.decisionMs || target.availableAtMs > atMs || !time(target.validUntilMs)
    || target.validUntilMs <= target.availableAtMs || !id(target.inputSha256)
    || !["multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat"].includes(target.policy)
    || !PORTFOLIO_SYMBOLS.every(s => finite(target.targetUsd?.[s]))
    || sum(s => Math.abs(target.targetUsd[s])) > CAP + 1e-10) return make("BLOCKED", "INVALID_TARGET");
  for (const s of PORTFOLIO_SYMBOLS) {
    const q = quotes?.[s];
    if (!q || q.symbol !== s || !time(q.atMs) || q.atMs > atMs || atMs - q.atMs > PORTFOLIO_SPEC.maximumQuoteAgeMs
      || !positive(q.bid) || !positive(q.ask) || q.ask < q.bid || !finite(q.bidQty) || q.bidQty < 0
      || !finite(q.askQty) || q.askQty < 0 || !positive(riskPrices[s])) return make("BLOCKED", "STALE_OR_INVALID_QUOTE");
    if (!gridAligned(Math.abs(current[s]), rules[s].minTradeIncrement)) return make("BLOCKED", "OFF_GRID_INVENTORY");
  }
  const oldGross = sum(s => Math.abs(current[s]) * riskPrices[s]);
  const banks = pair(s => {
    const r = rules[s], q = quotes[s], mid = (q.bid + q.ask) / 2, old = current[s];
    const holdAllowed = desired[s] !== 0 && Math.sign(old) === Math.sign(desired[s]);
    const deadband = holdAllowed && oldGross <= CAP
      && Math.abs(desired[s] - old * mid) <= PORTFOLIO_SPEC.sameSideDeadbandFraction * Math.abs(old * mid);
    const seen = new Set<number>(), rows: Candidate[] = [];
    const add = (qty: number) => {
      if (seen.has(qty)) return; seen.add(qty);
      const notional = Math.abs(qty) * riskPrices[s];
      if (notional > CAP || qty !== 0 && Math.abs(qty) < r.minOrderSize - 1e-12) return;
      if (qty === old && old !== 0 && !holdAllowed) return;
      if (deadband && qty !== old) return;
      const opening = old === 0 || Math.sign(old) !== Math.sign(qty) ? Math.abs(qty) : Math.max(0, Math.abs(qty) - Math.abs(old));
      if (opening > 0 && (qty < 0 && !r.shortable || opening < r.minOrderSize - 1e-12
        || opening > r.maximumOrderQty || opening > (qty > 0 ? q.askQty : q.bidQty))) return;
      const delta = qty - old, cost = adjustmentCost(s, delta), turnover = Math.abs(delta) * executionPrice(s, delta || 1);
      rows.push({ qty, notional, cost, turnover, loss: (qty * mid - desired[s]) ** 2 / CAP + cost });
    };
    add(0); if (holdAllowed) add(old);
    const direction = Math.sign(desired[s]);
    // Joint search uses a prefix optimum for the second asset, avoiding a
    // Cartesian product even when synthetic fixtures have very cheap lots.
    const units = floorUnits(CAP / riskPrices[s], r.minTradeIncrement);
    if (!Number.isSafeInteger(units) || units > 1_000_000) throw new Error("PORTFOLIO_LOT_ENUMERATION_LIMIT");
    if (direction && !deadband && (direction > 0 || r.shortable || old < 0))
      for (let n = Math.max(1, Math.ceil(r.minOrderSize / r.minTradeIncrement - 1e-10)); n <= units; n++) add(direction * grid(n, r.minTradeIncrement));
    return rows.sort((a, b) => a.notional - b.notional || a.qty - b.qty);
  });
  const btc = banks["BTC/USD"], eth = banks["ETH/USD"];
  const prefix: Candidate[] = [];
  for (const row of eth) prefix.push(!prefix.length || better(row, prefix.at(-1)!) ? row : prefix.at(-1)!);
  let chosen: Pair<number> | null = null, best: Candidate | null = null;
  for (const a of btc) {
    let lo = 0, hi = eth.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (a.notional + eth[mid]!.notional <= CAP) lo = mid + 1; else hi = mid; }
    if (!lo) continue;
    const b = prefix[lo - 1]!, candidate = { qty: 0, notional: a.notional + b.notional,
      loss: a.loss + b.loss, cost: a.cost + b.cost, turnover: a.turnover + b.turnover };
    if (best === null || better(candidate, best)) { best = candidate; chosen = { "BTC/USD": a.qty, "ETH/USD": b.qty }; }
  }
  if (!chosen) return make("BLOCKED", "NO_JOINT_FEASIBLE_ALLOCATION");
  const reductions = pair(s => {
    const old = current[s], next = chosen![s];
    if (!old) return 0;
    if (!next || Math.sign(old) !== Math.sign(next)) return -old;
    return Math.abs(next) < Math.abs(old) ? next - old : 0;
  });
  const reduce = PORTFOLIO_SYMBOLS.some(s => reductions[s] !== 0);
  const orders: PortfolioOrder[] = [];
  for (const s of PORTFOLIO_SYMBOLS) {
    const delta = reduce ? reductions[s] : chosen[s] - current[s];
    if (!delta) continue;
    const r = rules[s], depth = delta > 0 ? quotes[s].askQty : quotes[s].bidQty;
    const amount = grid(floorUnits(Math.min(Math.abs(delta), depth, r.maximumOrderQty), r.minTradeIncrement), r.minTradeIncrement);
    if (amount < r.minOrderSize || amount <= 0) continue;
    orders.push({ id: orderId(state.nextOrderSequence + orders.length, target.decisionMs, s), symbol: s,
      signedQty: Math.sign(delta) * amount, remainingQty: amount, reduceOnly: reduce,
      limitPrice: executionPrice(s, delta), createdAtMs: atMs, targetDecisionMs: target.decisionMs });
  }
  if (!orders.length) return make(reduce ? "BLOCKED" : "HOLD", reduce ? "REDUCTION_DEPTH_OR_MINIMUM" : "TARGET_WITHIN_BAND_OR_LOT_COST_OPTIMUM");
  return make(reduce ? "REDUCE" : "INCREASE", reduce ? "CONFIRM_REDUCTIONS_BEFORE_INCREASES" : "JOINT_LOT_ALLOCATION", orders);
}

export function reservePortfolioOrders(state: PortfolioState, plan: PortfolioPlan): PortfolioState {
  assertState(state);
  if (!plan || !time(plan.atMs) || !time(plan.targetDecisionMs) || plan.targetDecisionMs > plan.atMs
    || !["WAIT", "HOLD", "REDUCE", "INCREASE", "BLOCKED"].includes(plan.status) || !id(plan.reason)
    || !Array.isArray(plan.orders) || plan.orders.length > PORTFOLIO_SPEC.maximumPendingOrders
    || ![plan.grossNotionalUsd, plan.unusedCapacityUsd, plan.estimatedAdjustmentCostUsd].every(x => finite(x) && x >= 0)
    || PORTFOLIO_SYMBOLS.some(s => !finite(plan.executableQty?.[s]) || !finite(plan.desiredUsd?.[s])
      || !positive(plan.riskPrices?.[s]) || !validRules(plan.rules?.[s], s))) throw new Error("PORTFOLIO_INVALID_PLAN");
  if (!plan.orders.length) {
    if (["REDUCE", "INCREASE"].includes(plan.status)) throw new Error("PORTFOLIO_EMPTY_ADJUSTMENT");
    return finish(copyState(state));
  }
  if (state.pending.length) throw new Error("PORTFOLIO_PENDING_RESERVATION");
  if (!["REDUCE", "INCREASE"].includes(plan.status)) throw new Error("PORTFOLIO_PLAN_PHASE");
  const next = copyState(state), seen = new Set<PortfolioSymbol>();
  for (const [i, o] of plan.orders.entries()) {
    const r = plan.rules[o.symbol], p = state.positions[o.symbol];
    if (!validOrder(o) || seen.has(o.symbol) || o.id !== orderId(state.nextOrderSequence + i, plan.targetDecisionMs, o.symbol)
      || o.createdAtMs !== plan.atMs || o.targetDecisionMs !== plan.targetDecisionMs || o.remainingQty !== Math.abs(o.signedQty)
      || !r || !gridAligned(Math.abs(o.signedQty), r.minTradeIncrement) || !gridAligned(o.limitPrice, r.priceIncrement)
      || Math.abs(o.signedQty) < r.minOrderSize || Math.abs(o.signedQty) > r.maximumOrderQty || o.limitPrice > plan.riskPrices[o.symbol]
      || o.reduceOnly !== (plan.status === "REDUCE")) throw new Error("PORTFOLIO_INVALID_RESERVATION");
    seen.add(o.symbol);
    if (o.reduceOnly ? (!p.qty || Math.sign(o.signedQty) === Math.sign(p.qty) || qtyGreater(Math.abs(o.signedQty), Math.abs(p.qty)))
      : (p.qty !== 0 && Math.sign(o.signedQty) !== Math.sign(p.qty)) || (o.signedQty < 0 && !r.shortable)
        || Math.sign(o.signedQty) !== Math.sign(plan.desiredUsd[o.symbol])) throw new Error("PORTFOLIO_RESERVATION_DIRECTION");
    next.pending.push(copy(o));
  }
  const after = pair(s => plan.orders.filter(o => o.symbol === s).reduce((n, o) => addQuantity(n, o.signedQty), state.positions[s].qty));
  const beforeGross = sum(s => Math.abs(state.positions[s].qty) * plan.riskPrices[s]);
  const gross = sum(s => Math.abs(after[s]) * plan.riskPrices[s]);
  if (PORTFOLIO_SYMBOLS.some(s => !qtyNear(after[s], plan.executableQty[s])) || !near(gross, plan.grossNotionalUsd)
    || !near(Math.max(0, CAP - gross), plan.unusedCapacityUsd)
    || plan.status === "INCREASE" && gross > CAP
    || plan.status === "REDUCE" && !(gross < beforeGross)) throw new Error("PORTFOLIO_RESERVATION_CAP_OR_QUANTITY");
  next.nextOrderSequence += plan.orders.length;
  return finish(next);
}

export function applyPortfolioFill(state: PortfolioState, fill: PortfolioFill): PortfolioState {
  assertState(state);
  if (!validFill(fill)) throw new Error("PORTFOLIO_INVALID_FILL");
  const prior = receiptById(state.fillReceipts, fill.id);
  if (prior) {
    if (["id", "orderId", "symbol", "atMs", "signedQty", "price", "feeUsd"].some(k => prior[k as keyof PortfolioFill] !== fill[k as keyof PortfolioFill]))
      throw new Error("PORTFOLIO_CONFLICTING_FILL_RECEIPT");
    return finish(copyState(state));
  }
  const order = state.pending.find(o => o.id === fill.orderId);
  if (!order || order.symbol !== fill.symbol || fill.atMs < order.createdAtMs || Math.sign(fill.signedQty) !== Math.sign(order.signedQty)
    || qtyGreater(Math.abs(fill.signedQty), order.remainingQty) || Math.sign(fill.signedQty) * (fill.price - order.limitPrice) > 1e-10)
    throw new Error("PORTFOLIO_FILL_ORDER_MISMATCH");
  const next = copyState(state), p = next.positions[fill.symbol];
  if (order.reduceOnly ? (!p.qty || Math.sign(p.qty) === Math.sign(fill.signedQty) || qtyGreater(Math.abs(fill.signedQty), Math.abs(p.qty)))
    : p.qty !== 0 && Math.sign(p.qty) !== Math.sign(fill.signedQty)) throw new Error("PORTFOLIO_FILL_DIRECTION");
  const realized = updatePosition(p, fill.signedQty, fill.price);
  next.realizedPricePnlUsd += realized; next.totalFeesUsd += fill.feeUsd;
  next.cashUsd += realized - fill.feeUsd; next.totalTurnoverUsd += Math.abs(fill.signedQty) * fill.price;
  const pending = next.pending.find(o => o.id === fill.orderId)!;
  pending.remainingQty = qtyNear(pending.remainingQty, Math.abs(fill.signedQty)) ? 0 : addQuantity(pending.remainingQty, -Math.abs(fill.signedQty));
  next.pending = next.pending.filter(o => o.remainingQty > 0);
  next.fillReceipts.push(Object.freeze(copy(fill))); next.processedFillIds.push(fill.id);
  return finish(next);
}

export function cancelPortfolioOrder(state: PortfolioState, orderIdValue: string): PortfolioState {
  assertState(state); if (!id(orderIdValue)) throw new Error("PORTFOLIO_INVALID_ORDER_ID");
  const next = copyState(state); next.pending = next.pending.filter(o => o.id !== orderIdValue); return finish(next);
}

export function applyPortfolioFunding(state: PortfolioState, funding: { id: string; atMs: number; costUsd: number }): PortfolioState {
  assertState(state);
  if (!funding || !id(funding.id) || !time(funding.atMs) || !finite(funding.costUsd)) throw new Error("PORTFOLIO_INVALID_FUNDING");
  const prior = receiptById(state.fundingReceipts, funding.id);
  if (prior) {
    if (prior.atMs !== funding.atMs || prior.costUsd !== funding.costUsd) throw new Error("PORTFOLIO_CONFLICTING_FUNDING_RECEIPT");
    return finish(copyState(state));
  }
  const next = copyState(state); next.cashUsd -= funding.costUsd; next.totalFundingCostUsd += funding.costUsd;
  next.fundingReceipts.push(Object.freeze(copy(funding))); next.processedFundingIds.push(funding.id); return finish(next);
}

export function portfolioEquity(state: PortfolioState, marks: Pair<number>) {
  assertState(state);
  if (PORTFOLIO_SYMBOLS.some(s => !positive(marks?.[s]))) throw new Error("PORTFOLIO_INVALID_MARK");
  const unrealizedPnlUsd = sum(s => state.positions[s].qty * (marks[s] - state.positions[s].averagePrice));
  return { equityUsd: state.cashUsd + unrealizedPnlUsd, unrealizedPnlUsd,
    grossNotionalUsd: sum(s => Math.abs(state.positions[s].qty) * marks[s]) };
}
