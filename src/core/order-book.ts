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
interface OrderedReset { bids: Level[]; asks: Level[]; updatedMs: number; }
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
  // Kraken emits complete, ordered snapshots frequently. Keep those arrays until
  // a delta actually needs a mutable price map, without rebuilding/sorting maps.
  private orderedReset: OrderedReset | undefined;
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
    if (!validLevels(delta.bids) || !validLevels(delta.asks)) {
      this.invalidate();
      return { accepted: false, duplicate: false, reason: "INVALID_LEVEL", flow };
    }
    const dtSec = Math.max((delta.receiveTsMs - this.lastReceiveTsMs) / 1000, 1e-3);
    if (delta.reset && strictlyOrdered(delta.bids, true) && strictlyOrdered(delta.asks, false)) {
      this.bids.clear(); this.asks.clear(); this.initialized = true;
      this.orderedReset = {
        bids: copyResetLevels(delta.bids, flow, true),
        asks: copyResetLevels(delta.asks, flow, false),
        updatedMs: delta.receiveTsMs,
      };
    } else {
      if (delta.reset) {
        this.bids.clear(); this.asks.clear(); this.orderedReset = undefined; this.initialized = true;
      } else this.materializeReset();
      this.applyLevels(this.bids, delta.bids, delta.receiveTsMs, flow, true);
      this.applyLevels(this.asks, delta.asks, delta.receiveTsMs, flow, false);
    }
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

  private materializeReset(): void {
    const reset = this.orderedReset;
    if (!reset) return;
    for (const level of reset.bids) this.bids.set(level.px, { qty: level.qty, updatedMs: reset.updatedMs });
    for (const level of reset.asks) this.asks.set(level.px, { qty: level.qty, updatedMs: reset.updatedMs });
    this.orderedReset = undefined;
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
    const reset = this.orderedReset;
    const bids = reset ? this.copyOrdered(reset.bids, nowMs - reset.updatedMs) : this.sorted(this.bids, true, nowMs);
    const asks = reset ? this.copyOrdered(reset.asks, nowMs - reset.updatedMs) : this.sorted(this.asks, false, nowMs);
    return { symbol: this.symbol, bids, asks, exchangeTsMs: this.lastExchangeTsMs, receiveTsMs: nowMs, sequence: this.sequence, valid: this.valid && Boolean(bids[0] && asks[0] && bids[0].px < asks[0].px), sourceReset };
  }

  private copyOrdered(levels: readonly Level[], ageMs: number): Level[] {
    return levels.slice(0, this.maximumLevels).map(({ px, qty }) => ({ px, qty, ageMs: Math.max(0, ageMs) }));
  }

  private sorted(levels: Map<number, TimedLevel>, descending: boolean, nowMs: number): Level[] {
    return [...levels.entries()]
      .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
      .slice(0, this.maximumLevels)
      .map(([px, value]) => ({ px, qty: value.qty, ageMs: Math.max(0, nowMs - value.updatedMs) }));
  }
}

function validLevels(levels: readonly Level[]): boolean {
  for (const level of levels) {
    if (!Number.isFinite(level.px) || level.px <= 0 || !Number.isFinite(level.qty) || level.qty < 0) return false;
  }
  return true;
}

function strictlyOrdered(levels: readonly Level[], descending: boolean): boolean {
  for (let i = 1; i < levels.length; i++) {
    if (descending ? levels[i - 1]!.px <= levels[i]!.px : levels[i - 1]!.px >= levels[i]!.px) return false;
  }
  return true;
}

function copyResetLevels(levels: readonly Level[], flow: BookFlow, bid: boolean): Level[] {
  const result: Level[] = [];
  for (const { px, qty } of levels) {
    if (qty > 0) result.push({ px, qty });
    if (bid) flow.bidAdded += qty;
    else flow.askAdded += qty;
  }
  return result;
}
