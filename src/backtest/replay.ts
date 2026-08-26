import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { BookDelta } from "../core/order-book.js";
import { LocalOrderBook } from "../core/order-book.js";
import type { BookState, MarketTrade } from "../core/market.js";
import type { ExecutionPlan } from "../execution/planner.js";

export type RecordedEvent =
  | { kind: "BOOK"; delta: BookDelta }
  | { kind: "TRADE"; trade: MarketTrade }
  | { kind: "PRIVATE"; event: unknown }
  | { kind: "DISCONNECT"; receiveTsMs: number; stream: "public" | "private" }
  | { kind: "RECORDER_GAP"; receiveTsMs: number; droppedEvents: number; droppedBytes: number };

export interface ReplayStats { events: number; books: number; trades: number; duplicates: number; invalidBooks: number; disconnects: number; gaps: number; firstTsMs?: number; lastTsMs?: number; }
export interface WalkForwardFold { train: [number, number]; validation: [number, number]; test: [number, number]; purgeMs: number; embargoMs: number; }
export interface StressProfile { feeMultiplier: number; slippageMultiplier: number; latencyMultiplier: number; fillProbabilityMultiplier: number; adverseSelectionMultiplier: number; spreadMultiplier: number; depthMultiplier: number; }

export async function* readRecordedEvents(path: string): AsyncGenerator<RecordedEvent> {
  const file = createReadStream(path);
  const input = path.toLowerCase().endsWith(".gz") ? file.pipe(createGunzip()) : file;
  input.setEncoding("utf8");
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as RecordedEvent;
    yield parsed;
  }
}

export async function validateReplay(path: string): Promise<ReplayStats> {
  const books = new Map<string, LocalOrderBook>();
  const stats: ReplayStats = { events: 0, books: 0, trades: 0, duplicates: 0, invalidBooks: 0, disconnects: 0, gaps: 0 };
  for await (const event of readRecordedEvents(path)) {
    stats.events += 1;
    const timestamp = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs
      : event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP" ? event.receiveTsMs : undefined;
    if (timestamp !== undefined) { stats.firstTsMs ??= timestamp; stats.lastTsMs = timestamp; }
    if (event.kind === "BOOK") {
      stats.books += 1;
      const book = books.get(event.delta.symbol) ?? new LocalOrderBook(event.delta.symbol);
      books.set(event.delta.symbol, book);
      const result = book.apply(event.delta);
      if (result.duplicate) stats.duplicates += 1;
      else if (!result.accepted) stats.invalidBooks += 1;
    } else if (event.kind === "TRADE") stats.trades += 1;
    else if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT") stats.disconnects += 1;
      else stats.gaps += 1;
      for (const book of books.values()) book.invalidate();
    }
  }
  return stats;
}

/** Arrival-time fill simulator: takers walk the book; makers consume queue ahead. */
export class SimulatedExchange {
  private readonly pending = new Map<string, { plan: ExecutionPlan; arrivalMs: number; cancelAtMs?: number; queueAhead: number; filled: number }>();
  public constructor(private readonly sampleLatencyMs: () => number, private readonly cancellationAheadFraction = .5) {}
  public submit(plan: ExecutionPlan, decisionMs: number, book: BookState): void {
    const queueAhead = plan.side === 1 ? book.bids.find((level) => level.px === plan.limitPx)?.qty ?? 0 : book.asks.find((level) => level.px === plan.limitPx)?.qty ?? 0;
    this.pending.set(plan.clientOrderId, { plan, arrivalMs: decisionMs + this.sampleLatencyMs(), queueAhead, filled: 0 });
  }
  public cancel(clientOrderId: string, nowMs: number): void { const order = this.pending.get(clientOrderId); if (order) order.cancelAtMs = nowMs + this.sampleLatencyMs(); }
  public onBook(book: BookState, nowMs: number): Array<{ clientOrderId: string; qty: number; px: number; final: boolean }> {
    const fills: Array<{ clientOrderId: string; qty: number; px: number; final: boolean }> = [];
    for (const [id, pending] of this.pending) {
      if (pending.cancelAtMs !== undefined && nowMs >= pending.cancelAtMs) { this.pending.delete(id); continue; }
      if (nowMs < pending.arrivalMs || pending.plan.style !== "taker") continue;
      let remaining = pending.plan.qty - pending.filled, notional = 0, filled = 0;
      const levels = pending.plan.side === 1 ? book.asks : book.bids;
      for (const level of levels) {
        if (remaining <= 1e-12) break;
        if (pending.plan.side === 1 ? level.px > pending.plan.limitPx : level.px < pending.plan.limitPx) break;
        const take = Math.min(remaining, level.qty); filled += take; notional += take * level.px; remaining -= take;
      }
      if (filled > 0) { pending.filled += filled; fills.push({ clientOrderId: id, qty: filled, px: notional / filled, final: pending.filled >= pending.plan.qty - 1e-12 }); }
      this.pending.delete(id); // IOC cancels any remainder.
    }
    return fills;
  }
  public onTrade(trade: MarketTrade, nowMs: number): Array<{ clientOrderId: string; qty: number; px: number; final: boolean }> {
    const fills: Array<{ clientOrderId: string; qty: number; px: number; final: boolean }> = [];
    for (const [id, pending] of this.pending) {
      if (nowMs < pending.arrivalMs || pending.plan.style !== "maker") continue;
      const toward = pending.plan.side === 1 ? trade.aggressor === -1 && trade.px <= pending.plan.limitPx : trade.aggressor === 1 && trade.px >= pending.plan.limitPx;
      if (!toward) continue;
      const depleted = trade.qty;
      const aheadDepletion = Math.min(pending.queueAhead, depleted * this.cancellationAheadFraction);
      pending.queueAhead -= aheadDepletion;
      const available = Math.max(0, depleted - aheadDepletion);
      const qty = Math.min(available, pending.plan.qty - pending.filled);
      if (qty > 0) { pending.filled += qty; const final = pending.filled >= pending.plan.qty - 1e-12; fills.push({ clientOrderId: id, qty, px: pending.plan.limitPx, final }); if (final) this.pending.delete(id); }
    }
    return fills;
  }
}

export function createWalkForwardFolds(startMs: number, endMs: number, trainMs: number, validationMs: number, testMs: number, maximumLatencyMs: number, maximumHorizonMs: number, embargoMs = maximumLatencyMs + maximumHorizonMs): WalkForwardFold[] {
  const purgeMs = maximumLatencyMs + maximumHorizonMs;
  const folds: WalkForwardFold[] = [];
  for (let cursor = startMs; cursor + trainMs + validationMs + testMs + 2 * purgeMs <= endMs; cursor += testMs) {
    const trainEnd = cursor + trainMs;
    const validationStart = trainEnd + purgeMs;
    const validationEnd = validationStart + validationMs;
    const testStart = validationEnd + purgeMs;
    folds.push({ train: [cursor, trainEnd], validation: [validationStart, validationEnd], test: [testStart, testStart + testMs], purgeMs, embargoMs });
  }
  return folds;
}

export const CONSERVATIVE_STRESSES: Record<string, StressProfile> = {
  baseline: { feeMultiplier: 1, slippageMultiplier: 1, latencyMultiplier: 1, fillProbabilityMultiplier: 1, adverseSelectionMultiplier: 1, spreadMultiplier: 1, depthMultiplier: 1 },
  fees: { feeMultiplier: 1.5, slippageMultiplier: 1, latencyMultiplier: 1, fillProbabilityMultiplier: 1, adverseSelectionMultiplier: 1, spreadMultiplier: 1, depthMultiplier: 1 },
  slippage: { feeMultiplier: 1, slippageMultiplier: 2, latencyMultiplier: 1, fillProbabilityMultiplier: 1, adverseSelectionMultiplier: 1, spreadMultiplier: 1, depthMultiplier: 1 },
  latency: { feeMultiplier: 1, slippageMultiplier: 1, latencyMultiplier: 2, fillProbabilityMultiplier: 1, adverseSelectionMultiplier: 1, spreadMultiplier: 1, depthMultiplier: 1 },
  liquidity: { feeMultiplier: 1, slippageMultiplier: 2, latencyMultiplier: 1, fillProbabilityMultiplier: .6, adverseSelectionMultiplier: 1.5, spreadMultiplier: 2, depthMultiplier: .5 },
};
