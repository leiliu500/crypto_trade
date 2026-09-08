import { createHash } from "node:crypto";
import type { HourlyBar } from "./hourly-data.js";

export type HourlySymbol = HourlyBar["symbol"];
export type HourlyHorizonHours = 4 | 24;
export type HourlyModelKind = "trend" | "recovery";
export interface HourlyCandidate { readonly id: string; readonly kind: HourlyModelKind; readonly horizonHours: HourlyHorizonHours }
const HOUR = 3_600_000, LOOKBACK = 168;
const SYMBOLS: readonly HourlySymbol[] = ["BTC/USD", "ETH/USD"];
const BASE_FEATURES = Object.freeze([
  "log_return_4h_over_hourly_realized_vol_sqrt4", "log_return_24h_over_hourly_realized_vol_sqrt24",
  "log_return_168h_over_hourly_realized_vol_sqrt168", "own_minus_peer_log_return_24h_over_combined_vol_sqrt24",
]);
const RECOVERY_FEATURES = Object.freeze([
  "sign(trend168)*max(0,-sign(trend168)*trend24)",
  "sign(trend24)*max(0,sign(trend24)*trend4)",
]);
export const HOURLY_MODEL_SPEC = Object.freeze({
  version: "btc-eth-hourly-trend-recovery-ridge-v1", ridgePenalty: 16, featureStandardDeviationFloor: .1,
  baseFeatures: BASE_FEATURES, recoveryInteractions: RECOVERY_FEATURES,
  volatility: "RMS_OF_168_COMPLETED_HOURLY_LOG_RETURNS" as const,
  relativeVolatility: "HYPOT_OWN_PEER_HOURLY_VOLATILITY_TIMES_SQRT24" as const,
  constantPriceHistory: "ZERO_NORMALIZED_RETURN" as const,
  signal: "CLOSE_OF_SYNCHRONIZED_COMPLETED_HOURLY_BARS" as const,
  entryDelayHours: 1, label: "SIMPLE_GROSS_BPS_FROM_ENTRY_OPEN_TO_HORIZON_EXIT_OPEN" as const,
  entryAndExitRequirePositiveVolume: true, exitBarMustCloseStrictlyBeforeCutoff: true, labelRequiresContinuousOwnBars: true,
  latestLabelStrictlyBeforeCutoff: true, interceptPenalized: false,
});
export const HOURLY_CANDIDATES: readonly HourlyCandidate[] = Object.freeze(([4, 24] as const).flatMap(horizonHours =>
  (["trend", "recovery"] as const).map(kind => Object.freeze({ id: `${kind}-${horizonHours}h`, kind, horizonHours }))));

export interface HourlyFeaturePoint { readonly symbol: HourlySymbol; readonly decisionMs: number; readonly features: readonly number[] }
export interface HourlyTrainingRow extends HourlyFeaturePoint {
  readonly entryMs: number; readonly exitMs: number; readonly completedAtMs: number;
  readonly horizonHours: HourlyHorizonHours; readonly grossBps: number;
}
interface OwnFeatures { returns: number[]; volatility: number }
interface IndexedBar { bar: Readonly<HourlyBar>; index: number }
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validHour = (value: number) => validTime(value) && value % HOUR === 0;
const validSymbol = (value: string): value is HourlySymbol => (SYMBOLS as readonly string[]).includes(value);
const validFeatures = (value: readonly number[]) => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const validHorizon = (value: number): value is HourlyHorizonHours => value === 4 || value === 24;
const normalized = (value: number, denominator: number) => denominator > 0 ? value / denominator : 0;

/** Build once and reuse for every candidate and forecast. Only fixed trailing
 * windows enter features; no population statistics are fitted here. Each
 * feature requires 169 consecutive completed closes from both assets. */
export class HourlyDataset {
  public readonly points: readonly HourlyFeaturePoint[];
  private readonly featureIndex = new Map<string, HourlyFeaturePoint>();
  private readonly barIndex = new Map<HourlySymbol, Map<number, IndexedBar>>();

  constructor(bars: readonly HourlyBar[]) {
    if (!Array.isArray(bars)) throw new Error("HOURLY_INVALID_BARS");
    const grouped = new Map<HourlySymbol, HourlyBar[]>(SYMBOLS.map(symbol => [symbol, []]));
    for (const bar of bars) {
      if (!bar || !validSymbol(bar.symbol) || !validHour(bar.openMs)
        || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
        || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close)
        || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) throw new Error("HOURLY_INVALID_BAR");
      grouped.get(bar.symbol)!.push({ symbol: bar.symbol, openMs: bar.openMs,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    }
    const own = new Map<HourlySymbol, Map<number, OwnFeatures>>();
    for (const symbol of SYMBOLS) {
      const sorted = grouped.get(symbol)!.sort((a, b) => a.openMs - b.openMs);
      const index = new Map<number, IndexedBar>(), values = new Map<number, OwnFeatures>();
      const logs = sorted.map(bar => Math.log(bar.close));
      let continuous = 0;
      for (let i = 0; i < sorted.length; i++) {
        const bar = sorted[i]!;
        if (index.has(bar.openMs)) throw new Error("HOURLY_DUPLICATE_BAR");
        index.set(bar.openMs, { bar: Object.freeze(bar), index: i });
        continuous = i > 0 && bar.openMs - sorted[i - 1]!.openMs === HOUR ? continuous + 1 : 1;
        if (continuous < LOOKBACK + 1) continue;
        // The fixed 168-term sum avoids cumulative numerical residue from data
        // outside the declared lookback (including a past volatility spike).
        let squared = 0;
        for (let j = i - LOOKBACK + 1; j <= i; j++) squared += (logs[j]! - logs[j - 1]!) ** 2;
        values.set(bar.openMs + HOUR, { returns: [4, 24, 168].map(lag => logs[i]! - logs[i - lag]!),
          volatility: Math.sqrt(squared / LOOKBACK) });
      }
      this.barIndex.set(symbol, index); own.set(symbol, values);
    }
    const points: HourlyFeaturePoint[] = [];
    for (const symbol of SYMBOLS) {
      const peer = symbol === "BTC/USD" ? "ETH/USD" : "BTC/USD";
      for (const [decisionMs, value] of own.get(symbol)!) {
        const other = own.get(peer)!.get(decisionMs); if (!other) continue;
        const features = value.returns.map((ret, i) => normalized(ret, value.volatility * Math.sqrt([4, 24, 168][i]!)));
        features.push(normalized(value.returns[1]! - other.returns[1]!, Math.hypot(value.volatility, other.volatility) * Math.sqrt(24)));
        if (!features.every(Number.isFinite)) throw new Error("HOURLY_NONFINITE_FEATURES");
        const point = Object.freeze({ symbol, decisionMs, features: Object.freeze(features) });
        this.featureIndex.set(`${symbol}:${decisionMs}`, point); points.push(point);
      }
    }
    this.points = Object.freeze(points.sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol)));
  }

  public features(symbol: HourlySymbol, decisionMs: number): number[] | null {
    if (!validSymbol(symbol) || !validHour(decisionMs)) return null;
    const point = this.featureIndex.get(`${symbol}:${decisionMs}`); return point ? [...point.features] : null;
  }

  public trainingRows(horizonHours: HourlyHorizonHours, fromMs: number, toMs: number): HourlyTrainingRow[] {
    if (!validHorizon(horizonHours) || !validTime(fromMs) || !validTime(toMs) || fromMs >= toMs)
      throw new Error("HOURLY_INVALID_TRAINING_RANGE");
    const result: HourlyTrainingRow[] = [];
    for (const point of this.points) {
      if (point.decisionMs < fromMs || point.decisionMs >= toMs) continue;
      const entryMs = point.decisionMs + HOUR, exitMs = entryMs + horizonHours * HOUR;
      const completedAtMs = exitMs + HOUR;
      // Final endpoint volume is known only after the exit candle closes.
      if (!validTime(completedAtMs) || completedAtMs >= toMs) continue;
      const index = this.barIndex.get(point.symbol)!, entry = index.get(entryMs), exit = index.get(exitMs);
      if (!entry || !exit || entry.bar.volume <= 0 || exit.bar.volume <= 0
        || exit.index - entry.index !== horizonHours) continue;
      const grossBps = (exit.bar.open / entry.bar.open - 1) * 10_000;
      if (!Number.isFinite(grossBps)) throw new Error("HOURLY_NONFINITE_LABEL");
      result.push({ symbol: point.symbol, decisionMs: point.decisionMs, features: [...point.features],
        entryMs, exitMs, completedAtMs, horizonHours, grossBps });
    }
    return result;
  }
}

export function buildHourlyDataset(bars: readonly HourlyBar[]): HourlyDataset { return new HourlyDataset(bars); }
type HourlyDataInput = HourlyDataset | readonly HourlyBar[];
const dataset = (input: HourlyDataInput) => input instanceof HourlyDataset ? input : buildHourlyDataset(input);
/** Use a prebuilt HourlyDataset for repeated lookups, rather than reparsing bars. */
export function buildHourlyFeatures(input: HourlyDataInput, symbol: HourlySymbol, decisionMs: number): number[] | null {
  return dataset(input).features(symbol, decisionMs);
}
export function buildHourlyTrainingRows(input: HourlyDataInput, horizonHours: HourlyHorizonHours,
  fromMs: number, toMs: number): HourlyTrainingRow[] {
  return dataset(input).trainingRows(horizonHours, fromMs, toMs);
}

/** The first interaction represents a pullback against the 168h trend. The
 * second represents 4h persistence in the 24h direction; learned coefficients
 * determine whether that confirmation or its absence predicts a recovery. */
export function hourlyCandidateFeatures(base: readonly number[], kind: HourlyModelKind): number[] {
  if (!validFeatures(base) || (kind !== "trend" && kind !== "recovery")) throw new Error("HOURLY_INVALID_MODEL_FEATURES");
  const values = [...base];
  if (kind === "recovery") {
    const longSign = Math.sign(base[2]!), mediumSign = Math.sign(base[1]!);
    values.push(longSign * Math.max(0, -longSign * base[1]!), mediumSign * Math.max(0, mediumSign * base[0]!));
  }
  return values;
}

export interface HourlyAssetFit {
  symbol: HourlySymbol; samples: number; firstDecisionMs: number | null; lastDecisionMs: number | null;
  latestCompletedMs: number | null; intercept: number | null; targetMeanGrossBps: number | null;
  targetStdGrossBps: number | null; centers: number[]; scales: number[]; coefficients: number[];
  trainingRowsSha256: string; reason: "READY" | "NO_TRAINING_ROWS";
}
function solve(matrix: number[][], target: number[]): number[] {
  const size = target.length, lower = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let i = 0; i < size; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
    if (!Number.isFinite(value) || i === j && value <= 0) throw new Error("HOURLY_NONFINITE_RIDGE_FIT");
    lower[i]![j] = i === j ? Math.sqrt(value) : value / lower[j]![j]!;
  }
  const intermediate = Array<number>(size).fill(0), result = Array<number>(size).fill(0);
  for (let i = 0; i < size; i++) {
    let value = target[i]!;
    for (let j = 0; j < i; j++) value -= lower[i]![j]! * intermediate[j]!;
    intermediate[i] = value / lower[i]![i]!;
  }
  for (let i = size - 1; i >= 0; i--) {
    let value = intermediate[i]!;
    for (let j = i + 1; j < size; j++) value -= lower[j]![i]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  if (!result.every(Number.isFinite)) throw new Error("HOURLY_NONFINITE_RIDGE_FIT");
  return result;
}

/** A fitted object is immutable: prediction never observes labels or updates
 * normalization. Costs and portfolio selection belong to the separate simulator. */
export class HourlyRidgeModel {
  public readonly candidate: Readonly<HourlyCandidate>;
  private readonly fits = new Map<HourlySymbol, HourlyAssetFit>();

  constructor(candidate: HourlyCandidate, rows: readonly HourlyTrainingRow[], private readonly cutoffMs: number) {
    const fixed = HOURLY_CANDIDATES.find(value => value.id === candidate?.id && value.kind === candidate.kind
      && value.horizonHours === candidate.horizonHours);
    if (!fixed || !validTime(cutoffMs) || !Array.isArray(rows)) throw new Error("HOURLY_INVALID_FIT_INPUT");
    this.candidate = fixed;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || !validSymbol(row.symbol) || !validHour(row.decisionMs) || !validHour(row.entryMs)
        || !validHour(row.exitMs) || row.entryMs !== row.decisionMs + HOUR
        || row.exitMs !== row.entryMs + fixed.horizonHours * HOUR || !validHour(row.completedAtMs)
        || row.completedAtMs !== row.exitMs + HOUR || row.completedAtMs >= cutoffMs || row.horizonHours !== fixed.horizonHours
        || !validFeatures(row.features) || !Number.isFinite(row.grossBps)) throw new Error("HOURLY_INVALID_OR_FUTURE_TRAINING_ROW");
      const key = `${row.symbol}:${row.decisionMs}`;
      if (seen.has(key)) throw new Error("HOURLY_DUPLICATE_TRAINING_ROW"); seen.add(key);
    }
    for (const symbol of SYMBOLS) {
      const own = rows.filter(row => row.symbol === symbol).sort((a, b) => a.decisionMs - b.decisionMs);
      this.fits.set(symbol, this.fit(symbol, own));
    }
  }

  private fit(symbol: HourlySymbol, rows: readonly HourlyTrainingRow[]): HourlyAssetFit {
    const trainingRowsSha256 = createHash("sha256").update(JSON.stringify(rows.map(row => ({ symbol: row.symbol,
      decisionMs: row.decisionMs, entryMs: row.entryMs, exitMs: row.exitMs, horizonHours: row.horizonHours,
      features: row.features, grossBps: row.grossBps })))).digest("hex");
    if (!rows.length) return { symbol, samples: 0, firstDecisionMs: null, lastDecisionMs: null,
      latestCompletedMs: null, intercept: null, targetMeanGrossBps: null, targetStdGrossBps: null,
      centers: [], scales: [], coefficients: [], trainingRowsSha256, reason: "NO_TRAINING_ROWS" };
    const inputs = rows.map(row => hourlyCandidateFeatures(row.features, this.candidate.kind));
    const count = rows.length, dimension = inputs[0]!.length;
    const intercept = rows.reduce((sum, row) => sum + row.grossBps, 0) / count;
    const targetStdGrossBps = Math.sqrt(rows.reduce((sum, row) => sum + (row.grossBps - intercept) ** 2, 0) / count);
    const centers = Array.from({ length: dimension }, (_, j) => inputs.reduce((sum, values) => sum + values[j]!, 0) / count);
    const scales = centers.map((center, j) => Math.max(HOURLY_MODEL_SPEC.featureStandardDeviationFloor,
      Math.sqrt(inputs.reduce((sum, values) => sum + (values[j]! - center) ** 2, 0) / count)));
    const matrix = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) =>
      i === j ? HOURLY_MODEL_SPEC.ridgePenalty : 0));
    const target = Array<number>(dimension).fill(0);
    inputs.forEach((values, row) => {
      const normalized = values.map((value, j) => (value - centers[j]!) / scales[j]!);
      for (let i = 0; i < dimension; i++) {
        target[i]! += normalized[i]! * (rows[row]!.grossBps - intercept);
        for (let j = 0; j <= i; j++) matrix[i]![j]! += normalized[i]! * normalized[j]!;
      }
    });
    for (let i = 0; i < dimension; i++) for (let j = 0; j < i; j++) matrix[j]![i] = matrix[i]![j]!;
    const coefficients = solve(matrix, target);
    if (![intercept, targetStdGrossBps, ...centers, ...scales].every(Number.isFinite)) throw new Error("HOURLY_NONFINITE_RIDGE_FIT");
    return { symbol, samples: count, firstDecisionMs: rows[0]!.decisionMs, lastDecisionMs: rows.at(-1)!.decisionMs,
      latestCompletedMs: rows.at(-1)!.completedAtMs, intercept, targetMeanGrossBps: intercept,
      targetStdGrossBps, centers, scales, coefficients, trainingRowsSha256, reason: "READY" };
  }

  public predict(symbol: HourlySymbol, baseFeatures: readonly number[], decisionMs: number): number | null {
    if (!validSymbol(symbol) || !validFeatures(baseFeatures) || !validHour(decisionMs) || decisionMs < this.cutoffMs) return null;
    const fit = this.fits.get(symbol); if (!fit || fit.reason !== "READY") return null;
    const values = hourlyCandidateFeatures(baseFeatures, this.candidate.kind);
    const result = fit.intercept! + fit.coefficients.reduce((sum, coefficient, j) =>
      sum + coefficient * (values[j]! - fit.centers[j]!) / fit.scales[j]!, 0);
    return Number.isFinite(result) ? result : null;
  }

  public diagnostics() {
    return structuredClone({ version: HOURLY_MODEL_SPEC.version, spec: HOURLY_MODEL_SPEC,
      candidate: this.candidate, cutoffMs: this.cutoffMs,
      featureNames: this.candidate.kind === "trend" ? [...BASE_FEATURES] : [...BASE_FEATURES, ...RECOVERY_FEATURES],
      fits: [...this.fits.values()] });
  }
}
