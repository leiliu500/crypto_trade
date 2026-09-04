import type { BookFlow, BookState, Level } from "./market.js";

export interface BookDelta {
  symbol: string;
  bids: readonly Level[];
  asks: readonly Level[];
  reset: boolean;
  exchangeTsMs: number;
  receiveTsMs: number;
  sourceId: string;
}

export interface BookUpdateResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
  flow: BookFlow;
  state?: BookState;
}

interface TimedLevel { qty: number; updatedMs: number; }
const emptyFlow = (): BookFlow => ({ bidAdded: 0, bidCanceled: 0, askAdded: 0, askCanceled: 0, bidReplenishmentRate: 0, askReplenishmentRate: 0 });

/**
 * The market feed sends a reset snapshot followed by price-level deltas, but currently
 * exposes no exchange sequence or checksum. We therefore fail closed on missing
 * reset, timestamp reversal, crossed books, duplicates, and reconnects; a local
 * monotonically increasing sequence is only an ordering aid, never represented
 * as an exchange guarantee.
 */
export class LocalOrderBook {
  private readonly bids = new Map<number, TimedLevel>();
  private readonly asks = new Map<number, TimedLevel>();
  private readonly eventIds = new Set<string>();
  private sequence = 0n;
  private initialized = false;
  private valid = false;
  private lastExchangeTsMs = 0;
  private lastReceiveTsMs = 0;

  public constructor(public readonly symbol: string, private readonly maximumLevels = 250) {}

  public invalidate(): void { this.valid = false; this.initialized = false; }
  public isValid(): boolean { return this.valid; }

  public apply(delta: BookDelta): BookUpdateResult {
    const flow = emptyFlow();
    if (delta.symbol !== this.symbol) return { accepted: false, duplicate: false, reason: "SYMBOL_MISMATCH", flow };
    if (this.eventIds.has(delta.sourceId)) return { accepted: false, duplicate: true, flow };
    this.eventIds.add(delta.sourceId);
    if (this.eventIds.size > 50_000) this.eventIds.clear();
    if (!delta.reset && !this.initialized) return { accepted: false, duplicate: false, reason: "MISSING_RESET", flow };
    if (this.initialized && delta.exchangeTsMs < this.lastExchangeTsMs) {
      this.invalidate();
      return { accepted: false, duplicate: false, reason: "TIMESTAMP_REVERSAL", flow };
    }
    if (![...delta.bids, ...delta.asks].every((level) => Number.isFinite(level.px) && level.px > 0 && Number.isFinite(level.qty) && level.qty >= 0)) {
      this.invalidate();
      return { accepted: false, duplicate: false, reason: "INVALID_LEVEL", flow };
    }
    if (delta.reset) { this.bids.clear(); this.asks.clear(); this.initialized = true; }

    const dtSec = Math.max((delta.receiveTsMs - this.lastReceiveTsMs) / 1000, 1e-3);
    this.applyLevels(this.bids, delta.bids, delta.receiveTsMs, flow, true);
    this.applyLevels(this.asks, delta.asks, delta.receiveTsMs, flow, false);
    flow.bidReplenishmentRate = flow.bidAdded / dtSec;
    flow.askReplenishmentRate = flow.askAdded / dtSec;
    this.sequence += 1n;
    this.lastExchangeTsMs = delta.exchangeTsMs;
    this.lastReceiveTsMs = delta.receiveTsMs;

    const state = this.snapshot(delta.reset);
    this.valid = Boolean(state.bids[0] && state.asks[0] && state.bids[0].px < state.asks[0].px);
    if (!this.valid) { this.initialized = false; return { accepted: false, duplicate: false, reason: "CROSSED_OR_EMPTY_BOOK", flow }; }
    return { accepted: true, duplicate: false, flow, state: { ...state, valid: true } };
  }

  private applyLevels(book: Map<number, TimedLevel>, updates: readonly Level[], nowMs: number, flow: BookFlow, bid: boolean): void {
    for (const level of updates) {
      const previous = book.get(level.px)?.qty ?? 0;
      if (level.qty === 0) book.delete(level.px);
      else book.set(level.px, { qty: level.qty, updatedMs: nowMs });
      const added = Math.max(0, level.qty - previous);
      const canceled = Math.max(0, previous - level.qty);
      if (bid) { flow.bidAdded += added; flow.bidCanceled += canceled; }
      else { flow.askAdded += added; flow.askCanceled += canceled; }
    }
  }

  public snapshot(sourceReset = false): BookState {
    const nowMs = this.lastReceiveTsMs;
    const bids = this.sorted(this.bids, true, nowMs);
    const asks = this.sorted(this.asks, false, nowMs);
    return { symbol: this.symbol, bids, asks, exchangeTsMs: this.lastExchangeTsMs, receiveTsMs: nowMs, sequence: this.sequence, valid: this.valid && Boolean(bids[0] && asks[0] && bids[0].px < asks[0].px), sourceReset };
  }

  private sorted(levels: Map<number, TimedLevel>, descending: boolean, nowMs: number): Level[] {
    return [...levels.entries()]
      .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
      .slice(0, this.maximumLevels)
      .map(([px, value]) => ({ px, qty: value.qty, ageMs: Math.max(0, nowMs - value.updatedMs) }));
  }
}
