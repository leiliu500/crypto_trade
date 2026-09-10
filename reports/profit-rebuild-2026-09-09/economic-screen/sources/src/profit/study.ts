import { createHash } from "node:crypto";
import type { HourlyDataset, FundingRow } from "../research/hourly-data.js";
import { buildProfitDailyCloses, fitProfitModel, forecastProfitModel,
  type ProfitBar, type ProfitForecast, type ProfitModelFit } from "./model.js";
import { PROFIT_SPEC as S } from "./spec.js";

export const PROFIT_STUDY_WINDOWS = Object.freeze([
  { id: "development-2024", startMs: Date.UTC(2024, 0, 1), endMs: Date.UTC(2025, 0, 1) },
  { id: "confirmation-2025-h1", startMs: Date.UTC(2025, 0, 1), endMs: Date.UTC(2025, 6, 1) },
]);
export const PROFIT_STUDY_DESIGN = Object.freeze({
  version: "weekly-inventory-chronological-study-v1",
  windows: PROFIT_STUDY_WINDOWS,
  historyStartMs: Date.UTC(2022, 11, 1),
  training: "MONTHLY_ROLLING_365_DAYS; PAIRED_7_DAY_LABELS_MATURE_PLUS_ONE_DAY",
  decision: "MONDAY_00_01_UTC; FIRST_NEXT_FULL_HOUR_BASE_OR_TWO_HOURS_STRESS",
  scenarios: ["base", "stress"] as const,
  fundingAssumptions: ["source-plus-hour", "source-as-end"] as const,
  benchmarkPolicies: ["risk-managed-long-btc", "risk-managed-long-eth"] as const,
  benchmarkInterpretation: "INDEPENDENT_ONE_SLOT_RISK_MANAGED_LONG_PATHS; MEAN_IS_A_BENCHMARK_MIXTURE_NOT_AN_EXECUTABLE_TWO_POSITION_PORTFOLIO",
  evidence: "REUSED_DEVELOPMENT_DATA; NOT_UNTOUCHED_HOLDOUT; PREVIOUS_FAILED_CANDIDATES_PRESERVED",
  reservedWindow: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 7, 1), evaluated: false },
  tuning: "ONE_FROZEN_CANDIDATE; NO_PARAMETER_SEARCH_OR_POST_RESULT_THRESHOLD_CHANGES",
  forecastMeaning: "CONDITIONAL_GROSS_MEAN_PARAMETER_UNCERTAINTY; NOT_RETURN_QUANTILES_OR_WIN_PROBABILITY",
  liveOrderSubmission: false,
});
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Cut off reserved/future observations BEFORE merging or computing features.
 * Source manifests are verified by the caller; overlap must agree exactly. */
export function prepareProfitStudyData(datasets: readonly Pick<HourlyDataset, "bars" | "funding">[]) {
  const endMs = PROFIT_STUDY_WINDOWS.at(-1)!.endMs;
  const barMap = new Map<string, ProfitBar>(), rateMap = new Map<string, FundingRow>();
  for (const dataset of datasets) {
    for (const original of dataset.bars) {
      if (original.openMs < PROFIT_STUDY_DESIGN.historyStartMs || original.openMs >= endMs) continue;
      const row = { symbol: original.symbol, openMs: original.openMs, open: original.open,
        high: original.high, low: original.low, close: original.close, volume: original.volume };
      const key = `${row.symbol}:${row.openMs}`, prior = barMap.get(key);
      if (prior && hash(prior) !== hash(row)) throw new Error(`PROFIT_STUDY_CONFLICTING_BAR:${key}`);
      barMap.set(key, row);
    }
    for (const original of dataset.funding) {
      if (original.timestampMs < PROFIT_STUDY_WINDOWS[0]!.startMs || original.timestampMs > endMs + S.hourMs) continue;
      const row = { symbol: original.symbol, timestampMs: original.timestampMs, rate: original.rate,
        ...(original.absoluteRate === undefined ? {} : { absoluteRate: original.absoluteRate }) };
      const key = `${row.symbol}:${row.timestampMs}`, prior = rateMap.get(key);
      if (prior && hash(prior) !== hash(row)) throw new Error(`PROFIT_STUDY_CONFLICTING_FUNDING:${key}`);
      rateMap.set(key, row);
    }
  }
  const bars = [...barMap.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
  const funding = [...rateMap.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  return { bars, funding, dataSha256: hash({ bars, funding }) };
}

/** Fits before each decision from causally admitted data. Calling this is
 * economic model evaluation; the runner must first seal the full protocol. */
export function prepareProfitStudyForecasts(bars: readonly ProfitBar[]) {
  const startMs = PROFIT_STUDY_WINDOWS[0]!.startMs, endMs = PROFIT_STUDY_WINDOWS.at(-1)!.endMs;
  const closes = buildProfitDailyCloses(bars, endMs + S.candleFinalizationDelayMs);
  const fits: ProfitModelFit[] = [], forecasts: ProfitForecast[] = [];
  const unavailable: Array<{ atMs: number; reason: string }> = [];
  let fit: ProfitModelFit | null = null;
  for (let day = startMs; day < endMs; day += S.dayMs) {
    const d = new Date(day), atMs = day + S.candleFinalizationDelayMs;
    if (d.getUTCDate() === 1) {
      fit = fitProfitModel(closes, atMs);
      if (fit) fits.push(fit); else unavailable.push({ atMs, reason: "INSUFFICIENT_MATURE_PAIRED_WEEKLY_TRAINING" });
    }
    if (d.getUTCDay() !== 1) continue;
    const values = forecastProfitModel(fit, closes, atMs);
    if (values) forecasts.push(...values); else unavailable.push({ atMs, reason: "FORECAST_UNAVAILABLE" });
  }
  return { fits, forecasts, unavailable, forecastSha256: hash(forecasts), fitSha256: hash(fits) };
}
