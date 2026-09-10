import { clamp, type FeatureStaleReason } from "./market.js";

export class TimeEwma {
  private initialized = false;
  private lastMs = 0;
  private samplesInternal = 0;
  public mean = 0;
  public variance = 0;

  public constructor(
    private readonly tauMs: number,
    private readonly varianceFloor = 1e-12,
  ) {
    if (!(tauMs > 0)) throw new Error("tauMs must be positive");
  }

  public get samples(): number { return this.samplesInternal; }
  public get ready(): boolean { return this.samplesInternal >= 2; }

  public zBeforeUpdate(x: number): number {
    if (!this.ready) return 0;
    return clamp((x - this.mean) / Math.sqrt(Math.max(this.variance, this.varianceFloor)), -8, 8);
  }

  public update(x: number, nowMs: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(nowMs)) return;
    if (!this.initialized) {
      this.initialized = true;
      this.lastMs = nowMs;
      this.mean = x;
      this.variance = this.varianceFloor;
      this.samplesInternal = 1;
      return;
    }
    const dtMs = Math.max(0.01, nowMs - this.lastMs);
    const alpha = 1 - Math.exp(-dtMs / this.tauMs);
    const delta = x - this.mean;
    this.mean += alpha * delta;
    this.variance = Math.max(this.varianceFloor, (1 - alpha) * (this.variance + alpha * delta * delta));
    this.lastMs = nowMs;
    this.samplesInternal += 1;
  }

  public zAndUpdate(x: number, nowMs: number): number {
    const z = this.zBeforeUpdate(x);
    this.update(x, nowMs);
    return z;
  }
}

export class DecayedValue {
  private valueInternal = 0;
  private initialized = false;
  private lastMs = 0;
  public constructor(private readonly tauMs: number) {
    if (!(tauMs > 0)) throw new Error("tauMs must be positive");
  }
  private decay(nowMs: number): void {
    if (!this.initialized) { this.initialized = true; this.lastMs = nowMs; return; }
    this.valueInternal *= Math.exp(-Math.max(0, nowMs - this.lastMs) / this.tauMs);
    this.lastMs = nowMs;
  }
  public add(amount: number, nowMs: number): void { this.decay(nowMs); this.valueInternal += amount; }
  public get(nowMs: number): number { this.decay(nowMs); return this.valueInternal; }
}

export class DecayedSignedFlow {
  private numerator = 0;
  private denominator = 0;
  private initialized = false;
  private lastMs = 0;
  public constructor(private readonly tauMs: number) {}
  private decay(nowMs: number): void {
    if (!this.initialized) { this.initialized = true; this.lastMs = nowMs; return; }
    const d = Math.exp(-Math.max(0, nowMs - this.lastMs) / this.tauMs);
    this.numerator *= d; this.denominator *= d; this.lastMs = nowMs;
  }
  public add(signedVolume: number, nowMs: number): void {
    this.decay(nowMs); this.numerator += signedVolume; this.denominator += Math.abs(signedVolume);
  }
  public ratio(nowMs: number): number { this.decay(nowMs); return this.numerator / Math.max(this.denominator, 1e-12); }
}

export class RollingWindow {
  private readonly values: Array<{ t: number; value: number }> = [];
  private head = 0;
  public constructor(private readonly windowMs: number, private readonly maximumSamples = 10_000) {}
  public add(value: number, nowMs: number): void {
    if (!Number.isFinite(value)) return;
    this.values.push({ t: nowMs, value });
    this.prune(nowMs);
    if (this.values.length - this.head > this.maximumSamples) this.head += 1;
    if (this.head > 2048) { this.values.splice(0, this.head); this.head = 0; }
  }
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.head < this.values.length && this.values[this.head]!.t < cutoff) this.head += 1;
  }
  public snapshot(nowMs: number): number[] { this.prune(nowMs); return this.values.slice(this.head).map((x) => x.value); }
  public get size(): number { return this.values.length - this.head; }
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lo = sorted[lower]!;
  const hi = sorted[upper]!;
  return lo + (hi - lo) * (index - lower);
}

export const median = (values: readonly number[]): number => quantile(values, 0.5);
export function mad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

/** The age gate keeps RollingWindow's insertion-order expiry semantics while
 * indexing the same finite values by magnitude. Receipt times may regress: an
 * unexpired FIFO head must still prevent pruning an older timestamp behind it.
 */
class OrderedAgeWindow {
  private readonly values: Array<{ t: number; value: number }> = [];
  private readonly sorted: number[] = [];
  private head = 0;
  public constructor(private readonly windowMs: number) {}

  public add(value: number, nowMs: number): void {
    if (!Number.isFinite(value)) return;
    this.values.push({ t: nowMs, value });
    this.sorted.splice(this.lowerBound(value), 0, value);
    this.prune(nowMs);
    if (this.values.length - this.head > 4096) {
      this.remove(this.values[this.head]!.value); this.head += 1;
    }
    if (this.head > 2048) { this.values.splice(0, this.head); this.head = 0; }
  }

  public statistics(nowMs: number, minimumSamples: number): { center: number; deviation: number } | null {
    this.prune(nowMs);
    const length = this.sorted.length;
    if (!(length >= minimumSamples)) return null;
    if (!length) return { center: 0, deviation: 0 };
    const index = .5 * (length - 1), lower = Math.floor(index), upper = Math.ceil(index);
    const lo = this.sorted[lower]!, hi = this.sorted[upper]!;
    // Keep quantile's operation order, including its even-length interpolation.
    const center = lo + (hi - lo) * (index - lower);
    return { center, deviation: this.absoluteDeviationMedian(center) };
  }

  private lowerBound(value: number): number {
    let lo = 0, hi = this.sorted.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (this.sorted[middle]! < value) lo = middle + 1; else hi = middle;
    }
    return lo;
  }
  private remove(value: number): void { this.sorted.splice(this.lowerBound(value), 1); }
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs, before = this.head;
    while (this.head < this.values.length && this.values[this.head]!.t < cutoff) this.head += 1;
    const removed = this.head - before;
    if (!removed) return;
    if (removed === this.sorted.length) { this.sorted.length = 0; return; }
    if (removed <= 32) {
      for (let i = before; i < this.head; i++) this.remove(this.values[i]!.value);
      return;
    }
    // A large time gap can expire most of the window at once. Compact the
    // ordered index in one pass instead of repeatedly shifting its suffix.
    const counts = new Map<number, number>();
    for (let i = before; i < this.head; i++) {
      const value = this.values[i]!.value; counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let kept = 0;
    for (const value of this.sorted) {
      const count = counts.get(value) ?? 0;
      if (count) counts.set(value, count - 1); else this.sorted[kept++] = value;
    }
    this.sorted.length = kept;
  }

  private absoluteDeviationMedian(center: number): number {
    const length = this.sorted.length, split = Math.ceil(length / 2), rightLength = length - split;
    // Distances from the center increase moving left through the lower half
    // and right through the upper half. Their union is the original MAD input;
    // binary partition selects its middle values without allocating or sorting.
    const left = (i: number) => Math.abs(this.sorted[split - 1 - i]! - center);
    const right = (i: number) => Math.abs(this.sorted[split + i]! - center);
    const count = Math.ceil(length / 2);
    let lo = Math.max(0, count - rightLength), hi = Math.min(count, split);
    while (lo <= hi) {
      const a = (lo + hi) >>> 1, b = count - a;
      const leftBefore = a ? left(a - 1) : -Infinity, leftAfter = a < split ? left(a) : Infinity;
      const rightBefore = b ? right(b - 1) : -Infinity, rightAfter = b < rightLength ? right(b) : Infinity;
      if (leftBefore > rightAfter) { hi = a - 1; continue; }
      if (rightBefore > leftAfter) { lo = a + 1; continue; }
      const lower = Math.max(leftBefore, rightBefore);
      const upper = length % 2 ? lower : Math.min(leftAfter, rightAfter);
      return lower + (upper - lower) * (length % 2 ? 0 : .5);
    }
    throw new Error("INVALID_ORDERED_AGE_WINDOW");
  }
}

export class RobustAgeGate {
  private readonly ages: OrderedAgeWindow;
  public constructor(
    private readonly absoluteMs: number,
    windowMs: number,
    private readonly madMultiplier = 6,
    private readonly minimumSamples = 20,
    private readonly maximumFutureSkewMs = 0,
  ) { this.ages = new OrderedAgeWindow(windowMs); }

  public observe(ageMs: number, nowMs: number): {
    stale: boolean;
    reason: Extract<FeatureStaleReason, "FUTURE_CLOCK_SKEW" | "PROVIDER_TOO_OLD" | "INVALID_PROVIDER_AGE"> | null;
    thresholdMs: number;
    adjustedAgeMs: number;
  } {
    const statistics = this.ages.statistics(nowMs, this.minimumSamples);
    const robust = statistics
      ? statistics.center + this.madMultiplier * Math.max(statistics.deviation, 0.01)
      : this.absoluteMs;
    const thresholdMs = Math.max(this.absoluteMs, robust);
    const adjustedAgeMs = Number.isFinite(ageMs) && ageMs >= -this.maximumFutureSkewMs ? Math.max(0, ageMs) : ageMs;
    const reason = !Number.isFinite(adjustedAgeMs) ? "INVALID_PROVIDER_AGE"
      : adjustedAgeMs < 0 ? "FUTURE_CLOCK_SKEW"
        : adjustedAgeMs > thresholdMs ? "PROVIDER_TOO_OLD" : null;
    const stale = reason !== null;
    if (!stale) this.ages.add(adjustedAgeMs, nowMs);
    return { stale, reason, thresholdMs, adjustedAgeMs };
  }
}

export class LatencyHistogram {
  private readonly samples: RollingWindow;
  public constructor(windowMs = 3_600_000) { this.samples = new RollingWindow(windowMs, 100_000); }
  public record(milliseconds: number, nowMs: number): void {
    if (Number.isFinite(milliseconds) && Number.isFinite(nowMs) && milliseconds >= 0) this.samples.add(milliseconds, nowMs);
  }
  public summary(nowMs: number): Record<"count" | "p50" | "p90" | "p95" | "p99" | "max", number> {
    const values = this.samples.snapshot(nowMs);
    return { count: values.length, p50: quantile(values, .5), p90: quantile(values, .9), p95: quantile(values, .95),
      p99: quantile(values, .99), max: values.length ? Math.max(...values) : 0 };
  }
}
