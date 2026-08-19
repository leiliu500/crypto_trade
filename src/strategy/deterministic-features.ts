import type { BookState, Features } from "../core/market.js";
import { clamp } from "../core/market.js";

export interface BookPressureObservation {
  providerAgeMs: number;
  usableDepthQty: number;
  usableDepthNotional: number;
  replenishmentPressure: number;
  bidAdditionQty: number;
  askAdditionQty: number;
  bidRemovalQty: number;
  askRemovalQty: number;
}

/** Extra causal state required by the model-free rule engine. */
export interface DeterministicFeatures extends Features {
  microEdgeBps: number;
  impulseBps: number;
  breakoutUpBps: number;
  breakoutDownBps: number;
  anchorDistanceBps: number;
  sigmaImpulseBps: number;
  cusumUpScore: number;
  cusumDownScore: number;
  flowFlipRate: number;
  usableDepthQty: number;
  usableDepthNotional: number;
}

export interface ExtensionConfig {
  impulseWindowMs: number;
  breakoutWindowMs: number;
  anchorWindowMs: number;
  flipWindowMs: number;
  maximumStoredWindowMs: number;
  cusumDrift: number;
  cusumCap: number;
  alignmentDeadband: number;
}

interface PricePoint { t: number; logMid: number; }
interface SignPoint { t: number; sign: -1 | 0 | 1; }

export class BookPressureTracker {
  private previousBids = new Map<number, number>();
  private previousAsks = new Map<number, number>();

  public constructor(private readonly levels: number) {
    if (!Number.isInteger(levels) || levels <= 0) throw new Error("Book-pressure levels must be a positive integer");
  }

  public update(book: BookState): BookPressureObservation {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    let usableDepthQty = 0;
    let usableDepthNotional = 0;
    for (const level of book.bids.slice(0, this.levels)) {
      bids.set(level.px, level.qty); usableDepthQty += level.qty; usableDepthNotional += level.px * level.qty;
    }
    for (const level of book.asks.slice(0, this.levels)) {
      asks.set(level.px, level.qty); usableDepthQty += level.qty; usableDepthNotional += level.px * level.qty;
    }
    const bidDelta = summarizeSide(bids, this.previousBids);
    const askDelta = summarizeSide(asks, this.previousAsks);
    this.previousBids = bids;
    this.previousAsks = asks;
    const additionTotal = bidDelta.added + askDelta.added;
    return {
      providerAgeMs: book.receiveTsMs - book.exchangeTsMs,
      usableDepthQty, usableDepthNotional,
      replenishmentPressure: additionTotal > 0 ? clamp((bidDelta.added - askDelta.added) / additionTotal, -1, 1) : 0,
      bidAdditionQty: bidDelta.added, askAdditionQty: askDelta.added,
      bidRemovalQty: bidDelta.removed, askRemovalQty: askDelta.removed,
    };
  }
}

class CausalCusum {
  public up = 0;
  public down = 0;
  public constructor(private readonly drift: number, private readonly cap: number) {}
  public update(z: number): void {
    const bounded = clamp(z, -8, 8);
    this.up = clamp(Math.max(0, this.up + bounded - this.drift), 0, this.cap);
    this.down = clamp(Math.min(0, this.down + bounded + this.drift), -this.cap, 0);
  }
}

class FlipRateTracker {
  private points: SignPoint[] = [];
  private head = 0;
  private transitions = 0;
  private flips = 0;
  public constructor(private readonly windowMs: number) {}
  public update(nowMs: number, sign: -1 | 0 | 1): number {
    const cutoff = nowMs - this.windowMs;
    while (this.head < this.points.length && this.points[this.head]!.t < cutoff) {
      const removed = this.points[this.head]!;
      const next = this.points[this.head + 1];
      if (next) {
        this.transitions -= 1;
        if (removed.sign !== next.sign) this.flips -= 1;
      }
      this.head += 1;
    }
    if (this.head === this.points.length) { this.points = []; this.head = 0; this.transitions = 0; this.flips = 0; }
    if (this.head > 1024) { this.points = this.points.slice(this.head); this.head = 0; }
    if (sign !== 0) {
      const previous = this.points.at(-1);
      if (previous) { this.transitions += 1; if (previous.sign !== sign) this.flips += 1; }
      this.points.push({ t: nowMs, sign });
    }
    return this.transitions > 0 ? this.flips / this.transitions : 0;
  }
}

export class DeterministicFeatureExtensions {
  private points: PricePoint[] = [];
  private head = 0;
  private previousLogMid?: number;
  private previousMs?: number;
  private readonly cusum: CausalCusum;
  private readonly flips: FlipRateTracker;

  public constructor(private readonly cfg: ExtensionConfig) {
    validateExtensionConfig(cfg);
    this.cusum = new CausalCusum(cfg.cusumDrift, cfg.cusumCap);
    this.flips = new FlipRateTracker(cfg.flipWindowMs);
  }

  public update(features: Features, pressure: BookPressureObservation): DeterministicFeatures {
    const nowMs = features.receiveTsMs;
    const logMid = Math.log(features.mid);
    const impulseReference = this.referenceLogPrice(nowMs - this.cfg.impulseWindowMs);
    const anchorReference = this.referenceLogPrice(nowMs - this.cfg.anchorWindowMs);
    const range = this.priorRange(nowMs);
    const impulseBps = impulseReference === undefined ? 0 : 10_000 * (logMid - impulseReference);
    const anchorDistanceBps = anchorReference === undefined ? 0 : 10_000 * (logMid - anchorReference);
    const breakoutUpBps = range === undefined ? 0 : Math.max(0, 10_000 * (logMid - range.high));
    const breakoutDownBps = range === undefined ? 0 : Math.max(0, 10_000 * (range.low - logMid));
    if (this.previousLogMid !== undefined && this.previousMs !== undefined) {
      const dtSec = Math.max((nowMs - this.previousMs) / 1_000, 1e-4);
      const sigma = Math.sqrt(Math.max(features.varianceRate * dtSec, 1e-16));
      this.cusum.update((logMid - this.previousLogMid) / sigma);
    }
    const rawAlignment = features.microEdgeZ + features.qiK + .5 * features.ofi + features.tfi + features.velocityZ;
    const sign: -1 | 0 | 1 = rawAlignment > this.cfg.alignmentDeadband ? 1 : rawAlignment < -this.cfg.alignmentDeadband ? -1 : 0;
    const flowFlipRate = this.flips.update(nowMs, sign);
    const sigmaImpulseBps = 10_000 * Math.sqrt(Math.max(features.varianceRate * (this.cfg.impulseWindowMs / 1_000), 1e-16));
    this.points.push({ t: nowMs, logMid });
    this.previousLogMid = logMid; this.previousMs = nowMs; this.trim(nowMs);
    return {
      ...features,
      microEdgeBps: 10_000 * Math.log(features.microprice / features.mid),
      impulseBps, breakoutUpBps, breakoutDownBps, anchorDistanceBps, sigmaImpulseBps,
      cusumUpScore: this.cusum.up, cusumDownScore: this.cusum.down, flowFlipRate,
      replenishmentPressure: pressure.replenishmentPressure,
      // FeatureEngine owns clock-skew normalization; never replace its adjusted age with raw book age.
      providerAgeMs: features.providerAgeMs,
      usableDepthQty: pressure.usableDepthQty,
      usableDepthNotional: pressure.usableDepthNotional,
    };
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.cfg.maximumStoredWindowMs;
    while (this.head + 1 < this.points.length && this.points[this.head + 1]!.t < cutoff) this.head += 1;
    if (this.head > 2048) { this.points = this.points.slice(this.head); this.head = 0; }
  }
  private referenceLogPrice(targetMs: number): number | undefined {
    if (this.points.length <= this.head) return undefined;
    let lo = this.head, hi = this.points.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.points[mid]!.t < targetMs) lo = mid + 1; else hi = mid; }
    if (lo <= this.head) return this.points[this.head]?.logMid;
    if (lo >= this.points.length) return this.points.at(-1)?.logMid;
    return this.points[lo - 1]?.logMid;
  }
  private priorRange(nowMs: number): { high: number; low: number } | undefined {
    const cutoff = nowMs - this.cfg.breakoutWindowMs;
    let high = Number.NEGATIVE_INFINITY, low = Number.POSITIVE_INFINITY, count = 0;
    for (let index = this.head; index < this.points.length; index += 1) {
      const point = this.points[index]!; if (point.t < cutoff) continue;
      high = Math.max(high, point.logMid); low = Math.min(low, point.logMid); count += 1;
    }
    return count > 0 ? { high, low } : undefined;
  }
}

function summarizeSide(current: ReadonlyMap<number, number>, previous: ReadonlyMap<number, number>): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const px of new Set([...current.keys(), ...previous.keys()])) {
    const delta = (current.get(px) ?? 0) - (previous.get(px) ?? 0);
    if (delta > 0) added += delta; else removed -= delta;
  }
  return { added, removed };
}
function validateExtensionConfig(cfg: ExtensionConfig): void {
  for (const [name, value] of Object.entries(cfg)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid deterministic extension configuration: ${name}`);
  if (!(cfg.impulseWindowMs > 0 && cfg.breakoutWindowMs > 0 && cfg.anchorWindowMs > 0 && cfg.flipWindowMs > 0 && cfg.cusumCap > 0)) throw new Error("Deterministic feature windows and CUSUM cap must be positive");
  if (!(cfg.maximumStoredWindowMs >= Math.max(cfg.impulseWindowMs, cfg.breakoutWindowMs, cfg.anchorWindowMs, cfg.flipWindowMs))) throw new Error("maximumStoredWindowMs must cover every deterministic feature window");
}
