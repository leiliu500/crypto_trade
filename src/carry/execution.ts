import { createHash } from "node:crypto";

export const CARRY_EXECUTION_SPEC = Object.freeze({ version: "segregated-paired-carry-paper-v1",
  paperOnly: true, researchOnly: true, externalOrdersAllowed: false,
  entry: "FUNDED_SPOT_FIRST_THEN_RECEIPT_CONFIRMED_LINEAR_SHORT",
  repair: "FAILED_ENTRY_REDUCES_UNMATCHED_BASE_ONLY;FAILED_EXIT_FLATTENS_BOTH_LEGS",
  funding: "DISCRETE_SETTLEMENT_PROXY_ONLY", exchangeFundingAccountingVerified: false,
  fundingLimitation: "DOES_NOT_RECONSTRUCT_CONTINUOUS_ACCRUAL_OR_POSITION_CHANGE_SETTLEMENTS",
  missingFunding: "UNKNOWN_NOT_ZERO;FULLY_COSTED_VENUE_PNL_ALWAYS_UNKNOWN", balances: "NO_BORROWING_OR_AUTOMATIC_COLLATERAL_TRANSFER",
  limits: "EXPLICIT_RESEARCH_BUDGETS;NO_INHERITED_LIVE_OR_12_USD_LIMIT",
});
export type CarryStatus = "ENTERING" | "HEDGED" | "EXITING" | "REPAIR_REQUIRED" | "CLOSED";
export interface CarryInstrument {
  id: string; venue: string; kind: "SPOT" | "LINEAR_PERPETUAL"; symbol: string; baseAsset: string;
  quoteAsset: "USD"; minQty: number; qtyIncrement: number; priceIncrement: number;
}
export interface CarryConfig {
  spot: CarryInstrument; future: CarryInstrument; spotCashUsd: number; derivativeCollateralUsd: number;
  spotFeeBps: number; futureFeeBps: number; derivativeInitialMarginFraction: number;
  maximumGrossNotionalUsd: number; maximumUnmatchedNotionalUsd: number;
  maximumQuoteAgeMs: number; legTimeoutMs: number; fundingIntervalMs: number;
}
export interface CarryQuote { instrumentId: string; atMs: number; bid: number; ask: number; bidQty: number; askQty: number }
export interface CarryQuotes { spot: CarryQuote | null; future: CarryQuote | null }
export interface CarryOrder {
  id: string; instrumentId: string; leg: "spot" | "future"; side: 1 | -1; qty: number; remainingQty: number;
  limitPrice: number; createdAtMs: number; expiresAtMs: number; reduceOnly: boolean;
  purpose: "SPOT_ENTRY" | "FUTURE_ENTRY" | "EXIT" | "REPAIR";
  status: "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";
}
export interface CarryFill {
  id: string; orderId: string; instrumentId: string; atMs: number; side: 1 | -1;
  qty: number; price: number; feeUsd: number; final: boolean;
}
export interface CarryFundingReceipt { id: string; instrumentId: string; atMs: number; absoluteRateUsdPerBase: number | null }
export interface CarryFundingObligation {
  atMs: number; signedBaseQty: number; receiptId: string | null;
  absoluteRateUsdPerBase: number | null; costUsd: number | null;
}
export type CarryCommand =
  | { type: "ENTRY"; id: string; atMs: number; baseQty: number; quotes: CarryQuotes }
  | { type: "EXIT"; id: string; atMs: number; quotes: CarryQuotes }
  | { type: "ADVANCE"; atMs: number; quotes: CarryQuotes }
  | { type: "FILL"; receipt: CarryFill }
  | { type: "REJECT"; id: string; orderId: string; atMs: number }
  | { type: "FUNDING"; receipt: CarryFundingReceipt };
export interface CarryCore {
  version: typeof CARRY_EXECUTION_SPEC.version; config: CarryConfig; configurationSha256: string;
  status: CarryStatus; lastAtMs: number | null; reason: string; cycleId: string | null;
  spot: { cashUsd: number; qty: number; averagePrice: number; realizedPricePnlUsd: number; feesUsd: number };
  future: { collateralUsd: number; qty: number; averagePrice: number; realizedPricePnlUsd: number; feesUsd: number; fundingCostUsd: number };
  pendingOrderId: string | null; orders: CarryOrder[]; fills: CarryFill[]; funding: CarryFundingObligation[];
  nextOrderSequence: number; phaseDeadlineMs: number | null; repairGoal: "BALANCE" | "FLAT";
  entryHedgeAttempted: boolean;
  reservation: { spotCashUsd: number; derivativeCollateralUsd: number; grossNotionalUsd: number; unmatchedNotionalUsd: number };
}
export interface CarryState extends CarryCore { journal: CarryCommand[]; stateSha256: string }
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const time = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x >= 0;
const id = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200 && x.trim() === x;
const near = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * 32 * Math.max(1, Math.abs(a), Math.abs(b));
const cleanQty = (x: number) => Number(x.toFixed(12));
const aligned = (x: number, step: number) => finite(x) && near(x / step, Math.round(x / step));
const floorQty = (x: number, step: number) => cleanQty(Math.floor(x / step + 1e-10) * step);
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
const trusted = new WeakSet<object>();
function instrument(v: CarryInstrument, kind: CarryInstrument["kind"]) {
  return v && v.kind === kind && id(v.venue) && id(v.symbol) && id(v.baseAsset) && v.quoteAsset === "USD"
    && v.id === `${v.venue}:${kind}:${v.symbol}` && [v.minQty, v.qtyIncrement, v.priceIncrement].every(positive)
    && v.qtyIncrement >= 1e-12 && v.priceIncrement >= 1e-12 && aligned(v.minQty, v.qtyIncrement);
}
function validateConfig(c: CarryConfig) {
  if (!c || !instrument(c.spot, "SPOT") || !instrument(c.future, "LINEAR_PERPETUAL")
    || c.spot.baseAsset !== c.future.baseAsset || c.spot.id === c.future.id
    || ![c.spotCashUsd, c.derivativeCollateralUsd].every(v => finite(v) && v >= 0)
    || !positive(c.spotCashUsd + c.derivativeCollateralUsd)
    || ![c.spotFeeBps, c.futureFeeBps].every(v => finite(v) && v >= 0 && v < 10_000)
    || !positive(c.derivativeInitialMarginFraction) || c.derivativeInitialMarginFraction > 1
    || !positive(c.maximumGrossNotionalUsd) || !positive(c.maximumUnmatchedNotionalUsd)
    || c.maximumUnmatchedNotionalUsd > c.maximumGrossNotionalUsd
    || ![c.maximumQuoteAgeMs, c.legTimeoutMs, c.fundingIntervalMs].every(v => time(v) && v > 0)
    || c.maximumQuoteAgeMs > c.legTimeoutMs) throw new Error("CARRY_INVALID_CONFIG");
}
function emptyReservation() { return { spotCashUsd: 0, derivativeCollateralUsd: 0, grossNotionalUsd: 0, unmatchedNotionalUsd: 0 }; }
function initial(config: CarryConfig): CarryCore {
  validateConfig(config); const c = structuredClone(config);
  return { version: CARRY_EXECUTION_SPEC.version, config: c, configurationSha256: hash(c), status: "CLOSED",
    lastAtMs: null, reason: "PAPER_LEDGER_READY", cycleId: null,
    spot: { cashUsd: c.spotCashUsd, qty: 0, averagePrice: 0, realizedPricePnlUsd: 0, feesUsd: 0 },
    future: { collateralUsd: c.derivativeCollateralUsd, qty: 0, averagePrice: 0, realizedPricePnlUsd: 0, feesUsd: 0, fundingCostUsd: 0 },
    pendingOrderId: null, orders: [], fills: [], funding: [], nextOrderSequence: 0, phaseDeadlineMs: null,
    repairGoal: "BALANCE", entryHedgeAttempted: false, reservation: emptyReservation() };
}
function core(s: CarryState): CarryCore { const { journal: _, stateSha256: __, ...body } = s; return structuredClone(body); }
function finish(s: CarryCore, journal: CarryCommand[]): CarryState {
  if (![...Object.values(s.spot), ...Object.values(s.future), ...Object.values(s.reservation)].every(finite)
    || s.spot.qty < 0 || s.future.qty > 0 || s.spot.cashUsd < -1e-8) throw new Error("CARRY_LEDGER_ARITHMETIC");
  const body = { ...s, journal }; const out = freeze({ ...body, stateSha256: hash(body) }); trusted.add(out); return out;
}
export function newCarryState(config: CarryConfig): CarryState { return finish(initial(config), []); }
function advanceClock(s: CarryCore, atMs: number) {
  if (!time(atMs) || s.lastAtMs !== null && atMs < s.lastAtMs) throw new Error("CARRY_REVERSED_OR_INVALID_TIME");
  if (s.lastAtMs !== null && s.future.qty !== 0) {
    const interval = s.config.fundingIntervalMs;
    const first = (Math.floor(s.lastAtMs / interval) + 1) * interval;
    if ((atMs - first) / interval > 100_000) throw new Error("CARRY_FUNDING_GAP_TOO_LARGE");
    for (let t = first; t <= atMs; t += interval) s.funding.push({ atMs: t, signedBaseQty: s.future.qty,
      receiptId: null, absoluteRateUsdPerBase: null, costUsd: null });
  }
  s.lastAtMs = atMs;
}
function quote(s: CarryCore, q: CarryQuote | null, leg: "spot" | "future", atMs: number): CarryQuote | null {
  if (!q) return null; const rule = s.config[leg];
  if (q.instrumentId !== rule.id || !time(q.atMs) || ![q.bid, q.ask].every(positive) || q.bid > q.ask
    || ![q.bidQty, q.askQty].every(v => finite(v) && v >= 0)
    || !aligned(q.bid, rule.priceIncrement) || !aligned(q.ask, rule.priceIncrement)) throw new Error("CARRY_INVALID_QUOTE");
  return q.atMs > atMs || atMs - q.atMs > s.config.maximumQuoteAgeMs ? null : q;
}
function cancel(s: CarryCore, rejected = false) {
  const order = s.orders.find(o => o.id === s.pendingOrderId);
  if (order) { order.status = rejected ? "REJECTED" : "CANCELLED"; order.remainingQty = 0; }
  s.pendingOrderId = null; s.reservation = emptyReservation();
}
function repair(s: CarryCore, reason: string) {
  if (s.status === "EXITING") s.repairGoal = "FLAT";
  cancel(s); s.status = "REPAIR_REQUIRED"; s.phaseDeadlineMs = null; s.reason = reason;
}
function balanced(s: CarryCore) { return cleanQty(s.spot.qty + s.future.qty) === 0; }
function settle(s: CarryCore) {
  if (s.pendingOrderId) return;
  if (s.spot.qty === 0 && s.future.qty === 0) { s.status = "CLOSED"; s.phaseDeadlineMs = null; s.reason = "NO_OPEN_INVENTORY"; }
  else if (s.repairGoal === "BALANCE" && balanced(s)) { s.status = "HEDGED"; s.phaseDeadlineMs = null; s.reason = "EQUAL_BASE_HEDGE_CONFIRMED"; }
  if (s.status === "CLOSED" || s.status === "HEDGED") s.reservation = emptyReservation();
}
function reserve(s: CarryCore, leg: "spot" | "future", side: 1 | -1, qty: number, q: CarryQuote,
  atMs: number, purpose: CarryOrder["purpose"], reduceOnly: boolean) {
  const rule = s.config[leg];
  qty = floorQty(Math.min(qty, side > 0 ? q.askQty : q.bidQty), rule.qtyIncrement);
  if (qty < rule.minQty) { s.reason = "REPAIR_OR_CONTINUATION_WAITING_FOR_EXECUTABLE_DEPTH"; return; }
  const price = side > 0 ? q.ask : q.bid;
  const order: CarryOrder = { id: `${s.cycleId}:${s.nextOrderSequence++}:${rule.id}`, instrumentId: rule.id,
    leg, side, qty, remainingQty: qty, limitPrice: price, createdAtMs: atMs, expiresAtMs: atMs + s.config.legTimeoutMs,
    reduceOnly, purpose, status: "PENDING" };
  if (!time(order.expiresAtMs)) throw new Error("CARRY_TIME_OVERFLOW");
  s.orders.push(order); s.pendingOrderId = order.id; s.phaseDeadlineMs = order.expiresAtMs;
  if (purpose === "FUTURE_ENTRY") s.entryHedgeAttempted = true;
  s.reason = `${purpose}_PAPER_ORDER_RESERVED`;
  if (leg === "spot" && side > 0) s.reservation.spotCashUsd = qty * price * (1 + s.config.spotFeeBps / 10_000);
  if (leg === "future" && !reduceOnly) s.reservation.derivativeCollateralUsd = qty * price
    * (s.config.derivativeInitialMarginFraction + s.config.futureFeeBps / 10_000);
}
function drive(s: CarryCore, quotes: CarryQuotes, atMs: number) {
  if (!quotes || typeof quotes !== "object") throw new Error("CARRY_INVALID_QUOTES");
  const spot = quote(s, quotes.spot, "spot", atMs), future = quote(s, quotes.future, "future", atMs);
  if (s.phaseDeadlineMs !== null && atMs >= s.phaseDeadlineMs && (s.pendingOrderId || s.status === "ENTERING")) repair(s, "LEG_TIMEOUT_REPAIR_REQUIRED");
  if (s.pendingOrderId) return;
  if (s.status === "CLOSED" || s.status === "HEDGED") return;
  settle(s); if (["CLOSED", "HEDGED"].includes(s.status)) return;
  if (s.status === "ENTERING") {
    if (s.entryHedgeAttempted) { repair(s, "INCOMPLETE_SECOND_LEG_REPAIR_REQUIRED"); }
    else {
      if (!spot || !future) { s.reason = "CONTINUATION_WAITING_FOR_FRESH_QUOTES"; return; }
      const qty = floorQty(s.spot.qty, s.config.future.qtyIncrement);
      const required = qty * future.ask * (s.config.derivativeInitialMarginFraction + s.config.futureFeeBps / 10_000);
      const gross = s.spot.qty * spot.ask + qty * future.ask;
      if (qty < s.config.future.minQty || required > s.future.collateralUsd + 1e-10
        || gross > s.config.maximumGrossNotionalUsd + 1e-10) repair(s, "SECOND_LEG_BUDGET_OR_LOT_REPAIR_REQUIRED");
      else { s.reservation = { spotCashUsd: 0, derivativeCollateralUsd: required, grossNotionalUsd: gross,
        unmatchedNotionalUsd: s.spot.qty * spot.ask }; reserve(s, "future", -1, qty, future, atMs, "FUTURE_ENTRY", false); return; }
    }
  }
  let flat = s.repairGoal === "FLAT" || s.status === "EXITING";
  const mismatch = cleanQty(s.spot.qty + s.future.qty);
  const unmatchedRule = s.config[mismatch > 0 ? "spot" : "future"];
  if (!flat && (!aligned(Math.abs(mismatch), unmatchedRule.qtyIncrement) || Math.abs(mismatch) < unmatchedRule.minQty)) {
    s.repairGoal = "FLAT"; flat = true; s.reason = "UNMATCHED_DUST_REQUIRES_FULL_UNWIND";
  }
  const leg: "spot" | "future" = flat ? s.future.qty < 0 ? "future" : "spot" : mismatch > 0 ? "spot" : "future";
  const qty = flat ? Math.abs(s[leg].qty) : Math.abs(mismatch);
  const q = leg === "spot" ? spot : future;
  if (!q) { s.reason = "REPAIR_OR_EXIT_WAITING_FOR_FRESH_QUOTES"; return; }
  reserve(s, leg, leg === "spot" ? -1 : 1, qty, q, atMs, s.status === "EXITING" ? "EXIT" : "REPAIR", true);
}
function applyFill(s: CarryCore, f: CarryFill) {
  const previousReservation = { ...s.reservation };
  const order = s.orders.find(o => o.id === f.orderId);
  if (!id(f.id) || !order || order.id !== s.pendingOrderId || order.status !== "PENDING" || f.instrumentId !== order.instrumentId
    || f.side !== order.side || !positive(f.qty) || !positive(f.price) || !finite(f.feeUsd) || f.feeUsd < 0 || typeof f.final !== "boolean"
    || f.atMs < order.createdAtMs || f.atMs >= order.expiresAtMs || f.qty > order.remainingQty && !near(f.qty, order.remainingQty)
    || !aligned(f.qty, s.config[order.leg].qtyIncrement) || !aligned(f.price, s.config[order.leg].priceIncrement)
    || (f.side === 1 ? f.price > order.limitPrice : f.price < order.limitPrice)) throw new Error("CARRY_INVALID_FILL");
  const feeBps = order.leg === "spot" ? s.config.spotFeeBps : s.config.futureFeeBps;
  if (!near(f.feeUsd, f.qty * f.price * feeBps / 10_000)) throw new Error("CARRY_FILL_FEE_MISMATCH");
  const account = s[order.leg], signed = f.side * f.qty, oldQty = account.qty;
  if (order.reduceOnly && (oldQty === 0 || Math.sign(oldQty) === f.side || f.qty > Math.abs(oldQty) && !near(f.qty, Math.abs(oldQty))))
    throw new Error("CARRY_FILL_WOULD_INCREASE_REPAIR_RISK");
  if (order.leg === "spot") {
    if (f.side > 0) {
      const required = f.qty * f.price + f.feeUsd;
      if (required > s.spot.cashUsd + 1e-10) throw new Error("CARRY_SPOT_BORROWING_FORBIDDEN");
      s.spot.averagePrice = (oldQty * account.averagePrice + f.qty * f.price) / cleanQty(oldQty + f.qty);
      s.spot.cashUsd -= required;
    } else {
      if (f.qty > oldQty && !near(f.qty, oldQty)) throw new Error("CARRY_SPOT_SHORT_FORBIDDEN");
      s.spot.realizedPricePnlUsd += f.qty * (f.price - account.averagePrice);
      s.spot.cashUsd += f.qty * f.price - f.feeUsd;
    }
  } else if (f.side < 0) {
    const required = (Math.abs(oldQty) + f.qty) * f.price * s.config.derivativeInitialMarginFraction + f.feeUsd;
    if (required > s.future.collateralUsd + 1e-10) throw new Error("CARRY_DERIVATIVE_COLLATERAL_INSUFFICIENT");
    s.future.averagePrice = (Math.abs(oldQty) * account.averagePrice + f.qty * f.price) / cleanQty(Math.abs(oldQty) + f.qty);
    s.future.collateralUsd -= f.feeUsd;
  } else {
    const pnl = f.qty * (account.averagePrice - f.price);
    s.future.realizedPricePnlUsd += pnl; s.future.collateralUsd += pnl - f.feeUsd;
  }
  account.qty = cleanQty(oldQty + signed); account.feesUsd += f.feeUsd;
  if (account.qty === 0) account.averagePrice = 0;
  order.remainingQty = cleanQty(order.remainingQty - f.qty); s.fills.push(structuredClone(f));
  if (f.final || order.remainingQty === 0) {
    order.status = order.remainingQty === 0 ? "FILLED" : "CANCELLED"; order.remainingQty = 0;
    s.pendingOrderId = null; s.reservation = emptyReservation(); s.phaseDeadlineMs = f.atMs + s.config.legTimeoutMs;
    if (order.purpose === "SPOT_ENTRY") {
      const fraction = s.spot.qty / order.qty;
      s.reservation = { spotCashUsd: 0, derivativeCollateralUsd: previousReservation.derivativeCollateralUsd * fraction,
        grossNotionalUsd: previousReservation.grossNotionalUsd * fraction,
        unmatchedNotionalUsd: previousReservation.unmatchedNotionalUsd * fraction };
    }
    if (order.purpose === "FUTURE_ENTRY" && !balanced(s)) repair(s, "PARTIAL_SECOND_LEG_REPAIR_REQUIRED");
    settle(s);
  } else if (order.leg === "spot" && f.side > 0) s.reservation.spotCashUsd = order.remainingQty * order.limitPrice * (1 + feeBps / 10_000);
}
function reduce(s: CarryCore, c: CarryCommand): CarryCore {
  const atMs = c.type === "FILL" || c.type === "FUNDING" ? c.receipt.atMs : c.atMs;
  advanceClock(s, atMs);
  if (c.type === "ENTRY") {
    if (!id(c.id) || s.status !== "CLOSED" || s.pendingOrderId || s.spot.qty || s.future.qty
      || !positive(c.baseQty) || ![s.config.spot, s.config.future].every(r => c.baseQty >= r.minQty && aligned(c.baseQty, r.qtyIncrement)))
      throw new Error("CARRY_ENTRY_NOT_ALLOWED");
    const spot = quote(s, c.quotes.spot, "spot", atMs), future = quote(s, c.quotes.future, "future", atMs);
    if (!spot || !future || spot.askQty < c.baseQty || future.bidQty < c.baseQty) throw new Error("CARRY_ENTRY_REQUIRES_FRESH_DEPTH");
    const spotCash = c.baseQty * spot.ask * (1 + s.config.spotFeeBps / 10_000);
    const collateral = c.baseQty * future.ask * (s.config.derivativeInitialMarginFraction + s.config.futureFeeBps / 10_000);
    const gross = c.baseQty * (spot.ask + future.ask), unmatched = c.baseQty * Math.max(spot.ask, future.ask);
    if (spotCash > s.spot.cashUsd + 1e-10 || collateral > s.future.collateralUsd + 1e-10
      || gross > s.config.maximumGrossNotionalUsd + 1e-10 || unmatched > s.config.maximumUnmatchedNotionalUsd + 1e-10)
      throw new Error("CARRY_ENTRY_BUDGET_INSUFFICIENT");
    s.cycleId = c.id; s.status = "ENTERING"; s.repairGoal = "BALANCE"; s.entryHedgeAttempted = false;
    s.reservation = { spotCashUsd: spotCash, derivativeCollateralUsd: collateral, grossNotionalUsd: gross, unmatchedNotionalUsd: unmatched };
    reserve(s, "spot", 1, c.baseQty, spot, atMs, "SPOT_ENTRY", false);
  } else if (c.type === "EXIT") {
    if (!id(c.id) || s.status === "CLOSED") throw new Error("CARRY_EXIT_NOT_ALLOWED");
    cancel(s); s.status = "EXITING"; s.repairGoal = "FLAT"; s.phaseDeadlineMs = null; drive(s, c.quotes, atMs);
  } else if (c.type === "ADVANCE") drive(s, c.quotes, atMs);
  else if (c.type === "FILL") applyFill(s, c.receipt);
  else if (c.type === "REJECT") {
    if (!id(c.id) || c.orderId !== s.pendingOrderId) throw new Error("CARRY_REJECTION_WITHOUT_PENDING_ORDER");
    cancel(s, true); repair(s, "ORDER_REJECTED_REPAIR_REQUIRED"); settle(s);
  } else if (c.type === "FUNDING") {
    const f = c.receipt, obligation = s.funding.find(o => o.atMs === f.atMs);
    if (!id(f.id) || f.instrumentId !== s.config.future.id || !obligation || obligation.receiptId !== null
      || f.absoluteRateUsdPerBase !== null && !finite(f.absoluteRateUsdPerBase)) throw new Error("CARRY_INVALID_FUNDING_RECEIPT");
    obligation.receiptId = f.id; obligation.absoluteRateUsdPerBase = f.absoluteRateUsdPerBase;
    if (f.absoluteRateUsdPerBase !== null) {
      const cost = obligation.signedBaseQty * f.absoluteRateUsdPerBase;
      obligation.costUsd = cost; s.future.collateralUsd -= cost; s.future.fundingCostUsd += cost;
    }
  } else throw new Error("CARRY_UNKNOWN_COMMAND");
  return s;
}
function commandId(c: CarryCommand): string | null { return c.type === "ADVANCE" ? null : c.type === "FILL" || c.type === "FUNDING" ? c.receipt.id : c.id; }
function commit(state: CarryState, command: CarryCommand): CarryState {
  if (!validateCarryState(state)) throw new Error("CARRY_INVALID_STATE");
  const key = commandId(command);
  if (key !== null) {
    const old = state.journal.find(c => commandId(c) === key);
    if (old) { if (canonical(old) === canonical(command)) return state; throw new Error("CARRY_CONFLICTING_DUPLICATE_RECEIPT"); }
  }
  const accepted = structuredClone(command), body = reduce(core(state), accepted);
  if (canonical(body) === canonical(core(state))) return state;
  return finish(body, [...state.journal, accepted]);
}
export function beginCarryEntry(state: CarryState, input: Omit<Extract<CarryCommand, { type: "ENTRY" }>, "type">) { return commit(state, { type: "ENTRY", ...input }); }
export function beginCarryExit(state: CarryState, input: Omit<Extract<CarryCommand, { type: "EXIT" }>, "type">) { return commit(state, { type: "EXIT", ...input }); }
/** Drives receipt-confirmed entry continuation, timeout handling and repair/exit retries. Never fabricates a fill. */
export function advanceCarryRepair(state: CarryState, input: { atMs: number; quotes: CarryQuotes }) { return commit(state, { type: "ADVANCE", ...input }); }
export function applyCarryFill(state: CarryState, receipt: CarryFill) { return commit(state, { type: "FILL", receipt }); }
export function rejectCarryOrder(state: CarryState, input: { id: string; orderId: string; atMs: number }) { return commit(state, { type: "REJECT", ...input }); }
/** A declared discrete-settlement proxy receipt. This is not an exchange cash
 * reconciliation: continuous accrual and position-change settlements are not
 * reconstructed, including when all discrete proxy obligations are present. */
export function applyCarryFunding(state: CarryState, receipt: CarryFundingReceipt) { return commit(state, { type: "FUNDING", receipt }); }
export function validateCarryState(value: unknown, nowMs?: number): value is CarryState {
  try {
    const s = value as CarryState;
    if (!s || s.version !== CARRY_EXECUTION_SPEC.version || !Array.isArray(s.journal)
      || nowMs !== undefined && (!time(nowMs) || s.lastAtMs !== null && s.lastAtMs > nowMs)) return false;
    if (trusted.has(s)) return true;
    let expected = initial(s.config); const ids = new Set<string>();
    for (const c of s.journal) {
      const key = commandId(c); if (key !== null) { if (ids.has(key)) return false; ids.add(key); }
      expected = reduce(expected, structuredClone(c));
    }
    return canonical(expected) === canonical(core(s)) && s.stateSha256 === hash({ ...core(s), journal: s.journal });
  } catch { return false; }
}
/** Pending paper orders are cancelled on restart; inventory and repair intent survive. */
export function restoreCarryState(value: unknown, nowMs: number): CarryState {
  if (!validateCarryState(value, nowMs)) throw new Error("CARRY_INVALID_CHECKPOINT");
  let out = finish(core(value), structuredClone(value.journal));
  if (out.pendingOrderId) out = rejectCarryOrder(out, { id: `restart-cancel:${out.pendingOrderId}:${nowMs}`, orderId: out.pendingOrderId, atMs: nowMs });
  return advanceCarryRepair(out, { atMs: nowMs, quotes: { spot: null, future: null } });
}
export function carryLiquidation(state: CarryState, input: { atMs: number; quotes: CarryQuotes }) {
  if (!validateCarryState(state)) throw new Error("CARRY_INVALID_STATE");
  const s = core(state); advanceClock(s, input.atMs);
  const spot = quote(s, input.quotes.spot, "spot", input.atMs), future = quote(s, input.quotes.future, "future", input.atMs);
  const quotesKnown = (s.spot.qty === 0 || spot !== null) && (s.future.qty === 0 || future !== null);
  const unknownFundingSettlements = s.funding.filter(f => f.costUsd === null).length;
  const closeFeesUsd = quotesKnown ? s.spot.qty * (spot?.bid ?? 0) * s.config.spotFeeBps / 10_000
    + Math.abs(s.future.qty) * (future?.ask ?? 0) * s.config.futureFeeBps / 10_000 : null;
  const equity = quotesKnown ? s.spot.cashUsd + s.spot.qty * (spot?.bid ?? 0) + s.future.collateralUsd
    + s.future.qty * ((future?.ask ?? 0) - s.future.averagePrice) - closeFeesUsd! : null;
  return { version: CARRY_EXECUTION_SPEC.version, execution: "PAPER_RECEIPTS_ONLY", externalOrdersAllowed: false,
    status: s.status, asOfMs: input.atMs, quotesKnown, declaredSettlementObligationsKnown: unknownFundingSettlements === 0,
    fundingAccounting: "DISCRETE_SETTLEMENT_PROXY_ONLY", exchangeFundingAccountingVerified: false,
    unknownFundingSettlements, estimatedClosingFeesUsd: closeFeesUsd,
    indicativeLiquidationEquityUsd: equity,
    fullyCostedNetPnlUsd: null, liquidationNetPnlUsd: null,
    syntheticDeclaredSettlementNetPnlUsd: equity === null || unknownFundingSettlements ? null : equity - s.config.spotCashUsd - s.config.derivativeCollateralUsd,
    spotInstrumentId: s.config.spot.id, futureInstrumentId: s.config.future.id,
    unmatchedBaseQty: cleanQty(s.spot.qty + s.future.qty),
    grossNotionalUsd: quotesKnown ? s.spot.qty * (spot?.ask ?? 0) + Math.abs(s.future.qty) * (future?.ask ?? 0) : null,
    pendingOrderId: s.pendingOrderId };
}
