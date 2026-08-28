import type { BookState, Direction, MarketTrade } from "../core/market.js";
import { estimateSweep } from "./book-walk.js";
import type { ExecutionPlan } from "./planner.js";

export interface EntryRouteShadowStart {
  decisionId: string;
  symbol: string;
  side: Direction;
  family: string;
  createdMs: number;
  selectedStyle: "maker" | "taker" | null;
  makerPlan: ExecutionPlan | null;
  takerPlan: ExecutionPlan | null;
  makerQueueAheadQty: number;
}

export interface EntryRouteShadowMark {
  decisionId: string;
  symbol: string;
  side: Direction;
  family: string;
  selectedStyle: "maker" | "taker" | null;
  signalAtMs: number;
  horizonMs: number;
  markedAtMs: number;
  markDelayMs: number;
  makerAvailable: boolean;
  takerAvailable: boolean;
  makerFillProbability: number | null;
  makerFilledQty: number;
  makerFillFraction: number | null;
  makerFirstFillAtMs: number | null;
  makerFillLatencyMs: number | null;
  makerExpired: boolean;
  makerNetBps: number | null;
  takerNetBps: number | null;
  makerMinusTakerBps: number | null;
  missedTakerAlphaBps: number | null;
  makerExecutableExitPx: number | null;
  takerExecutableExitPx: number | null;
}

interface PendingShadow extends EntryRouteShadowStart {
  nextHorizonIndex: number;
  makerQueueRemainingQty: number;
  makerFilledQty: number;
  makerFirstFillAtMs: number | null;
}

/** Causal paper/shadow comparison of a resting maker entry with an immediate bounded IOC entry. */
export class EntryRouteShadowTracker {
  private readonly pending = new Map<string, PendingShadow>();

  public constructor(private readonly horizonsMs: readonly number[], private readonly maximumPending = 1_000) {
    if (horizonsMs.length === 0 || horizonsMs.some((value) => !Number.isInteger(value) || value <= 0)
      || horizonsMs.some((value, index) => index > 0 && value <= horizonsMs[index - 1]!)) {
      throw new Error("Entry route shadow horizons must be positive, unique, and increasing");
    }
    if (!Number.isInteger(maximumPending) || maximumPending < 1) throw new Error("Maximum pending shadows must be positive");
  }

  public start(input: EntryRouteShadowStart): boolean {
    if (!input.makerPlan && !input.takerPlan) return false;
    if (this.pending.has(input.decisionId)) return false;
    if (this.pending.size >= this.maximumPending) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(input.decisionId, {
      ...input, nextHorizonIndex: 0, makerQueueRemainingQty: Math.max(0, input.makerQueueAheadQty),
      makerFilledQty: 0, makerFirstFillAtMs: null,
    });
    return true;
  }

  public observeTrade(trade: MarketTrade): void {
    for (const shadow of this.pending.values()) {
      const plan = shadow.makerPlan;
      if (!plan || shadow.symbol !== trade.symbol || trade.receiveTsMs > plan.expiresMs
        || shadow.makerFilledQty >= plan.qty) continue;
      const contra = plan.side === 1 ? trade.aggressor === -1 && trade.px <= plan.limitPx
        : trade.aggressor === 1 && trade.px >= plan.limitPx;
      if (!contra) continue;
      let available = trade.qty;
      if (trade.px === plan.limitPx && shadow.makerQueueRemainingQty > 0) {
        const consumedAhead = Math.min(shadow.makerQueueRemainingQty, available);
        shadow.makerQueueRemainingQty -= consumedAhead;
        available -= consumedAhead;
      } else if ((plan.side === 1 && trade.px < plan.limitPx) || (plan.side === -1 && trade.px > plan.limitPx)) {
        shadow.makerQueueRemainingQty = 0;
      }
      if (shadow.makerQueueRemainingQty > 0 || available <= 0) continue;
      const fillQty = Math.min(plan.qty - shadow.makerFilledQty, available);
      if (fillQty <= 0) continue;
      shadow.makerFilledQty += fillQty;
      shadow.makerFirstFillAtMs ??= trade.receiveTsMs;
    }
  }

  public mark(symbol: string, book: BookState, nowMs: number): EntryRouteShadowMark[] {
    const marks: EntryRouteShadowMark[] = [];
    for (const [decisionId, shadow] of this.pending) {
      if (shadow.symbol !== symbol) continue;
      while (shadow.nextHorizonIndex < this.horizonsMs.length) {
        const horizonMs = this.horizonsMs[shadow.nextHorizonIndex]!;
        const targetMs = shadow.createdMs + horizonMs;
        if (nowMs < targetMs) break;
        marks.push(this.makeMark(shadow, book, horizonMs, nowMs));
        shadow.nextHorizonIndex += 1;
      }
      if (shadow.nextHorizonIndex >= this.horizonsMs.length) this.pending.delete(decisionId);
    }
    return marks;
  }

  public size(): number { return this.pending.size; }

  private makeMark(shadow: PendingShadow, book: BookState, horizonMs: number, nowMs: number): EntryRouteShadowMark {
    const exitLevels = shadow.side === 1 ? book.bids : book.asks;
    const makerExitSweep = book.valid && shadow.makerFilledQty > 0
      ? estimateSweep(exitLevels, shadow.makerFilledQty) : null;
    const takerExitSweep = book.valid && shadow.takerPlan && shadow.takerPlan.qty > 0
      ? estimateSweep(exitLevels, shadow.takerPlan.qty) : null;
    const makerExecutableExitPx = makerExitSweep?.vwap ?? null;
    const takerExecutableExitPx = takerExitSweep?.vwap ?? null;
    const makerFillFraction = shadow.makerPlan ? Math.min(1, shadow.makerFilledQty / shadow.makerPlan.qty) : null;
    // Express the maker policy on intended capital. A partial fill therefore
    // earns only its filled fraction of the per-unit markout; an unfilled
    // maker remains null and the analysis policy scores it as zero.
    const makerNetBps = shadow.makerPlan && makerFillFraction !== null && makerFillFraction > 0
      && makerExecutableExitPx !== null
      ? makerFillFraction * netMarkoutBps(shadow.side, shadow.makerPlan.limitPx, makerExecutableExitPx,
        shadow.makerPlan.expectedCost.feeBps,
        shadow.makerPlan.expectedCost.fundingBps + shadow.makerPlan.expectedCost.borrowBps) : null;
    const takerEntryPx = shadow.takerPlan?.expectedCost.entryVwap;
    const takerNetBps = shadow.takerPlan && takerEntryPx !== undefined && takerEntryPx > 0
      && takerExecutableExitPx !== null
      ? netMarkoutBps(shadow.side, takerEntryPx, takerExecutableExitPx, shadow.takerPlan.expectedCost.feeBps,
        shadow.takerPlan.expectedCost.fundingBps + shadow.takerPlan.expectedCost.borrowBps) : null;
    return {
      decisionId: shadow.decisionId, symbol: shadow.symbol, side: shadow.side, family: shadow.family,
      selectedStyle: shadow.selectedStyle, signalAtMs: shadow.createdMs, horizonMs, markedAtMs: nowMs,
      markDelayMs: Math.max(0, nowMs - (shadow.createdMs + horizonMs)),
      makerAvailable: shadow.makerPlan !== null, takerAvailable: shadow.takerPlan !== null,
      makerFillProbability: shadow.makerPlan?.fillProbability ?? null,
      makerFilledQty: shadow.makerFilledQty, makerFillFraction,
      makerFirstFillAtMs: shadow.makerFirstFillAtMs,
      makerFillLatencyMs: shadow.makerFirstFillAtMs === null ? null : shadow.makerFirstFillAtMs - shadow.createdMs,
      makerExpired: shadow.makerPlan ? nowMs >= shadow.makerPlan.expiresMs : false,
      makerNetBps, takerNetBps,
      makerMinusTakerBps: makerNetBps === null || takerNetBps === null ? null : makerNetBps - takerNetBps,
      missedTakerAlphaBps: shadow.makerPlan && shadow.makerFilledQty === 0 ? takerNetBps : null,
      makerExecutableExitPx, takerExecutableExitPx,
    };
  }
}

function netMarkoutBps(side: Direction, entryPx: number, exitPx: number, feeBps: number, carryingBps: number): number {
  return side * (exitPx - entryPx) / entryPx * 10_000 - feeBps - carryingBps;
}
