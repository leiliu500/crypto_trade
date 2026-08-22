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
  /** Sampled multi-minute state. It is unavailable until the slow window has causal coverage. */
  slowTrendReady: boolean;
  trendFastBps: number;
  trendMediumBps: number;
  trendSlowBps: number;
  slowTrendAlignment: number;
  slowTrendEfficiency: number;
  slowVarianceRate: number;
  slowSigmaBps: number;
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
  trendSampleIntervalMs: number;
  trendFastWindowMs: number;
  trendMediumWindowMs: number;
  trendSlowWindowMs: number;
  trendMinimumCoverage: number;
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
  private slowPoints: PricePoint[] = [];
  private slowHead = 0;
  private slowState = emptySlowTrendState();

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
    this.updateSlowTrend(nowMs, logMid);
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
      ...this.slowState,
    };
  }

  private updateSlowTrend(nowMs: number, logMid: number): void {
    const last = this.slowPoints.at(-1);
    if (last && nowMs - last.t < this.cfg.trendSampleIntervalMs) return;
    this.slowPoints.push({ t: nowMs, logMid });
    const cutoff = nowMs - this.cfg.trendSlowWindowMs;
    while (this.slowHead + 1 < this.slowPoints.length && this.slowPoints[this.slowHead + 1]!.t < cutoff) {
      this.slowHead += 1;
    }
    if (this.slowHead > 1_024) { this.slowPoints = this.slowPoints.slice(this.slowHead); this.slowHead = 0; }

    const fast = this.slowReturnBps(nowMs, logMid, this.cfg.trendFastWindowMs);
    const medium = this.slowReturnBps(nowMs, logMid, this.cfg.trendMediumWindowMs);
    const slow = this.slowReturnBps(nowMs, logMid, this.cfg.trendSlowWindowMs);
    let squaredReturn = 0, elapsedSec = 0, pathLength = 0;
    for (let index = this.slowHead + 1; index < this.slowPoints.length; index += 1) {
      const previous = this.slowPoints[index - 1]!, current = this.slowPoints[index]!;
      const dtSec = Math.max((current.t - previous.t) / 1_000, 1e-6);
      const change = current.logMid - previous.logMid;
      squaredReturn += change * change;
      elapsedSec += dtSec;
      pathLength += Math.abs(change);
    }
    const slowVarianceRate = elapsedSec > 0 ? Math.max(squaredReturn / elapsedSec, 1e-16) : 1e-16;
    const windowSigma = (windowMs: number): number => 10_000 * Math.sqrt(slowVarianceRate * windowMs / 1_000);
    const normalized = (returnBps: number, windowMs: number): number => Math.tanh(returnBps / Math.max(windowSigma(windowMs), 1));
    const first = this.slowPoints[this.slowHead];
    const coverageMs = first ? nowMs - first.t : 0;
    const slowTrendReady = coverageMs >= this.cfg.trendSlowWindowMs * this.cfg.trendMinimumCoverage
      && this.slowPoints.length - this.slowHead >= 2;
    this.slowState = {
      slowTrendReady,
      trendFastBps: fast,
      trendMediumBps: medium,
      trendSlowBps: slow,
      slowTrendAlignment: clamp((normalized(fast, this.cfg.trendFastWindowMs)
        + normalized(medium, this.cfg.trendMediumWindowMs)
        + normalized(slow, this.cfg.trendSlowWindowMs)) / 3, -1, 1),
      slowTrendEfficiency: pathLength > 0 ? clamp(Math.abs(slow / 10_000) / pathLength, 0, 1) : 0,
      slowVarianceRate,
      slowSigmaBps: windowSigma(this.cfg.trendSlowWindowMs),
    };
  }

  private slowReturnBps(nowMs: number, logMid: number, windowMs: number): number {
    const reference = referenceLogPrice(this.slowPoints, this.slowHead, nowMs - windowMs);
    return reference === undefined ? 0 : 10_000 * (logMid - reference);
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
  if (!(cfg.trendSampleIntervalMs > 0 && cfg.trendFastWindowMs > 0
    && cfg.trendFastWindowMs < cfg.trendMediumWindowMs && cfg.trendMediumWindowMs < cfg.trendSlowWindowMs)) {
    throw new Error("slow trend windows must be positive and strictly increasing");
  }
  if (!(cfg.trendMinimumCoverage > 0 && cfg.trendMinimumCoverage <= 1)) throw new Error("trendMinimumCoverage must be in (0,1]");
}

interface SlowTrendState {
  slowTrendReady: boolean;
  trendFastBps: number;
  trendMediumBps: number;
  trendSlowBps: number;
  slowTrendAlignment: number;
  slowTrendEfficiency: number;
  slowVarianceRate: number;
  slowSigmaBps: number;
}

function emptySlowTrendState(): SlowTrendState {
  return { slowTrendReady: false, trendFastBps: 0, trendMediumBps: 0, trendSlowBps: 0,
    slowTrendAlignment: 0, slowTrendEfficiency: 0, slowVarianceRate: 1e-16, slowSigmaBps: 0 };
}

function referenceLogPrice(points: readonly PricePoint[], head: number, targetMs: number): number | undefined {
  if (points.length <= head) return undefined;
  let lo = head, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid]!.t < targetMs) lo = mid + 1; else hi = mid; }
  if (lo <= head) return points[head]?.logMid;
  if (lo >= points.length) return points.at(-1)?.logMid;
  return points[lo - 1]?.logMid;
}
