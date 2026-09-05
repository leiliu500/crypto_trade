import type { BookState, MarketTrade } from "../core/market.js";

export const RETEST_RULES = Object.freeze({ version: "breakout-retest-v1", rangeMs: 60_000, sampleMs: 1_000,
  reaccelerationMs: 3_000, setupTtlMs: 120_000, maximumQuoteGapMs: 5_000,
  tradeWindowMs: 3_000, minimumFlow: .15, varianceAlpha: .05, cusumAllowance: .5, cusumThreshold: 5 });
export interface RetestCandidate { side: 1 | -1; boundary: number; invalidationPx: number; signalAtMs: number;
  volatilityBps: number; tradeImbalance: number; setupAtMs: number }
interface Arm { side: 1 | -1; boundary: number; invalidationPx: number; atMs: number; retestedAtMs?: number }
interface Point { atMs: number; mid: number }

/** One causal state machine per instrument; only actual trade events supply TI.
 * Every range excludes the current quote, and breakout boundaries stay frozen. */
export class BreakoutRetest {
  private points: Point[] = [];
  private trades: MarketTrade[] = [];
  private tradeIds = new Set<string>();
  private arm?: Arm;
  private lastQuoteMs?: number;
  private lastTradeMs?: number;
  private variance = 0;
  private mean = 0;
  private up = 0; private down = 0;
  private shiftArmed = true;
  public shift: "UP" | "DOWN" | null = null;
  public candidate: RetestCandidate | null = null;
  public reset(): void {
    this.points = []; this.trades = []; this.tradeIds.clear(); delete this.arm;
    delete this.lastQuoteMs; delete this.lastTradeMs; this.variance = 0; this.mean = 0;
    this.up = 0; this.down = 0; this.shiftArmed = true; this.shift = null; this.candidate = null;
  }
  public onTrade(trade: MarketTrade): void {
    if (this.tradeIds.has(trade.id) || !Number.isFinite(trade.qty) || trade.qty <= 0
      || ![1, -1].includes(trade.aggressor) || !Number.isFinite(trade.exchangeTsMs)
      || trade.receiveTsMs - trade.exchangeTsMs > 2_000 || trade.exchangeTsMs - trade.receiveTsMs > 250
      || !Number.isFinite(trade.receiveTsMs) || (this.lastTradeMs !== undefined && trade.receiveTsMs < this.lastTradeMs)) return;
    this.lastTradeMs = trade.receiveTsMs;
    this.pruneTrades(trade.receiveTsMs);
    this.tradeIds.add(trade.id); this.trades.push(trade);
  }
  public snapshot() { return { version: RETEST_RULES.version, phase: this.candidate ? "CANDIDATE"
    : this.arm?.retestedAtMs !== undefined ? "RETESTED" : this.arm ? "BREAKOUT" : "WATCHING",
    boundary: this.arm?.boundary ?? this.candidate?.boundary ?? null, samples: this.points.length,
    volatilityBps: Math.sqrt(this.variance * 3), shift: this.shift }; }
  public observe(book: BookState, stale = false): RetestCandidate | null {
    const now = book.receiveTsMs;
    this.candidate = null; this.shift = null;
    if (!book.valid || stale || !book.bids[0] || !book.asks[0] || book.asks[0].px <= book.bids[0].px
      || !Number.isFinite(now) || (this.lastQuoteMs !== undefined && (now < this.lastQuoteMs || now - this.lastQuoteMs > RETEST_RULES.maximumQuoteGapMs))) {
      this.reset(); return null;
    }
    if (now === this.lastQuoteMs) return null;
    this.lastQuoteMs = now; this.pruneTrades(now);
    const mid = (book.bids[0].px + book.asks[0].px) / 2, spread = book.asks[0].px - book.bids[0].px;
    if (!(mid > 0) || !Number.isFinite(mid)) { this.reset(); return null; }
    const observedTrades = this.trades.filter((t) => t.receiveTsMs <= now);
    const total = observedTrades.reduce((s, t) => s + t.qty, 0);
    const flow = total ? observedTrades.reduce((s, t) => s + t.aggressor * t.qty, 0) / total : 0;
    this.points = this.points.filter((p) => now - p.atMs <= RETEST_RULES.rangeMs + RETEST_RULES.sampleMs);
    const previous = this.points.at(-1);
    // Normalize the next one-second return by variance known before that return.
    if (previous && now - previous.atMs >= RETEST_RULES.sampleMs) {
      const r = Math.log(mid / previous.mid) * 10_000 / Math.sqrt((now - previous.atMs) / 1_000);
      const z = r / Math.max(.1, Math.sqrt(this.variance));
      this.up = Math.max(0, this.up + z - RETEST_RULES.cusumAllowance);
      this.down = Math.max(0, this.down - z - RETEST_RULES.cusumAllowance);
      if (this.shiftArmed && Math.max(this.up, this.down) > RETEST_RULES.cusumThreshold) {
        this.shift = this.up > this.down ? "UP" : "DOWN"; this.shiftArmed = false;
      }
      if (this.up === 0 && this.down === 0) this.shiftArmed = true;
      this.variance = .95 * this.variance + .05 * (r - this.mean) ** 2;
      this.mean = .95 * this.mean + .05 * r;
    }
    const volatilityBps = Math.sqrt(3 * this.variance);
    if (this.arm && (now - this.arm.atMs > RETEST_RULES.setupTtlMs
      || this.arm.side * (mid - this.arm.invalidationPx) < 0)) delete this.arm;
    else if (this.arm) {
      const a = this.arm, tolerance = Math.abs(a.boundary - a.invalidationPx);
      if (a.retestedAtMs === undefined && now > a.atMs && Math.abs(mid - a.boundary) <= tolerance) a.retestedAtMs = now;
      if (a.retestedAtMs !== undefined && now - a.retestedAtMs >= RETEST_RULES.reaccelerationMs) {
        const interval = this.points.filter((p) => p.atMs >= now - RETEST_RULES.reaccelerationMs && p.atMs < now);
        const covered = interval.length >= 3 && now - interval[0]!.atMs >= RETEST_RULES.reaccelerationMs - RETEST_RULES.sampleMs;
        const extreme = a.side === 1 ? Math.max(...interval.map((p) => p.mid)) : Math.min(...interval.map((p) => p.mid));
        if (covered && a.side * (mid - extreme) > 0 && a.side * flow > RETEST_RULES.minimumFlow) {
          this.candidate = { side: a.side, boundary: a.boundary, invalidationPx: a.invalidationPx,
            signalAtMs: now, volatilityBps, tradeImbalance: flow, setupAtMs: a.atMs };
          delete this.arm;
        }
      }
    } else if (this.points.length >= 55 && now - this.points[0]!.atMs >= RETEST_RULES.rangeMs) {
      const high = Math.max(...this.points.map((p) => p.mid)), low = Math.min(...this.points.map((p) => p.mid));
      const side = mid > high && flow > RETEST_RULES.minimumFlow ? 1 : mid < low && flow < -RETEST_RULES.minimumFlow ? -1 : null;
      if (side) {
        const boundary = side === 1 ? high : low;
        const tolerance = Math.max(2 * spread, mid * volatilityBps / 10_000);
        this.arm = { side, boundary, invalidationPx: boundary - side * tolerance, atMs: now };
      }
    }
    if (!previous || now - previous.atMs >= RETEST_RULES.sampleMs) this.points.push({ atMs: now, mid });
    return this.candidate;
  }
  private pruneTrades(now: number): void {
    while (this.trades[0] && now - this.trades[0].receiveTsMs > RETEST_RULES.tradeWindowMs) {
      this.tradeIds.delete(this.trades.shift()!.id);
    }
  }
}
