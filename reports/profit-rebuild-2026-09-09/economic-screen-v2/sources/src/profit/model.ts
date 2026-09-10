import { createHash } from "node:crypto";
import { PROFIT_SPEC as S } from "./spec.js";

const DAY = S.dayMs, HOUR = S.hourMs, WEEK = S.weekMs, DELAY = S.candleFinalizationDelayMs;
const SYMBOLS = S.symbols;
export type ProfitSymbol = typeof SYMBOLS[number];
type Vector = readonly [number, number, number];
export interface ProfitBar {
  symbol: string; openMs: number; open: number; high: number; low: number; close: number; volume: number;
}
/** closeMs is the end of a fully completed UTC day. Historical availability is
 * assumed at that timestamp; it is not evidence of actual client receipt. */
export interface ProfitDailyClose { symbol: ProfitSymbol; closeMs: number; close: number }
export interface ProfitModelFit {
  version: string; id: string; fitAtMs: number; validUntilMs: number;
  nWeeks: number; nRows: number; excludedWeeks: number;
  firstOriginMs: number; lastOriginMs: number; maximumLabelEndMs: number; maximumLabelAvailableAtMs: number;
  inputSha256: string; specSha256: string;
  coefficients: Vector; bootstrapCoefficients: readonly Vector[];
  bootstrapBlockWeeks: number; bootstrapReplicates: number;
}
export interface ProfitForecast {
  version: string; id: string; modelId: string; symbol: ProfitSymbol;
  decisionMs: number; availableAtMs: number; expiresAtMs: number; horizonEndMs: number; fitAtMs: number;
  close: number; sigmaDay: number; sigmaHorizon: number; features: Vector;
  meanGrossBps: number; lowerGrossBps: number; upperGrossBps: number;
  nWeeks: number; inputSha256: string; modelInputSha256: string; specSha256: string;
  maximumLabelEndMs: number; maximumLabelAvailableAtMs: number;
  intervalInterpretation: "MOVING_WEEK_BLOCK_BOOTSTRAP_CONDITIONAL_MEAN_NOT_PREDICTIVE_INTERVAL";
  winProbability: null;
}
interface Features { x: Vector; sigmaDay: number; close: number; used: ProfitDailyClose[] }
interface TrainingRow { x: Vector; y: number }
interface Cluster { originMs: number; rows: readonly TrainingRow[]; used: ProfitDailyClose[] }
type Index = Map<ProfitSymbol, Map<number, ProfitDailyClose>>;
const finitePositive = (x: number) => Number.isFinite(x) && x > 0;
const validTime = (x: number) => Number.isSafeInteger(x) && x >= 0;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (x: number) => Math.max(-S.featureClip, Math.min(S.featureClip, x));
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const isMonday = (ms: number) => ms % DAY === 0 && new Date(ms).getUTCDay() === 1;
const firstOfMonth = (ms: number) => {
  const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/** Canonicalizes only completed admitted bars. Missing/duplicate hours never
 * become synthetic closes; incomplete days are omitted and later fail support. */
export function buildProfitDailyCloses(bars: readonly ProfitBar[], asOfMs: number): ProfitDailyClose[] {
  if (!Array.isArray(bars) || !validTime(asOfMs)) throw new Error("PROFIT_MODEL_INVALID_ARGUMENT");
  const dayEnd = Math.floor((asOfMs - DELAY) / DAY) * DAY;
  const buckets = new Map<string, { symbol: ProfitSymbol; closeMs: number; hours: Set<number>; close?: number }>();
  for (const b of bars) {
    if (!SYMBOLS.includes(b.symbol as ProfitSymbol) || b.openMs + HOUR > dayEnd) continue;
    if (!validTime(b.openMs) || b.openMs % HOUR !== 0 || ![b.open, b.high, b.low, b.close].every(finitePositive)
      || !Number.isFinite(b.volume) || b.volume < 0 || b.low > Math.min(b.open, b.close)
      || b.high < Math.max(b.open, b.close) || b.low > b.high) throw new Error("PROFIT_MODEL_INVALID_BAR");
    const closeMs = Math.floor(b.openMs / DAY) * DAY + DAY, key = `${b.symbol}:${closeMs}`;
    const bucket = buckets.get(key) ?? { symbol: b.symbol as ProfitSymbol, closeMs, hours: new Set<number>() };
    if (bucket.hours.has(b.openMs)) throw new Error("PROFIT_MODEL_DUPLICATE_BAR");
    bucket.hours.add(b.openMs);
    if (b.openMs + HOUR === closeMs) bucket.close = b.close;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].filter(b => b.hours.size === 24 && b.close !== undefined)
    .map(b => ({ symbol: b.symbol, closeMs: b.closeMs, close: b.close! }))
    .sort((a, b) => a.closeMs - b.closeMs || a.symbol.localeCompare(b.symbol));
}

function indexCloses(closes: readonly ProfitDailyClose[], fromMs: number, throughMs: number): Index {
  if (!Array.isArray(closes)) throw new Error("PROFIT_MODEL_INVALID_CLOSES");
  const index: Index = new Map(SYMBOLS.map(s => [s, new Map<number, ProfitDailyClose>()]));
  for (const c of closes) {
    if (c.closeMs < fromMs || c.closeMs > throughMs) continue;
    if (!SYMBOLS.includes(c.symbol) || !validTime(c.closeMs) || c.closeMs % DAY !== 0
      || !finitePositive(c.close)) throw new Error("PROFIT_MODEL_INVALID_CLOSE");
    const own = index.get(c.symbol)!;
    if (own.has(c.closeMs)) throw new Error("PROFIT_MODEL_DUPLICATE_CLOSE");
    own.set(c.closeMs, { symbol: c.symbol, closeMs: c.closeMs, close: c.close });
  }
  return index;
}

function features(index: Index, symbol: ProfitSymbol, atMs: number): Features | null {
  const own = index.get(symbol)!, used: ProfitDailyClose[] = [];
  for (let lag = S.slowLookbackDays; lag >= 0; lag--) {
    const c = own.get(atMs - lag * DAY); if (!c) return null; used.push(c);
  }
  const returns: number[] = [];
  for (let i = used.length - S.volatilityLookbackDays; i < used.length; i++) {
    const r = Math.log(used[i]!.close) - Math.log(used[i - 1]!.close);
    if (!Number.isFinite(r)) return null; returns.push(r);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const sigmaDay = Math.max(S.minimumDailyVolatility, Math.sqrt(variance)), close = used.at(-1)!.close;
  const x: Vector = [1,
    clip((Math.log(close) - Math.log(used.at(-S.fastLookbackDays - 1)!.close)) / (sigmaDay * Math.sqrt(S.fastLookbackDays))),
    clip((Math.log(close) - Math.log(used[0]!.close)) / (sigmaDay * Math.sqrt(S.slowLookbackDays)))];
  return Number.isFinite(sigmaDay) && x.every(Number.isFinite) ? { x, sigmaDay, close, used } : null;
}

/** Fixed objective sum((y-X beta)^2) + 10*sum(beta^2), including intercept. */
function ridge(rows: readonly TrainingRow[]): Vector {
  const matrix = Array.from({ length: 3 }, (_, i) => Array.from({ length: 4 }, (_, j) => j === i ? S.ridgeLambda : 0));
  for (const { x, y } of rows) for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) matrix[i]![j]! += x[i]! * x[j]!;
    matrix[i]![3]! += x[i]! * y;
  }
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(matrix[i]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = i;
    [matrix[pivot], matrix[col]] = [matrix[col]!, matrix[pivot]!];
    const divisor = matrix[col]![col]!;
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) throw new Error("PROFIT_MODEL_SINGULAR_FIT");
    for (let j = col; j <= 3; j++) matrix[col]![j]! /= divisor;
    for (let i = 0; i < 3; i++) if (i !== col) {
      const factor = matrix[i]![col]!;
      for (let j = col; j <= 3; j++) matrix[i]![j]! -= factor * matrix[col]![j]!;
    }
  }
  const result = [matrix[0]![3]!, matrix[1]![3]!, matrix[2]![3]!] as const;
  if (!result.every(Number.isFinite)) throw new Error("PROFIT_MODEL_NONFINITE_FIT");
  return Object.freeze(result);
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4_294_967_296; };
}

/** Fits only on Monday paired origins in the previous 365 calendar days.
 * Labels use simple forward return and require a full seven-day path plus one
 * extra publication day. Incomplete clusters are excluded, not zero-filled.
 * Bootstrap blocks comprise four consecutive calendar weeks and paired assets. */
export function fitProfitModel(closes: readonly ProfitDailyClose[], fitAtMs: number): ProfitModelFit | null {
  if (!validTime(fitAtMs) || fitAtMs !== firstOfMonth(fitAtMs) + DELAY) throw new Error("PROFIT_MODEL_INVALID_FIT_TIME");
  const fitCloseMs = fitAtMs - DELAY, earliest = fitCloseMs - S.trainingLookbackDays * DAY;
  const index = indexCloses(closes, earliest - S.slowLookbackDays * DAY, fitCloseMs - S.labelPublicationLagDays * DAY);
  const clusters: Cluster[] = []; let excludedWeeks = 0;
  for (let origin = earliest; origin + (S.forecastHorizonDays + S.labelPublicationLagDays) * DAY <= fitCloseMs; origin += DAY) {
    if (!isMonday(origin)) continue;
    const rows: TrainingRow[] = [], used: ProfitDailyClose[] = [];
    for (const symbol of SYMBOLS) {
      const f = features(index, symbol, origin); if (!f) break;
      const forward: ProfitDailyClose[] = [];
      for (let d = 1; d <= S.forecastHorizonDays; d++) {
        const c = index.get(symbol)!.get(origin + d * DAY); if (!c) break; forward.push(c);
      }
      if (forward.length !== S.forecastHorizonDays) break;
      const y = (forward.at(-1)!.close / f.close - 1) / (f.sigmaDay * Math.sqrt(S.forecastHorizonDays));
      if (!Number.isFinite(y)) break;
      rows.push({ x: f.x, y }); used.push(...f.used, ...forward);
    }
    if (rows.length === 2) clusters.push({ originMs: origin + DELAY, rows, used }); else excludedWeeks++;
  }
  if (clusters.length < S.minimumTrainingWeeks) return null;
  const blockStarts = clusters.flatMap((c, i) => i + S.bootstrapBlockWeeks - 1 < clusters.length
    && clusters[i + S.bootstrapBlockWeeks - 1]!.originMs === c.originMs + (S.bootstrapBlockWeeks - 1) * WEEK ? [i] : []);
  if (blockStarts.length === 0) return null;
  const coefficients = ridge(clusters.flatMap(c => c.rows));
  const random = rng(S.bootstrapSeed), bootstrapCoefficients: Vector[] = [];
  for (let repetition = 0; repetition < S.bootstrapRepetitions; repetition++) {
    const sample: Cluster[] = [];
    while (sample.length < clusters.length) {
      const start = blockStarts[Math.floor(random() * blockStarts.length)]!;
      for (let offset = 0; offset < S.bootstrapBlockWeeks && sample.length < clusters.length; offset++) sample.push(clusters[start + offset]!);
    }
    bootstrapCoefficients.push(ridge(sample.flatMap(c => c.rows)));
  }
  const inputs = [...new Map(clusters.flatMap(c => c.used).map(c => [`${c.symbol}:${c.closeMs}`, c])).values()]
    .sort((a, b) => a.closeMs - b.closeMs || a.symbol.localeCompare(b.symbol));
  const d = new Date(fitAtMs), specSha256 = hash(S), inputSha256 = hash({ inputs, origins: clusters.map(c => c.originMs) });
  const result = { version: S.version, fitAtMs, validUntilMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + DELAY,
    nWeeks: clusters.length, nRows: 2 * clusters.length, excludedWeeks,
    firstOriginMs: clusters[0]!.originMs, lastOriginMs: clusters.at(-1)!.originMs,
    maximumLabelEndMs: clusters.at(-1)!.originMs - DELAY + S.forecastHorizonDays * DAY,
    maximumLabelAvailableAtMs: clusters.at(-1)!.originMs + (S.forecastHorizonDays + S.labelPublicationLagDays) * DAY,
    inputSha256, specSha256, coefficients, bootstrapCoefficients: Object.freeze(bootstrapCoefficients),
    bootstrapBlockWeeks: S.bootstrapBlockWeeks, bootstrapReplicates: S.bootstrapRepetitions };
  return Object.freeze({ ...result, id: hash(result) });
}

function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p, lower = Math.floor(at), weight = at - lower;
  return sorted[lower]! * (1 - weight) + sorted[Math.ceil(at)]! * weight;
}

/** Interval estimates conditional mean uncertainty only. It is not a return
 * quantile, win probability, trade approval, or proof of profitable expectancy. */
export function forecastProfitModel(fit: ProfitModelFit | null, closes: readonly ProfitDailyClose[],
  decisionMs: number): ProfitForecast[] | null {
  if (!validTime(decisionMs) || !isMonday(decisionMs - DELAY)) throw new Error("PROFIT_MODEL_INVALID_DECISION_TIME");
  if (!fit || fit.version !== S.version || fit.specSha256 !== hash(S) || fit.fitAtMs > decisionMs
    || fit.validUntilMs <= decisionMs || fit.maximumLabelAvailableAtMs > fit.fitAtMs || fit.nWeeks < S.minimumTrainingWeeks
    || fit.coefficients.length !== 3 || !fit.coefficients.every(Number.isFinite)
    || fit.bootstrapCoefficients.length !== S.bootstrapRepetitions || fit.bootstrapCoefficients.some(x => x.length !== 3 || !x.every(Number.isFinite))) return null;
  const index = indexCloses(closes, decisionMs - DELAY - S.slowLookbackDays * DAY, decisionMs - DELAY), forecasts: ProfitForecast[] = [];
  for (const symbol of SYMBOLS) {
    const f = features(index, symbol, decisionMs - DELAY); if (!f) return null;
    const scale = f.sigmaDay * Math.sqrt(S.forecastHorizonDays) * 10_000;
    const distribution = fit.bootstrapCoefficients.map(beta => dot(beta, f.x) * scale).sort((a, b) => a - b);
    const meanGrossBps = dot(fit.coefficients, f.x) * scale;
    const lowerGrossBps = quantile(distribution, S.lowerQuantile), upperGrossBps = quantile(distribution, S.upperQuantile);
    if (![meanGrossBps, lowerGrossBps, upperGrossBps].every(Number.isFinite)) return null;
    const inputSha256 = hash(f.used), id = hash({ version: S.version, modelId: fit.id, symbol, decisionMs, inputSha256 });
    forecasts.push({ version: S.version, id, modelId: fit.id, symbol, decisionMs, availableAtMs: decisionMs,
      expiresAtMs: decisionMs + S.maximumSignalAgeMs,
      horizonEndMs: decisionMs + WEEK, fitAtMs: fit.fitAtMs, close: f.close, sigmaDay: f.sigmaDay,
      sigmaHorizon: f.sigmaDay * Math.sqrt(S.forecastHorizonDays), features: f.x,
      meanGrossBps, lowerGrossBps, upperGrossBps, nWeeks: fit.nWeeks, inputSha256,
      modelInputSha256: fit.inputSha256, specSha256: fit.specSha256,
      maximumLabelEndMs: fit.maximumLabelEndMs, maximumLabelAvailableAtMs: fit.maximumLabelAvailableAtMs,
      intervalInterpretation: "MOVING_WEEK_BLOCK_BOOTSTRAP_CONDITIONAL_MEAN_NOT_PREDICTIVE_INTERVAL", winProbability: null });
  }
  return forecasts;
}
