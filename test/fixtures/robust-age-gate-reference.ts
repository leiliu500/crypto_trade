/** Frozen pre-optimization behavior. Deliberately retains its three full sorts
 * per warmed observation, FIFO timestamps, interpolation and compaction order.
 * This is a test/benchmark oracle, never used by the trading application. */
class ReferenceRollingWindow {
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
  public snapshot(nowMs: number): number[] { this.prune(nowMs); return this.values.slice(this.head).map(x => x.value); }
}
function referenceMedian(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), index = .5 * (sorted.length - 1);
  const lower = Math.floor(index), upper = Math.ceil(index), lo = sorted[lower]!, hi = sorted[upper]!;
  return lo + (hi - lo) * (index - lower);
}
function referenceMad(values: readonly number[]): number {
  if (!values.length) return 0;
  const center = referenceMedian(values);
  return referenceMedian(values.map(value => Math.abs(value - center)));
}
export class ReferenceRobustAgeGate {
  private readonly ages: ReferenceRollingWindow;
  public constructor(private readonly absoluteMs: number, windowMs: number, private readonly madMultiplier = 6,
    private readonly minimumSamples = 20, private readonly maximumFutureSkewMs = 0) {
    this.ages = new ReferenceRollingWindow(windowMs, 4096);
  }
  public observe(ageMs: number, nowMs: number) {
    const values = this.ages.snapshot(nowMs);
    const robust = values.length >= this.minimumSamples
      ? referenceMedian(values) + this.madMultiplier * Math.max(referenceMad(values), 0.01) : this.absoluteMs;
    const thresholdMs = Math.max(this.absoluteMs, robust);
    const adjustedAgeMs = Number.isFinite(ageMs) && ageMs >= -this.maximumFutureSkewMs ? Math.max(0, ageMs) : ageMs;
    const reason = !Number.isFinite(adjustedAgeMs) ? "INVALID_PROVIDER_AGE"
      : adjustedAgeMs < 0 ? "FUTURE_CLOCK_SKEW" : adjustedAgeMs > thresholdMs ? "PROVIDER_TOO_OLD" : null;
    const stale = reason !== null;
    if (!stale) this.ages.add(adjustedAgeMs, nowMs);
    return { stale, reason, thresholdMs, adjustedAgeMs };
  }
}
