import type { BookState, Level } from "../core/market.js";
import { distributionBookReason } from "./market.js";
import { DISTRIBUTION_SPEC, DISTRIBUTION_SCENARIOS, type DistributionAction, type DistributionOutcome } from "./spec.js";

export type DistributionScenario = typeof DISTRIBUTION_SCENARIOS[number];
export interface DistributionCosts { feeBps: number; reserveBps: number }
export type DistributionExecutionStatus = "PENDING" | "OPEN" | "EXIT_PENDING" | "COMPLETE";
export const DISTRIBUTION_EXIT_BUFFER_BPS = 10;
/** A fixed protective IOC cap, rounded outward by the exchange tick. */
export function distributionExitLimit(worstPx: number, side: 1 | -1, tickSize: number): number {
  if (![worstPx, tickSize].every(n => Number.isFinite(n) && n > 0)) throw new Error("INVALID_DISTRIBUTION_EXIT_LIMIT");
  const price = worstPx * (1 + side * DISTRIBUTION_EXIT_BUFFER_BPS / 10_000);
  return (side === 1 ? Math.ceil(price / tickSize - 1e-10) : Math.floor(price / tickSize + 1e-10)) * tickSize;
}

/** Shared by observed-path research and the production position policy. */
export function distributionExit(action: DistributionAction, grossBps: number, netBps: number, elapsedMs: number): string | null {
  if (![grossBps, netBps, elapsedMs].every(Number.isFinite)) return "STOP_LOSS";
  if (grossBps <= -action.stopLossBps) return "STOP_LOSS";
  if (netBps >= action.takeProfitNetBps) return "TAKE_PROFIT";
  return elapsedMs >= action.horizonMs ? "DEADLINE" : null;
}

export class DistributionExecutionCase {
  private status: DistributionExecutionStatus = "PENDING";
  private outcome: DistributionOutcome | null = null;
  private readonly signalAtMs: number;
  private readonly symbol: string;
  private readonly limitPrice: number;
  private lastAtMs: number;
  private lastExchangeAtMs: number;
  private lastSequence: bigint;
  private entryAtMs: number | null = null;
  private entryPrice = 0;
  private filledQty = 0;
  private exitArrivalMs = 0;
  private exitLimitPrice = 0;
  private exitReason = "";

  constructor(private readonly action: DistributionAction, private readonly scenario: DistributionScenario,
    book: BookState, private readonly requestedQty: number, private readonly costs: DistributionCosts,
    private readonly tickSize = .01) {
    if (!(requestedQty > 0) || !Number.isFinite(requestedQty) || !Number.isFinite(costs.feeBps) || costs.feeBps < 0
      || !Number.isFinite(costs.reserveBps) || costs.reserveBps < 0 || (action.side !== 1 && action.side !== -1)
      || !Number.isFinite(action.horizonMs) || action.horizonMs <= 0 || !Number.isFinite(action.stopLossBps)
      || action.stopLossBps <= 0 || !Number.isFinite(action.takeProfitNetBps) || action.takeProfitNetBps <= 0
      || !Number.isFinite(scenario.latencyMs) || scenario.latencyMs < 0 || !Number.isFinite(scenario.feeMultiplier)
      || scenario.feeMultiplier < 1 || !Number.isFinite(scenario.depthMultiplier) || scenario.depthMultiplier <= 0
      || scenario.depthMultiplier > 1 || !Number.isFinite(tickSize) || tickSize <= 0) throw new Error("INVALID_DISTRIBUTION_EXECUTION_CONFIG");
    // An in-flight label owns its original policy and costs even if a caller
    // replaces or mutates its configuration while later quotes arrive.
    this.action = { ...action }; this.scenario = { ...scenario }; this.costs = { ...costs };
    this.signalAtMs = this.lastAtMs = book.receiveTsMs; this.symbol = book.symbol;
    this.lastExchangeAtMs = book.exchangeTsMs; this.lastSequence = book.sequence;
    this.limitPrice = (action.side === 1 ? book.asks[0]?.px : book.bids[0]?.px) ?? 0;
    const reason = distributionBookReason(book);
    if (reason) this.invalidate(book.receiveTsMs, reason);
  }

  snapshot(): { status: DistributionExecutionStatus; outcome: DistributionOutcome | null; entryAtMs: number | null; filledQty: number } {
    return { status: this.status, outcome: this.outcome ? { ...this.outcome } : null, entryAtMs: this.entryAtMs, filledQty: this.filledQty };
  }

  observe(book: BookState): DistributionOutcome | null {
    return this.observeChecked(book, () => distributionBookReason(book));
  }

  /** All cases see the same immutable book. Validate its full depth once while
   * preserving each scenario's own latency, fills, and sequence checks. */
  static observeAll(cases: readonly DistributionExecutionCase[], book: BookState): void {
    let checked = false, reason: string | null = null;
    const validate = () => {
      if (!checked) { reason = distributionBookReason(book); checked = true; }
      return reason;
    };
    for (const execution of cases) execution.observeChecked(book, validate);
  }

  private observeChecked(book: BookState, validate: () => string | null): DistributionOutcome | null {
    if (this.outcome) return { ...this.outcome };
    if (book.symbol !== this.symbol) return null;
    const invalid = validate();
    if (invalid) return this.invalidate(book.receiveTsMs, invalid);
    if (this.status === "EXIT_PENDING" && book.receiveTsMs > this.exitArrivalMs - this.scenario.latencyMs + DISTRIBUTION_SPEC.maximumQuoteAgeMs)
      return this.invalidate(book.receiveTsMs, "MISSING_EXIT_ARRIVAL_QUOTE");
    if (book.receiveTsMs < this.lastAtMs || book.exchangeTsMs < this.lastExchangeAtMs || book.sequence < this.lastSequence)
      return this.invalidate(book.receiveTsMs, "REVERSED_BOOK");
    if (book.sequence === this.lastSequence) {
      if (book.receiveTsMs - this.lastAtMs > DISTRIBUTION_SPEC.maximumQuoteGapMs
        || (this.status === "PENDING" && book.receiveTsMs > this.signalAtMs + DISTRIBUTION_SPEC.maximumQuoteAgeMs))
        return this.invalidate(book.receiveTsMs, "MISSING_EXECUTION_QUOTE");
      return null;
    }
    if (book.receiveTsMs - this.lastAtMs > DISTRIBUTION_SPEC.maximumQuoteGapMs)
      return this.invalidate(book.receiveTsMs, "QUOTE_GAP");
    this.lastAtMs = book.receiveTsMs; this.lastExchangeAtMs = book.exchangeTsMs; this.lastSequence = book.sequence;
    if (this.status === "PENDING") {
      if (book.receiveTsMs > this.signalAtMs + DISTRIBUTION_SPEC.maximumQuoteAgeMs)
        return this.invalidate(book.receiveTsMs, "MISSING_ENTRY_ARRIVAL_QUOTE");
      if (book.receiveTsMs < this.signalAtMs + this.scenario.latencyMs) return null;
      const fill = this.sweep(this.action.side === 1 ? book.asks : book.bids, this.requestedQty, this.limitPrice);
      if (fill.qty === 0) return this.complete({ scenario: this.scenario.id, status: "UNFILLED", netBps: 0,
        grossBps: 0, filledFraction: 0, entryAtMs: null, exitAtMs: book.receiveTsMs, reason: "IOC_UNFILLED" });
      this.entryAtMs = book.receiveTsMs; this.entryPrice = fill.price; this.filledQty = fill.qty; this.status = "OPEN";
    }
    if (this.status === "EXIT_PENDING") {
      if (book.receiveTsMs < this.exitArrivalMs) return null;
      const fill = this.sweep(this.action.side === 1 ? book.bids : book.asks, this.filledQty, this.exitLimitPrice, -this.action.side as 1 | -1);
      if (fill.qty < this.filledQty * (1 - 1e-10)) return this.invalidate(book.receiveTsMs, "EXIT_CAP_OR_DEPTH_UNAVAILABLE");
      const values = this.returns(fill.price), fraction = this.filledQty / this.requestedQty;
      return this.complete({ scenario: this.scenario.id, status: "FILLED", netBps: values.net * fraction,
        grossBps: values.gross * fraction, filledFraction: fraction, entryAtMs: this.entryAtMs,
        exitAtMs: book.receiveTsMs, reason: this.exitReason });
    }
    const close = this.sweep(this.action.side === 1 ? book.bids : book.asks, this.filledQty);
    if (close.qty < this.filledQty * (1 - 1e-10)) return this.invalidate(book.receiveTsMs, "INSUFFICIENT_EXIT_DEPTH");
    const values = this.returns(close.price);
    const reason = distributionExit(this.action, values.gross, values.net, book.receiveTsMs - this.entryAtMs!);
    if (reason) {
      this.exitReason = reason; this.exitArrivalMs = book.receiveTsMs + this.scenario.latencyMs;
      this.exitLimitPrice = distributionExitLimit(close.worstPx, -this.action.side as 1 | -1, this.tickSize);
      this.status = "EXIT_PENDING";
    }
    return null;
  }

  invalidate(atMs: number, reason: string): DistributionOutcome {
    if (this.outcome) return { ...this.outcome };
    return this.complete({ scenario: this.scenario.id, status: "INVALID", netBps: null, grossBps: null,
      filledFraction: this.filledQty / this.requestedQty, entryAtMs: this.entryAtMs,
      exitAtMs: Number.isFinite(atMs) ? Math.max(atMs, this.lastAtMs) : this.lastAtMs, reason });
  }

  private returns(exitPrice: number): { gross: number; net: number } {
    const ratio = exitPrice / this.entryPrice;
    const gross = this.action.side * (ratio - 1) * 10_000;
    return { gross, net: gross - this.costs.feeBps * this.scenario.feeMultiplier * (1 + ratio) - this.costs.reserveBps };
  }
  private sweep(levels: readonly Level[], qty: number, limit?: number, side = this.action.side): { qty: number; price: number; worstPx: number } {
    let filled = 0, notional = 0, worstPx = 0;
    for (const level of levels) {
      if (limit !== undefined && (side === 1 ? level.px > limit : level.px < limit)) break;
      const amount = Math.min(qty - filled, level.qty * this.scenario.depthMultiplier);
      filled += amount; notional += amount * level.px; worstPx = level.px;
      if (filled >= qty) break;
    }
    return { qty: filled, price: filled > 0 ? notional / filled : 0, worstPx };
  }
  private complete(outcome: DistributionOutcome): DistributionOutcome {
    this.outcome = { ...outcome }; this.status = "COMPLETE"; return { ...outcome };
  }
}
