import { createHash } from "node:crypto";

export interface NetDistribution { location: number; scale: number; }
export const NET_CALIBRATION_SPEC = Object.freeze({
  version: "hourly-net-standardized-residual-calibration-v1", heldOutDays: 30, minimumSamples: 500,
  weighting: "UNWEIGHTED_LAST_30_DAYS_AFTER_COMMON_51_HOUR_PURGE",
  distribution: "LOCATION_PLUS_SCALE_TIMES_EMPIRICAL_HELD_OUT_STANDARDIZED_RESIDUAL",
  mean: "LOCATION_PLUS_SCALE_TIMES_MEAN_RESIDUAL", profitProbability: "STRICTLY_POSITIVE_NET_PAYOFF",
  lowerQuantile: .1, upperQuantile: .9, expectedShortfallFraction: .1,
  coverageClaim: "EMPIRICAL_PREDICTIVE_DIAGNOSTIC;_NO_EXCHANGEABILITY_OR_CONDITIONAL_COVERAGE_GUARANTEE",
});

/** One empirical distribution supplies its mean, probabilities, quantiles and
 * lower-tail expectation. Outcome risk is not confidence in an estimated mean. */
export class NetResidualCalibration {
  private readonly residuals: readonly number[];
  private readonly prefix: readonly number[];
  private readonly spread: number;
  public readonly residualMean: number;
  constructor(residuals: readonly number[]) {
    if (!Array.isArray(residuals) || !residuals.length || !residuals.every(Number.isFinite))
      throw new Error("NET_CALIBRATION_INVALID_RESIDUALS");
    this.residuals = Object.freeze([...residuals].sort((a, b) => a - b));
    const prefix = [0];
    for (const value of this.residuals) prefix.push(prefix.at(-1)! + value);
    this.prefix = Object.freeze(prefix);
    const n = this.residuals.length;
    this.residualMean = prefix[n]! / n;
    this.spread = this.residuals.reduce((sum, value, i) => sum + (2 * i - n + 1) * value, 0) / (n * n);
    if (![this.residualMean, this.spread, ...prefix].every(Number.isFinite)) throw new Error("NET_CALIBRATION_NONFINITE_SUM");
  }
  private check(prediction: NetDistribution) {
    if (!Number.isFinite(prediction.location) || !Number.isFinite(prediction.scale) || prediction.scale <= 0)
      throw new Error("NET_CALIBRATION_INVALID_DISTRIBUTION");
  }
  private upperBound(value: number) {
    let low = 0, high = this.residuals.length;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (this.residuals[mid]! <= value) low = mid + 1; else high = mid; }
    return low;
  }
  public predict(raw: NetDistribution) {
    this.check(raw);
    const n = this.residuals.length, mass = .1 * n, full = Math.floor(mass), fraction = mass - full;
    const tailMean = (this.prefix[full]! + (fraction > 0 ? fraction * this.residuals[full]! : 0)) / mass;
    const transform = (z: number) => raw.location + raw.scale * z;
    const result = { meanNetBps: transform(this.residualMean),
      probabilityNetPositive: 1 - this.upperBound(-raw.location / raw.scale) / n,
      lower10NetBps: transform(this.residuals[Math.ceil(.1 * n) - 1]!),
      upper90NetBps: transform(this.residuals[Math.ceil(.9 * n) - 1]!),
      lowerTailMean10NetBps: transform(tailMean) };
    if (!Object.values(result).every(Number.isFinite)) throw new Error("NET_CALIBRATION_NONFINITE_PREDICTION");
    return result;
  }
  /** Exact empirical CRPS in O(log n), including ties and discrete nofills. */
  public crps(raw: NetDistribution, actual: number) {
    this.check(raw);
    if (!Number.isFinite(actual)) throw new Error("NET_CALIBRATION_INVALID_ACTUAL");
    const z = (actual - raw.location) / raw.scale, n = this.residuals.length, i = this.upperBound(z);
    const absolute = (i * z - this.prefix[i]! + this.prefix[n]! - this.prefix[i]! - (n - i) * z) / n;
    const value = raw.scale * Math.max(0, absolute - this.spread);
    if (!Number.isFinite(value)) throw new Error("NET_CALIBRATION_NONFINITE_CRPS");
    return value;
  }
  public diagnostics() {
    return { spec: NET_CALIBRATION_SPEC, samples: this.residuals.length, residualMean: this.residualMean,
      sortedResidualsSha256: createHash("sha256").update(JSON.stringify(this.residuals)).digest("hex"),
      residuals: [...this.residuals] };
  }
}

export interface NetActionPrediction { base: ReturnType<NetResidualCalibration["predict"]>; stress: ReturnType<NetResidualCalibration["predict"]>; }
export function chooseNetAction(long: NetActionPrediction, short: NetActionPrediction) {
  const eligible = (p: NetActionPrediction) => [p.base, p.stress].every(d => Object.values(d).every(Number.isFinite)
    && d.probabilityNetPositive >= 0 && d.probabilityNetPositive <= 1)
    && p.base.meanNetBps > 5 && p.stress.meanNetBps > 0
    && p.base.probabilityNetPositive > .5 && p.stress.probabilityNetPositive > .5;
  const longEligible = eligible(long), shortEligible = eligible(short);
  if (longEligible && shortEligible) return { side: null, reason: "INCOHERENT_BOTH_DIRECTIONS_QUALIFY" } as const;
  if (!longEligible && !shortEligible) return { side: null, reason: "AFTER_COST_DISTRIBUTION_FAILED_ENTRY_SCREEN" } as const;
  return { side: longEligible ? 1 as const : -1 as const, reason: "QUALIFIED" } as const;
}
