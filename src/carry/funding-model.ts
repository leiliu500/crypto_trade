/** Fixed development-only forecast. Rates are USD/base/hour; timestamps are hour ENDS. */
export const FUNDING_HOUR_MS = 3_600_000;
export const FUNDING_MODEL_SPEC = {
  version: "monthly-funding-development-v1", symbols: ["BTC/USD", "ETH/USD"],
  years: [2024, 2025], historyHours: 91 * 24, publicationLagHours: 1,
  point: "0.5*mean(last7days)+0.5*mean(last30days)",
  conservative: "min(mean(last7days),nearestRankQ10(13_nonoverlapping_weekly_means))",
  scope: "FUNDING_CASH_ONLY_NOT_STRATEGY_PNL", untouchedTest: false, activationAllowed: false,
} as const;

export interface FundingObservation { symbol: string; timestampMs: number; absoluteRate: number }
export type FundingPointModel = "adaptive" | "zero" | "last" | "mean30d";
const models: readonly FundingPointModel[] = ["adaptive", "zero", "last", "mean30d"];
const H = FUNDING_HOUR_MS;
const sum = (xs: readonly number[]) => {
  const value = xs.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(value)) throw new Error("FUNDING_ARITHMETIC_OVERFLOW");
  return value;
};
const mean = (xs: readonly number[]) => sum(xs) / xs.length;

export interface FundingCohort {
  symbol: string; year: number; month: number; decisionMs: number; targetAvailableAtMs: number;
  historyCutoffMs: number; expectedHistoryHours: number; observedHistoryHours: number;
  expectedTargetHours: number; observedTargetHours: number;
  missingHistoryEndTimesMs: number[]; missingTargetEndTimesMs: number[];
  forecastStatus: "KNOWN" | "UNKNOWN"; targetStatus: "KNOWN" | "UNKNOWN";
  forecastsUsdPerBase: Record<FundingPointModel, number | null>;
  conservativeUsdPerBase: number | null; actualUsdPerBase: number | null;
  matched: boolean;
}

/** Reject invalid rows even outside the requested cohort; callers must bound source years first. */
export function fundingMonthlyCohorts(rows: readonly FundingObservation[], symbol: string, year: number): FundingCohort[] {
  if (!(FUNDING_MODEL_SPEC.symbols as readonly string[]).includes(symbol) ||
      !(FUNDING_MODEL_SPEC.years as readonly number[]).includes(year)) throw new Error("FUNDING_COHORT_NOT_REGISTERED");
  const seen = new Set<string>(), index = new Map<number, number>();
  for (const row of rows) {
    if (!(FUNDING_MODEL_SPEC.symbols as readonly string[]).includes(row.symbol) ||
        !Number.isSafeInteger(row.timestampMs) || row.timestampMs % H !== 0 || !Number.isFinite(row.absoluteRate) ||
        row.timestampMs <= Date.UTC(2023, 0, 1) || row.timestampMs > Date.UTC(2026, 0, 1)) {
      throw new Error("INVALID_FUNDING_OBSERVATION");
    }
    const key = `${row.symbol}:${row.timestampMs}`;
    if (seen.has(key)) throw new Error("DUPLICATE_FUNDING_OBSERVATION");
    seen.add(key);
    if (row.symbol === symbol) index.set(row.timestampMs, row.absoluteRate);
  }
  const range = (startExclusive: number, endInclusive: number) => {
    const values: number[] = [], missing: number[] = [];
    for (let end = startExclusive + H; end <= endInclusive; end += H) {
      const rate = index.get(end);
      if (rate === undefined) missing.push(end); else values.push(rate);
    }
    return { values, missing };
  };
  return Array.from({ length: 12 }, (_, monthIndex) => {
    const decisionMs = Date.UTC(year, monthIndex, 1), endMs = Date.UTC(year, monthIndex + 1, 1);
    // Rate with normalized end d-H is modeled available at d. A rate ending d is not yet available.
    const historyCutoffMs = decisionMs - H, targetHours = (endMs - decisionMs) / H;
    const history = range(historyCutoffMs - 91 * 24 * H, historyCutoffMs);
    const last30 = range(historyCutoffMs - 30 * 24 * H, historyCutoffMs);
    const lastRate = index.get(historyCutoffMs);
    const target = range(decisionMs, endMs);
    const forecasts: Record<FundingPointModel, number | null> = {
      adaptive: null, zero: 0, last: lastRate === undefined ? null : lastRate * targetHours,
      mean30d: last30.missing.length ? null : mean(last30.values) * targetHours,
    };
    let conservative: number | null = null;
    if (!history.missing.length) {
      const weekly = Array.from({ length: 13 }, (_, week) => mean(history.values.slice(week * 168, (week + 1) * 168)));
      const last7Mean = weekly[12]!;
      forecasts.adaptive = (0.5 * last7Mean + 0.5 * mean(last30.values)) * targetHours;
      const q10 = [...weekly].sort((a, b) => a - b)[Math.ceil(0.1 * weekly.length) - 1]!;
      conservative = Math.min(last7Mean, q10) * targetHours;
    }
    if ([...Object.values(forecasts), conservative].some(v => v !== null && !Number.isFinite(v))) {
      throw new Error("FUNDING_ARITHMETIC_OVERFLOW");
    }
    return {
      symbol, year, month: monthIndex + 1, decisionMs, targetAvailableAtMs: endMs + H, historyCutoffMs,
      expectedHistoryHours: 91 * 24, observedHistoryHours: history.values.length,
      expectedTargetHours: targetHours, observedTargetHours: target.values.length,
      missingHistoryEndTimesMs: history.missing, missingTargetEndTimesMs: target.missing,
      forecastStatus: history.missing.length ? "UNKNOWN" : "KNOWN",
      targetStatus: target.missing.length ? "UNKNOWN" : "KNOWN",
      forecastsUsdPerBase: forecasts, conservativeUsdPerBase: conservative,
      actualUsdPerBase: target.missing.length ? null : sum(target.values),
      matched: !history.missing.length && !target.missing.length && models.every(model => forecasts[model] !== null),
    };
  });
}

export function summarizeFundingCohorts(cohorts: readonly FundingCohort[]) {
  if (!cohorts.length || new Set(cohorts.map(c => `${c.symbol}:${c.year}`)).size !== 1 ||
      cohorts.length !== 12 || new Set(cohorts.map(c => c.month)).size !== 12) throw new Error("EXPECTED_ONE_COMPLETE_CALENDAR");
  const matched = cohorts.filter(c => c.matched);
  const metrics = Object.fromEntries(models.map(model => {
    const errors = matched.map(c => c.forecastsUsdPerBase[model]! - c.actualUsdPerBase!);
    return [model, {
      count: errors.length,
      maeUsdPerBase: errors.length ? mean(errors.map(Math.abs)) : null,
      mseUsdSquaredPerBaseSquared: errors.length ? mean(errors.map(e => e * e)) : null,
      rmseUsdPerBase: errors.length ? Math.sqrt(mean(errors.map(e => e * e))) : null,
      meanSignedErrorUsdPerBase: errors.length ? mean(errors) : null,
      directionAccuracy: errors.length ? mean(matched.map(c => Number(Math.sign(c.forecastsUsdPerBase[model]!) === Math.sign(c.actualUsdPerBase!)))) : null,
      predictedTotalUsdPerBase: errors.length ? sum(matched.map(c => c.forecastsUsdPerBase[model]!)) : null,
      actualTotalUsdPerBase: errors.length ? sum(matched.map(c => c.actualUsdPerBase!)) : null,
    }];
  })) as Record<FundingPointModel, { count: number; maeUsdPerBase: number | null; mseUsdSquaredPerBaseSquared: number | null;
    rmseUsdPerBase: number | null; meanSignedErrorUsdPerBase: number | null; directionAccuracy: number | null;
    predictedTotalUsdPerBase: number | null; actualTotalUsdPerBase: number | null }>;
  const violations = matched.filter(c => c.actualUsdPerBase! < c.conservativeUsdPerBase!).map(c => ({ month: c.month,
    shortfallUsdPerBase: c.conservativeUsdPerBase! - c.actualUsdPerBase! }));
  return { symbol: cohorts[0]!.symbol, year: cohorts[0]!.year, calendarCohorts: 12, matchedCohorts: matched.length,
    knownForecastCohorts: cohorts.filter(c => c.forecastStatus === "KNOWN").length,
    knownTargetCohorts: cohorts.filter(c => c.targetStatus === "KNOWN").length,
    fullCoverage: matched.length === 12, metrics,
    candidateLowerMaeThanEveryBaseline: matched.length ? models.filter(m => m !== "adaptive")
      .every(m => metrics.adaptive.maeUsdPerBase! < metrics[m].maeUsdPerBase!) : null,
    conservative: { count: matched.length, violations, violationFrequency: matched.length ? violations.length / matched.length : null,
      interpretation: "EMPIRICAL_ESTIMATE_NOT_A_CONFIDENCE_BOUND" },
  };
}
