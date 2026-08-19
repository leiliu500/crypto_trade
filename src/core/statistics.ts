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

export class RobustAgeGate {
  private readonly ages: RollingWindow;
  public constructor(
    private readonly absoluteMs: number,
    windowMs: number,
    private readonly madMultiplier = 6,
    private readonly minimumSamples = 20,
    private readonly maximumFutureSkewMs = 0,
  ) { this.ages = new RollingWindow(windowMs, 4096); }

  public observe(ageMs: number, nowMs: number): {
    stale: boolean;
    reason: Extract<FeatureStaleReason, "FUTURE_CLOCK_SKEW" | "PROVIDER_TOO_OLD" | "INVALID_PROVIDER_AGE"> | null;
    thresholdMs: number;
    adjustedAgeMs: number;
  } {
    const values = this.ages.snapshot(nowMs);
    const robust = values.length >= this.minimumSamples
      ? median(values) + this.madMultiplier * Math.max(mad(values), 0.01)
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
  public record(milliseconds: number, nowMs: number): void { if (milliseconds >= 0) this.samples.add(milliseconds, nowMs); }
  public summary(nowMs: number): Record<"p50" | "p90" | "p95" | "p99" | "max", number> {
    const values = this.samples.snapshot(nowMs);
    return { p50: quantile(values, .5), p90: quantile(values, .9), p95: quantile(values, .95), p99: quantile(values, .99), max: values.length ? Math.max(...values) : 0 };
  }
}
