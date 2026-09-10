import type { KrakenPaperHistory } from "../kraken/paper-broker.js";
import type { ExecutionPlan } from "../execution/planner.js";
import type { VenuePosition } from "../venue/types.js";
import { paperFundingCashWindow, type PaperFundingHistory } from "./paper-funding-cash.js";

export const ROLLING_PNL_WINDOW_MS = 24 * 3_600_000;
export interface RollingPnlSnapshot {
  status: "KNOWN" | "UNKNOWN";
  reason: string | null;
  asOfMs: number;
  windowStartExclusiveMs: number;
  windowEndInclusiveMs: number;
  realizedPricePnl24hUsd: number | null;
  fees24hUsd: number | null;
  netRealizedPnl24hUsd: number | null;
  utcSessionNetPnlUsd: number | null;
  retainedFillEvents: number;
  retainedMissingFeeEvents: number;
  missingFeeEvents24h: number;
  missingFeeEventsUtcSession: number;
  measurement: "REALIZED_PRICE_PNL_MINUS_RECORDED_EXECUTION_FEES" | "REALIZED_PRICE_PNL_MINUS_RECORDED_FEES_PLUS_PAPER_FUNDING_CASH_POSTINGS";
  fundingIncluded: boolean;
  fundingCash24hUsd?: number | null;
  fundingCashUtcSessionUsd?: number | null;
  fundingUnsettledAccrualUsd?: number | null;
  fundingCoverageStartedAtMs?: number;
  fundingSource?: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS";
}
export interface RollingPnlFill {
  plan: ExecutionPlan;
  cumulativeFilledQty: number;
  qty: number;
  price: number;
  /** Null means the retained fill has no recorded fee; it never means zero. */
  feeUsd: number | null;
  atMs: number;
}
interface Position { side: 1 | -1; qty: number; averagePrice: number }
interface OrderTotals { qty: number; notional: number; symbol: string; side: 1 | -1; reduceOnly: boolean; requestedQty: number }
interface Receipt { cumulative: number; qty: number; price: number; feeUsd: number | null; atMs: number }
interface LedgerData {
  positions: Map<string, Position>;
  orders: Map<string, OrderTotals>;
  receipts: Map<string, Receipt[]>;
  times: number[];
  grossPrefix: number[];
  feePrefix: number[];
  missingFeePrefix: number[];
  exposureIntervals: Array<{ fromMs: number; toMs: number | null }>;
}
const data = (): LedgerData => ({ positions: new Map(), orders: new Map(), receipts: new Map(),
  times: [], grossPrefix: [0], feePrefix: [0], missingFeePrefix: [0], exposureIntervals: [] });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const numeric = (value: unknown): number => typeof value === "number" ? value
  : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
const symbolKey = (value: string) => value.replaceAll("/", "");
const close = (left: number, right: number) => Math.abs(left - right)
  <= 64 * Number.EPSILON * Math.max(1e-6, Math.abs(left), Math.abs(right));
function fail(reason: string): never { throw new Error(`ROLLING_PNL_${reason}`); }
function validatePlan(plan: ExecutionPlan): void {
  if (!plan || typeof plan.clientOrderId !== "string" || !plan.clientOrderId || typeof plan.symbol !== "string"
    || !plan.symbol || ![1, -1].includes(plan.side) || typeof plan.reduceOnlyIntent !== "boolean"
    || !finite(plan.qty) || plan.qty <= 0 || !time(plan.createdMs)) fail("INVALID_ORDER_PLAN");
}
function append(d: LedgerData, fill: RollingPnlFill, nowMs: number): void {
  validatePlan(fill.plan);
  const { plan, qty, price, feeUsd, atMs, cumulativeFilledQty } = fill;
  if (!time(atMs) || atMs > nowMs || atMs < plan.createdMs || !finite(qty) || qty <= 0
    || !finite(price) || price <= 0 || feeUsd !== null && (!finite(feeUsd) || feeUsd < 0)
    || !finite(cumulativeFilledQty) || cumulativeFilledQty <= 0) fail("INVALID_OR_FUTURE_FILL");
  const prior = d.orders.get(plan.clientOrderId);
  if (prior && (prior.symbol !== plan.symbol || prior.side !== plan.side || prior.reduceOnly !== plan.reduceOnlyIntent
    || !close(prior.requestedQty, plan.qty))) fail("ORDER_IDENTITY_CHANGED");
  const oldQty = prior?.qty ?? 0;
  if (cumulativeFilledQty <= oldQty || close(cumulativeFilledQty, oldQty)) {
    const receipt = d.receipts.get(plan.clientOrderId)?.find(r => close(r.cumulative, cumulativeFilledQty));
    const sameFee = receipt && (receipt.feeUsd === null || feeUsd === null
      ? receipt.feeUsd === feeUsd : close(receipt.feeUsd, feeUsd));
    if (receipt && close(receipt.qty, qty) && close(receipt.price, price) && sameFee
      && receipt.atMs === atMs) return;
    fail("CONFLICTING_OR_REGRESSED_FILL");
  }
  if (!close(oldQty + qty, cumulativeFilledQty) || cumulativeFilledQty > plan.qty && !close(cumulativeFilledQty, plan.qty))
    fail("FILL_QUANTITY_GAP_OR_OVERFILL");
  if (atMs < (d.times.at(-1) ?? 0)) fail("OUT_OF_ORDER_FILL");
  const key = symbolKey(plan.symbol), current = d.positions.get(key);
  const wasExposed = d.positions.size > 0;
  let gross = 0;
  if (plan.reduceOnlyIntent) {
    if (!current || current.side === plan.side || qty > current.qty && !close(qty, current.qty)) fail("INVALID_REDUCTION");
    gross = qty * current.side * (price - current.averagePrice);
    const remaining = current.qty - qty;
    if (close(current.qty, qty)) d.positions.delete(key);
    else d.positions.set(key, { ...current, qty: remaining });
  } else {
    if (current && current.side !== plan.side) fail("UNDECLARED_REVERSAL");
    const total = (current?.qty ?? 0) + qty;
    d.positions.set(key, { side: plan.side, qty: total,
      averagePrice: ((current?.qty ?? 0) * (current?.averagePrice ?? 0) + qty * price) / total });
  }
  // This prefix sums known fees only. A separate missing-fee prefix prevents
  // exposing that partial sum as the total fee of an affected time window.
  const nextGross = d.grossPrefix.at(-1)! + gross, nextFees = d.feePrefix.at(-1)! + (feeUsd ?? 0);
  if (![gross, nextGross, nextFees].every(finite)) fail("NONFINITE_ACCOUNTING");
  if (!wasExposed && d.positions.size > 0) d.exposureIntervals.push({ fromMs: atMs, toMs: null });
  if (wasExposed && d.positions.size === 0) d.exposureIntervals.at(-1)!.toMs = atMs;
  d.orders.set(plan.clientOrderId, { qty: cumulativeFilledQty, notional: (prior?.notional ?? 0) + qty * price,
    symbol: plan.symbol, side: plan.side, reduceOnly: plan.reduceOnlyIntent, requestedQty: plan.qty });
  const receipts = d.receipts.get(plan.clientOrderId) ?? [];
  receipts.push({ cumulative: cumulativeFilledQty, qty, price, feeUsd, atMs }); d.receipts.set(plan.clientOrderId, receipts);
  d.times.push(atMs); d.grossPrefix.push(nextGross); d.feePrefix.push(nextFees);
  d.missingFeePrefix.push(d.missingFeePrefix.at(-1)! + (feeUsd === null ? 1 : 0));
}
function rebuild(history: KrakenPaperHistory, nowMs: number, positions?: readonly VenuePosition[]): LedgerData {
  if (!time(nowMs) || !history || !Array.isArray(history.orders) || !Array.isArray(history.activities)
    || history.orders.length > 1_000_000 || history.activities.length > 10_000) fail("INVALID_HISTORY");
  const d = data(), remoteIds = new Map<string, typeof history.orders[number]>(), clientIds = new Set<string>();
  for (const item of history.orders) {
    validatePlan(item?.plan);
    const { remote, plan } = item;
    if (!remote || typeof remote.id !== "string" || !remote.id || remoteIds.has(remote.id)
      || clientIds.has(plan.clientOrderId)) fail("DUPLICATE_OR_INVALID_ORDER");
    if (remote.client_order_id !== plan.clientOrderId || typeof remote.symbol !== "string"
      || symbolKey(remote.symbol) !== symbolKey(plan.symbol) || remote.side !== (plan.side === 1 ? "buy" : "sell")
      || !close(numeric(remote.qty), plan.qty) || !finite(numeric(remote.filled_qty)) || numeric(remote.filled_qty) < 0
      || numeric(remote.filled_qty) > plan.qty && !close(numeric(remote.filled_qty), plan.qty)) fail("INCONSISTENT_ORDER");
    remoteIds.set(remote.id, item); clientIds.add(plan.clientOrderId);
  }
  const activityIds = new Set<string>();
  const fills = history.activities.map((activity, index) => {
    if (!activity || activity.activity_type !== "FILL" || typeof activity.id !== "string" || !activity.id
      || activityIds.has(activity.id)) fail("DUPLICATE_OR_UNKNOWN_ACTIVITY");
    activityIds.add(activity.id);
    const order = activity.order_id ? remoteIds.get(activity.order_id) : undefined;
    const atMs = Date.parse(activity.transaction_time ?? "");
    if (!order || typeof activity.symbol !== "string" || symbolKey(activity.symbol) !== symbolKey(order.plan.symbol)
      || !time(atMs) || atMs > nowMs) fail("UNMATCHED_OR_FUTURE_ACTIVITY");
    return { index, plan: order.plan, atMs, qty: numeric(activity.qty), price: numeric(activity.price),
      feeUsd: activity.fee_usd === undefined ? null : numeric(activity.fee_usd) };
  }).sort((a, b) => a.atMs - b.atMs || b.index - a.index);
  for (const fill of fills) append(d, { ...fill, cumulativeFilledQty: (d.orders.get(fill.plan.clientOrderId)?.qty ?? 0) + fill.qty }, nowMs);
  for (const { plan, remote } of history.orders) {
    const total = d.orders.get(plan.clientOrderId), remoteQty = numeric(remote.filled_qty);
    if (!close(total?.qty ?? 0, remoteQty)) fail("TRUNCATED_OR_INCONSISTENT_FILL_HISTORY");
    if (remoteQty > 0 && (!finite(numeric(remote.filled_avg_price))
      || !close(total!.notional / total!.qty, numeric(remote.filled_avg_price)))) fail("INCONSISTENT_FILL_AVERAGE");
  }
  if (positions !== undefined) {
    if (!Array.isArray(positions)) fail("INVALID_REMOTE_POSITIONS");
    const seen = new Set<string>();
    for (const remote of positions) {
      if (!remote || typeof remote.symbol !== "string" || !["long", "short"].includes(remote.side)) fail("INVALID_REMOTE_POSITION");
      const key = symbolKey(remote.symbol), position = d.positions.get(key), qty = numeric(remote.qty), average = numeric(remote.avg_entry_price);
      if (seen.has(key) || !position || !finite(qty) || qty <= 0 || !finite(average) || average <= 0
        || position.side !== (remote.side === "long" ? 1 : -1) || !close(position.qty, qty)
        || !close(position.averagePrice, average)) fail("REMOTE_POSITION_MISMATCH");
      seen.add(key);
    }
    if (seen.size !== d.positions.size) fail("REMOTE_POSITION_MISMATCH");
  }
  return d;
}
function boundary(times: readonly number[], value: number, inclusive: boolean): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2);
    if (times[mid]! < value || inclusive && times[mid] === value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Full history is checked at reconciliation. New exact fills append in O(1);
 * time-window queries use prefix sums and binary searches, not history scans. */
export class RollingRealizedPnlLedger {
  private ledger = data();
  private reason: string | null = "ROLLING_PNL_HISTORY_NOT_RESTORED";
  private latestNowMs = 0;
  private funding: PaperFundingHistory | undefined;
  private fundingError: string | null = null;
  public updateFunding(history: PaperFundingHistory | undefined): void { this.funding = history; this.fundingError = null; }
  public markFundingUnavailable(reason: string): void { this.fundingError = reason; }
  public invalidate(reason: string): void { this.reason = reason; }
  public restore(history: KrakenPaperHistory, nowMs: number, positions?: readonly VenuePosition[]): boolean {
    try {
      const candidate = rebuild(history, nowMs, positions);
      this.ledger = candidate; this.latestNowMs = nowMs; this.reason = null; this.updateFunding(history.funding);
      return this.snapshot(nowMs).status === "KNOWN";
    }
    catch (error) { this.reason = error instanceof Error ? error.message : "ROLLING_PNL_INVALID_HISTORY"; return false; }
  }
  public recordFill(fill: RollingPnlFill, nowMs: number): boolean {
    if (this.reason !== null) return false;
    try {
      if (!time(nowMs) || nowMs < this.latestNowMs) fail("CLOCK_REGRESSION");
      append(this.ledger, fill, nowMs); this.latestNowMs = nowMs; return true;
    } catch (error) { this.reason = error instanceof Error ? error.message : "ROLLING_PNL_INVALID_FILL"; return false; }
  }
  public snapshot(nowMs: number): RollingPnlSnapshot {
    if (!time(nowMs) || nowMs < this.latestNowMs) this.reason = "ROLLING_PNL_CLOCK_REGRESSION";
    else this.latestNowMs = nowMs;
    const start = nowMs - ROLLING_PNL_WINDOW_MS, d = this.ledger;
    const lo = boundary(d.times, start, true), hi = boundary(d.times, nowMs, true);
    const session = boundary(d.times, Math.floor(nowMs / ROLLING_PNL_WINDOW_MS) * ROLLING_PNL_WINDOW_MS, false);
    const gross = d.grossPrefix[hi]! - d.grossPrefix[lo]!, fees = d.feePrefix[hi]! - d.feePrefix[lo]!;
    const missing24h = d.missingFeePrefix[hi]! - d.missingFeePrefix[lo]!;
    const missingSession = d.missingFeePrefix[hi]! - d.missingFeePrefix[session]!;
    const structurallyKnown = this.reason === null, priceKnown = structurallyKnown && missing24h === 0;
    const sessionStart = Math.floor(nowMs / ROLLING_PNL_WINDOW_MS) * ROLLING_PNL_WINDOW_MS;
    const preEpochExposure = (windowStart: number) => {
      if (!this.funding || windowStart >= this.funding.state.config.startedAtMs) return false;
      const epoch = this.funding.state.config.startedAtMs;
      // With no retained fills, a legacy cash/history discrepancy cannot prove
      // that the unknown earlier part of the window was flat.
      return d.times.length === 0 || d.exposureIntervals.some(interval => interval.fromMs < epoch
        && (interval.toMs ?? Infinity) > windowStart);
    };
    const fundingFailure = this.fundingError ? { known: false, cashUsd: null, reason: this.fundingError } : undefined;
    const funding24h = fundingFailure ?? (this.funding ? paperFundingCashWindow(this.funding, start, nowMs, false, preEpochExposure(start)) : undefined);
    const fundingSession = fundingFailure ?? (this.funding ? paperFundingCashWindow(this.funding, sessionStart, nowMs, true, preEpochExposure(sessionStart)) : undefined);
    const known = priceKnown && (funding24h?.known ?? true);
    const sessionKnown = structurallyKnown && missingSession === 0 && (fundingSession?.known ?? true);
    return { status: known ? "KNOWN" : "UNKNOWN",
      reason: this.reason ?? (missing24h > 0 ? "ROLLING_PNL_RECORDED_FEE_MISSING_IN_WINDOW" : funding24h?.reason ?? null), asOfMs: nowMs,
      windowStartExclusiveMs: start, windowEndInclusiveMs: nowMs,
      realizedPricePnl24hUsd: structurallyKnown ? gross : null, fees24hUsd: priceKnown ? fees : null,
      netRealizedPnl24hUsd: known ? gross - fees + (funding24h?.cashUsd ?? 0) : null,
      utcSessionNetPnlUsd: sessionKnown ? d.grossPrefix[hi]! - d.grossPrefix[session]!
        - d.feePrefix[hi]! + d.feePrefix[session]! + (fundingSession?.cashUsd ?? 0) : null,
      retainedFillEvents: d.times.length, retainedMissingFeeEvents: d.missingFeePrefix.at(-1)!,
      missingFeeEvents24h: missing24h, missingFeeEventsUtcSession: missingSession,
      ...(this.funding || this.fundingError ? {
        measurement: "REALIZED_PRICE_PNL_MINUS_RECORDED_FEES_PLUS_PAPER_FUNDING_CASH_POSTINGS" as const, fundingIncluded: true,
        fundingCash24hUsd: funding24h!.cashUsd, fundingCashUtcSessionUsd: fundingSession!.cashUsd,
        ...(this.funding ? { fundingCoverageStartedAtMs: this.funding.state.config.startedAtMs } : {}),
        fundingUnsettledAccrualUsd: !this.fundingError && this.funding?.snapshot.perSymbol.every(row => row.unsettledFundingCashUsd !== null)
          ? this.funding.snapshot.perSymbol.reduce((sum, row) => sum + row.unsettledFundingCashUsd!, 0) : null,
        fundingSource: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS" as const,
      } : { measurement: "REALIZED_PRICE_PNL_MINUS_RECORDED_EXECUTION_FEES" as const, fundingIncluded: false }) };
  }
}
