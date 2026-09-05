import { estimateSweep } from "../execution/book-walk.js";
import type { BookState, Direction } from "../core/market.js";

/** Cash-flow ledger for a linear contract. Fees and funding are USD cash flows,
 * never percentages. Spread/impact already embedded in execution prices. */
export interface LinearLedger {
  side: Direction; entryQty: number; remainingQty: number; entryNotional: number;
  exitNotional: number; entryFees: number; exitFees: number;
  fundingCash: number; otherCosts: number;
  fundingEvidence: "UNOBSERVED" | "CASH_FLOWS_RECORDED";
}
export function newLinearLedger(side: Direction): LinearLedger {
  return { side, entryQty: 0, remainingQty: 0, entryNotional: 0, exitNotional: 0,
    entryFees: 0, exitFees: 0, fundingCash: 0, otherCosts: 0, fundingEvidence: "UNOBSERVED" };
}
export function recordLinearFill(l: LinearLedger, qty: number, price: number, fee: number, closing: boolean): void {
  if (![qty, price, fee].every(Number.isFinite) || qty <= 0 || price <= 0
    || (closing && qty > l.remainingQty + 1e-10)) throw new Error("INVALID_LINEAR_FILL");
  if (closing) {
    l.remainingQty = Math.max(0, l.remainingQty - qty); l.exitNotional += qty * price; l.exitFees += fee;
  } else {
    l.entryQty += qty; l.remainingQty += qty; l.entryNotional += qty * price; l.entryFees += fee;
  }
}
export function recordFunding(l: LinearLedger, cash: number): void {
  if (!Number.isFinite(cash)) throw new Error("INVALID_FUNDING_CASH");
  l.fundingCash += cash;
  l.fundingEvidence = "CASH_FLOWS_RECORDED";
}
/** Accrue an explicitly observed hourly decimal funding rate, with positive
 * rate paid by longs. Callers must provide bounded, nonoverlapping intervals. */
export function fundingCashForInterval(side: Direction, qty: number, mark: number, hourlyRate: number, elapsedMs: number): number {
  if (![qty, mark, hourlyRate, elapsedMs].every(Number.isFinite) || qty < 0 || mark <= 0 || elapsedMs < 0) {
    throw new Error("INVALID_FUNDING_INTERVAL");
  }
  return -side * qty * mark * hourlyRate * elapsedMs / 3_600_000;
}
export function netLiquidation(l: LinearLedger, exitPrice: number, exitFeeBps: number, reserveUsd = 0): number {
  if (![exitPrice, exitFeeBps, reserveUsd].every(Number.isFinite) || exitPrice <= 0 || reserveUsd < 0) {
    throw new Error("INVALID_LIQUIDATION_PRICE_OR_COST");
  }
  const remainingNotional = l.remainingQty * exitPrice;
  return l.side * (l.exitNotional + remainingNotional - l.entryNotional)
    - l.entryFees - l.exitFees - remainingNotional * exitFeeBps / 10_000
    + l.fundingCash - l.otherCosts - reserveUsd;
}
export function liquidationFromBook(l: LinearLedger, book: BookState, feeBps: number, reserveUsd = 0) {
  if (!book.valid || !book.bids[0] || !book.asks[0] || book.bids[0].px >= book.asks[0].px) return null;
  const sweep = estimateSweep(l.side === 1 ? book.bids : book.asks, l.remainingQty);
  return sweep ? { price: sweep.vwap, netPnl: netLiquidation(l, sweep.vwap, feeBps, reserveUsd) } : null;
}
/** Required execution price, not a guaranteed stop trigger. Also valid after
 * partial exits because realized cash flows remain in the same ledger. */
export function requiredNetExecutionPrice(l: LinearLedger, targetUsd: number, exitFeeBps: number, reserveUsd = 0): number | null {
  const denominator = l.remainingQty * (l.side - exitFeeBps / 10_000);
  if (l.remainingQty <= 0 || ![targetUsd, denominator, reserveUsd].every(Number.isFinite) || denominator === 0) return null;
  const price = (targetUsd - l.side * (l.exitNotional - l.entryNotional)
    + l.entryFees + l.exitFees - l.fundingCash + l.otherCosts + reserveUsd) / denominator;
  return Number.isFinite(price) && price > 0 ? price : null;
}
export function validLinearLedger(value: unknown): value is LinearLedger {
  if (!value || typeof value !== "object") return false;
  const l = value as LinearLedger;
  return [1, -1].includes(l.side) && [l.entryQty, l.remainingQty, l.entryNotional, l.exitNotional,
    l.entryFees, l.exitFees, l.fundingCash, l.otherCosts].every(Number.isFinite)
    && l.entryQty > 0 && l.remainingQty >= 0 && l.remainingQty <= l.entryQty + 1e-10
    && l.entryNotional > 0 && l.exitNotional >= 0 && l.otherCosts >= 0
    && ["UNOBSERVED", "CASH_FLOWS_RECORDED"].includes(l.fundingEvidence);
}

export interface NetProtection {
  initialRiskUsd: number; entryNotional: number; peakUsd: number; troughUsd: number; floorUsd: number;
  activated: boolean; recovered: boolean;
}
export function newNetProtection(initialRiskUsd: number, entryNotional: number): NetProtection {
  if (!(initialRiskUsd > 0) || !(entryNotional > 0) || !Number.isFinite(initialRiskUsd + entryNotional)) throw new Error("INVALID_NET_RISK");
  return { initialRiskUsd, entryNotional, peakUsd: 0, troughUsd: 0, floorUsd: -initialRiskUsd, activated: false, recovered: false };
}
/** Frozen design hypotheses: activation 1R, retain half the peak, minimum
 * giveback .25R, volatility allowance 2 sigma, recovery -.5R then +.25R. */
export function updateNetProtection(p: NetProtection, netUsd: number, volatilityBps: number): boolean {
  if (!Number.isFinite(netUsd) || !Number.isFinite(volatilityBps) || volatilityBps < 0) throw new Error("INVALID_NET_PROTECTION_INPUT");
  p.peakUsd = Math.max(p.peakUsd, netUsd); p.troughUsd = Math.min(p.troughUsd, netUsd);
  if (p.troughUsd <= -.5 * p.initialRiskUsd && netUsd >= .25 * p.initialRiskUsd) p.recovered = true;
  if (p.recovered) p.floorUsd = Math.max(p.floorUsd, 0);
  if (p.peakUsd >= p.initialRiskUsd) p.activated = true;
  if (p.activated) {
    const allowance = Math.max(.25 * p.initialRiskUsd, 2 * p.entryNotional * volatilityBps / 10_000);
    p.floorUsd = Math.max(p.floorUsd, .05 * p.initialRiskUsd, .5 * p.peakUsd, p.peakUsd - allowance);
  }
  return netUsd <= p.floorUsd;
}
export function validNetProtection(value: unknown): value is NetProtection {
  if (!value || typeof value !== "object") return false;
  const p = value as NetProtection;
  return [p.initialRiskUsd, p.entryNotional, p.peakUsd, p.troughUsd, p.floorUsd].every(Number.isFinite)
    && p.initialRiskUsd > 0 && p.entryNotional > 0 && p.peakUsd >= 0 && p.troughUsd <= 0
    && p.floorUsd >= -p.initialRiskUsd && typeof p.activated === "boolean" && typeof p.recovered === "boolean";
}
