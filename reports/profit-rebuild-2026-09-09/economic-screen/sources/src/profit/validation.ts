import { createHash } from "node:crypto";
import { PROFIT_SPEC as S } from "./spec.js";
import { PROFIT_STUDY_WINDOWS } from "./study.js";

/** These are research promotion rules for this one frozen hypothesis. They are
 * not universal trading rules, a significance claim after repeated research,
 * or permission to submit real orders. */
export const PROFIT_VALIDATION_SPEC = Object.freeze({
  version: "weekly-inventory-economic-validation-v1",
  strategyVersion: S.version,
  windows: PROFIT_STUDY_WINDOWS,
  scenarios: ["base", "stress"] as const,
  fundingAssumptions: ["source-plus-hour", "source-as-end"] as const,
  candidatePolicy: "weekly-forecast",
  benchmarkPolicies: ["risk-managed-long-btc", "risk-managed-long-eth"] as const,
  historicalEvidence: "REUSED_DEVELOPMENT_AND_REUSED_CONFIRMATION; NOT_UNTOUCHED_HOLDOUT",
  historicalEvidenceKind: "HOURLY_CANDLE_PROXY",
  previousFailedStudiesMustBePreserved: true,
  reserved2026WindowExcluded: true,
  everyCandidateRun: { completeFundedAccounting: true, minimumNetPnlUsdExclusive: 0,
    maximumDrawdownUsd: 200, maximumRiskBreaches: 0, minimumActiveCalendarWeeks: 8,
    unresolvedPositionMustBeNull: true },
  calendar: "UTC_MONDAY_WEEKS; ALL_FLAT_AND_PARTIAL_BOUNDARY_WEEKS_INCLUDED; ACTIVITY_MEANS_POSITIVE_EXPOSURE",
  uncertainty: { method: "MOVING_BLOCK_BOOTSTRAP_CALENDAR_WEEK_NET_PNL", blockWeeks: 4,
    repetitions: 2000, seed: 0x73a52d19, lowerQuantile: .05, minimumWeeks: 8,
    minimumLowerMeanNetUsdPerWeekExclusive: 0, requiredScenarios: ["base"] as const,
    interpretation: "NOMINAL_SERIAL_DEPENDENCE_SENSITIVITY; NOT_MULTIPLE_RESEARCH_ADJUSTED_OR_A_RETURN_GUARANTEE" },
  benchmark: { flatCashNetPnlUsd: 0,
    interpretation: "MEAN_OF_INDEPENDENT_ONE_SLOT_RISK_MANAGED_LONG_PATHS; NOT_AN_EXECUTABLE_TWO_POSITION_PORTFOLIO",
    requiredComparison: "POOLED_TWO_PERIOD_BASE_CANDIDATE_NET_EXCEEDS_MEAN_BTC_ETH_NET_FOR_EACH_FUNDING_ASSUMPTION",
    perPeriodExcessIsDiagnosticOnly: true },
  historicalPromotion: "ELIGIBLE_FOR_BOUNDED_PAPER_PILOT_ONLY; CALLER_MUST_VERIFY_SEALED_SOURCE_AND_DATA_ARTIFACTS",
  prospective: { minimumCalendarDays: 90, evidenceKind: "INDEPENDENTLY_HELD_RECORDED_BOOK_FILLS",
    knownExecutionFeesAndFundingRequired: true, positiveCalendarNetLowerBoundRequired: true,
    riskAndDrawdownLimitsRequired: true, frozenSourceAndConfigHashesRequired: true,
    independentEvidenceVerifierImplemented: false },
  fullValidationWithoutIndependentProspectiveVerification: false,
  unknownOrMalformedAccounting: "FAIL_CLOSED", realOrdersAllowed: false,
});
export const PROFIT_VALIDATION_SPEC_SHA256 = createHash("sha256")
  .update(JSON.stringify(PROFIT_VALIDATION_SPEC)).digest("hex");

export interface ProfitValidationDaily {
  date: string; netPnlUsd: number | null; exposureNotionalHours: number;
}
export interface ProfitValidationAsset {
  symbol: string; grossPnlUsd: number; feeUsd: number; fundingCashUsd: number | null;
  netPnlUsd: number | null; exposureNotionalHours: number; completedTrades: number;
}
/** Structural subset of replayProfit's result. This validates economic
 * consistency, not provenance: a separate sealed-artifact verifier is needed. */
export interface ProfitValidationReplay {
  version: string; policy: string; benchmarkOnly: boolean; scenario: string; fundingAssumption: string;
  startMs: number; endMs: number; evidenceKind: string; synthetic: boolean; accountingKnown: boolean;
  grossPnlUsd: number; feeUsd: number; fundingCashUsd: number | null; netPnlUsd: number | null;
  maxDrawdownUsd: number | null; riskBreachCount: number; unresolvedPosition: unknown;
  fundingRequiredHours: number; fundingObservedHours: number; missingFundingHours: number;
  completedTrades: number; exposureNotionalHours: number;
  dailyNetPnlUsd: readonly ProfitValidationDaily[]; perAsset: readonly ProfitValidationAsset[];
}
export interface ProfitValidationInput {
  runs: readonly ProfitValidationReplay[];
  benchmarks: readonly ProfitValidationReplay[];
  /** Informational only until a verifier checks independent raw book, fill,
   * fee, funding, registration and source artifacts. No boolean can promote. */
  prospective?: unknown;
}
export interface ProfitCalendarWeek {
  weekStartDate: string; firstDate: string; lastDate: string; calendarDays: number;
  netPnlUsd: number; exposureNotionalHours: number;
}
export interface ProfitRunValidation {
  key: string; windowId: string | null; policy: string | null; passed: boolean;
  accountingValid: boolean; reasons: string[]; netPnlUsd: number | null;
  activeCalendarWeeks: number; calendarWeeks: ProfitCalendarWeek[];
  lowerMeanNetUsdPerWeek: number | null; dailyDrawdownUsd: number | null;
}
type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue => Boolean(v && typeof v === "object" && !Array.isArray(v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-7, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
const date = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);
const windowFor = (r: RecordValue) => PROFIT_STUDY_WINDOWS.find(w => r.startMs === w.startMs && r.endMs === w.endMs);
const runKey = (r: RecordValue) => `${windowFor(r)?.id ?? "INVALID_WINDOW"}:${String(r.policy)}:${String(r.scenario)}:${String(r.fundingAssumption)}`;

/** Aggregates every UTC calendar day, retaining idle and partial boundary
 * weeks. Invalid dates, duplicates, missing days or nonfinite values reject. */
export function profitCalendarWeeks(rows: readonly ProfitValidationDaily[], startMs: number, endMs: number): ProfitCalendarWeek[] | null {
  if (!count(startMs) || !count(endMs) || startMs % S.dayMs || endMs % S.dayMs || endMs <= startMs
    || endMs > 8_640_000_000_000_000 || !Array.isArray(rows)
    || rows.length !== (endMs - startMs) / S.dayMs) return null;
  const weeks: ProfitCalendarWeek[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row: unknown = rows[i], atMs = startMs + i * S.dayMs;
    if (!object(row) || row.date !== date(atMs) || !finite(row.netPnlUsd)
      || !finite(row.exposureNotionalHours) || row.exposureNotionalHours < 0) return null;
    const weekStart = atMs - ((new Date(atMs).getUTCDay() + 6) % 7) * S.dayMs;
    let week = weeks.at(-1);
    if (!week || week.weekStartDate !== date(weekStart)) {
      week = { weekStartDate: date(weekStart), firstDate: row.date as string, lastDate: row.date as string,
        calendarDays: 0, netPnlUsd: 0, exposureNotionalHours: 0 };
      weeks.push(week);
    }
    week.lastDate = row.date as string; week.calendarDays++;
    week.netPnlUsd += row.netPnlUsd; week.exposureNotionalHours += row.exposureNotionalHours;
    if (!finite(week.netPnlUsd) || !finite(week.exposureNotionalHours)) return null;
  }
  return weeks;
}

/** Fixed-seed noncircular moving four-week blocks. The statistic is mean USD
 * per calendar week, including flat and partial weeks, not a trade-win rate. */
export function profitWeeklyNetLowerBound(values: readonly number[]): number | null {
  const u = PROFIT_VALIDATION_SPEC.uncertainty;
  if (!Array.isArray(values) || values.length < u.minimumWeeks || !values.every(finite)) return null;
  let state: number = u.seed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000; };
  const means: number[] = [], starts = values.length - u.blockWeeks + 1;
  for (let sample = 0; sample < u.repetitions; sample++) {
    let total = 0, filled = 0;
    while (filled < values.length) {
      const start = Math.floor(random() * starts), length = Math.min(u.blockWeeks, values.length - filled);
      for (let offset = 0; offset < length; offset++) total += values[start + offset]!;
      filled += length;
    }
    const mean = total / values.length;
    if (!finite(mean)) return null;
    means.push(mean);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(u.lowerQuantile * (means.length - 1))]!;
}

function validateRun(value: unknown, benchmark: boolean): ProfitRunValidation {
  const reasons: string[] = [], r = object(value) ? value : {};
  const fail = (condition: boolean, reason: string) => { if (condition) reasons.push(reason); };
  const window = windowFor(r), policy = typeof r.policy === "string" ? r.policy : null;
  fail(!window, "WINDOW_INVALID_OR_RESERVED");
  fail(r.version !== S.version || r.evidenceKind !== PROFIT_VALIDATION_SPEC.historicalEvidenceKind
    || r.synthetic !== false, "EVIDENCE_IDENTITY_INVALID");
  fail(benchmark ? !PROFIT_VALIDATION_SPEC.benchmarkPolicies.some(p => p === policy) || r.benchmarkOnly !== true
    : policy !== "weekly-forecast" || r.benchmarkOnly !== false, "POLICY_IDENTITY_INVALID");
  fail(!PROFIT_VALIDATION_SPEC.scenarios.some(s => s === r.scenario)
    || !PROFIT_VALIDATION_SPEC.fundingAssumptions.some(f => f === r.fundingAssumption), "SCENARIO_INVALID");
  fail(r.accountingKnown !== true || !finite(r.netPnlUsd) || !finite(r.grossPnlUsd)
    || !finite(r.feeUsd) || r.feeUsd < 0 || !finite(r.fundingCashUsd), "ACCOUNTING_UNKNOWN_OR_INVALID");
  fail(r.unresolvedPosition !== null, "UNRESOLVED_POSITION");
  fail(!count(r.riskBreachCount) || r.riskBreachCount !== 0, "RISK_BREACH");
  fail(!count(r.fundingRequiredHours) || !count(r.fundingObservedHours) || !count(r.missingFundingHours)
    || r.fundingRequiredHours !== r.fundingObservedHours || r.missingFundingHours !== 0, "FUNDING_COVERAGE_INCOMPLETE");
  fail(!count(r.completedTrades) || !finite(r.exposureNotionalHours) || r.exposureNotionalHours < 0,
    "ACTIVITY_ACCOUNTING_INVALID");
  fail(finite(r.exposureNotionalHours) && r.exposureNotionalHours > 0 && r.fundingRequiredHours === 0,
    "EXPOSURE_WITHOUT_FUNDING_OBSERVATIONS");
  fail(!finite(r.maxDrawdownUsd) || r.maxDrawdownUsd < 0, "DRAWDOWN_UNKNOWN_OR_INVALID");
  fail(finite(r.netPnlUsd) && finite(r.grossPnlUsd) && finite(r.feeUsd) && finite(r.fundingCashUsd)
    && !near(r.netPnlUsd, r.grossPnlUsd - r.feeUsd + r.fundingCashUsd), "CASH_ACCOUNTING_MISMATCH");
  const rows = Array.isArray(r.dailyNetPnlUsd) ? r.dailyNetPnlUsd as ProfitValidationDaily[] : [];
  const weeks = window ? profitCalendarWeeks(rows, window.startMs, window.endMs) : null;
  fail(!weeks, "DAILY_ACCOUNTING_INCOMPLETE");
  let dailyDrawdownUsd: number | null = null;
  if (weeks) {
    let total = 0, peak = 0; dailyDrawdownUsd = 0;
    for (const row of rows) { total += row.netPnlUsd!; peak = Math.max(peak, total);
      dailyDrawdownUsd = Math.max(dailyDrawdownUsd, peak - total); }
    fail(!finite(total) || !finite(r.netPnlUsd) || !near(total, r.netPnlUsd), "DAILY_NET_ACCOUNTING_MISMATCH");
    const exposure = rows.reduce((sum, row) => sum + row.exposureNotionalHours, 0);
    fail(!finite(exposure) || !finite(r.exposureNotionalHours) || !near(exposure, r.exposureNotionalHours),
      "DAILY_EXPOSURE_ACCOUNTING_MISMATCH");
    fail(!finite(r.maxDrawdownUsd) || r.maxDrawdownUsd + 1e-7 < dailyDrawdownUsd, "DRAWDOWN_ACCOUNTING_MISMATCH");
  }
  const assets: unknown[] = Array.isArray(r.perAsset) ? r.perAsset : [];
  const validAssets = assets.length === S.symbols.length && assets.every(object)
    && S.symbols.every(symbol => assets.filter(a => object(a) && a.symbol === symbol).length === 1);
  fail(!validAssets, "ASSET_EVIDENCE_MISSING_OR_DUPLICATE");
  if (validAssets) {
    const records = assets as RecordValue[];
    const finiteAssets = records.every(a => finite(a.grossPnlUsd) && finite(a.feeUsd) && a.feeUsd >= 0
      && finite(a.fundingCashUsd) && finite(a.netPnlUsd) && finite(a.exposureNotionalHours)
      && a.exposureNotionalHours >= 0 && count(a.completedTrades));
    fail(!finiteAssets, "ASSET_ACCOUNTING_INVALID");
    if (finiteAssets) {
      for (const a of records) fail(!near(a.netPnlUsd as number,
        (a.grossPnlUsd as number) - (a.feeUsd as number) + (a.fundingCashUsd as number)), "ASSET_CASH_ACCOUNTING_MISMATCH");
      for (const field of ["grossPnlUsd", "feeUsd", "fundingCashUsd", "netPnlUsd", "exposureNotionalHours", "completedTrades"])
        fail(!finite(r[field]) || !near(records.reduce((sum, a) => sum + (a[field] as number), 0), r[field] as number),
          `ASSET_TOTAL_MISMATCH:${field}`);
    }
  }
  const accountingValid = reasons.length === 0;
  const activeCalendarWeeks = weeks?.filter(w => w.exposureNotionalHours > 0).length ?? 0;
  const lowerMeanNetUsdPerWeek = weeks ? profitWeeklyNetLowerBound(weeks.map(w => w.netPnlUsd)) : null;
  if (!benchmark) {
    fail(!finite(r.netPnlUsd) || r.netPnlUsd <= 0, "NET_PROFIT_NOT_POSITIVE");
    fail(!finite(r.maxDrawdownUsd) || r.maxDrawdownUsd > PROFIT_VALIDATION_SPEC.everyCandidateRun.maximumDrawdownUsd,
      "DRAWDOWN_LIMIT_FAILED");
    fail(activeCalendarWeeks < PROFIT_VALIDATION_SPEC.everyCandidateRun.minimumActiveCalendarWeeks, "INSUFFICIENT_ACTIVE_WEEKS");
    fail(r.scenario === "base" && (lowerMeanNetUsdPerWeek === null || lowerMeanNetUsdPerWeek <= 0),
      "CALENDAR_NET_UNCERTAINTY_GATE_FAILED");
  }
  return { key: runKey(r), windowId: window?.id ?? null, policy, passed: reasons.length === 0, accountingValid,
    reasons: [...new Set(reasons)], netPnlUsd: finite(r.netPnlUsd) ? r.netPnlUsd : null,
    activeCalendarWeeks, calendarWeeks: weeks ?? [], lowerMeanNetUsdPerWeek, dailyDrawdownUsd };
}

/** An economic screen can nominate a bounded paper pilot. It cannot establish
 * executable profit or independently verify its own submitted evidence. Full
 * validation remains false until a raw prospective evidence verifier exists. */
export function validateProfitStudy(input: ProfitValidationInput) {
  const reasons: string[] = [];
  const envelope: unknown = input;
  const validEnvelope = object(envelope) && Array.isArray(envelope.runs) && Array.isArray(envelope.benchmarks);
  const runs: unknown[] = validEnvelope ? envelope.runs as unknown[] : [];
  const benchmarks: unknown[] = validEnvelope ? envelope.benchmarks as unknown[] : [];
  if (!validEnvelope) reasons.push("VALIDATION_ENVELOPE_INVALID");
  const checks = runs.map(r => validateRun(r, false));
  const benchmarkChecks = benchmarks.map(r => validateRun(r, true));
  const expected = (policies: readonly string[]) => PROFIT_STUDY_WINDOWS.flatMap(w => policies.flatMap(p =>
    PROFIT_VALIDATION_SPEC.scenarios.flatMap(s => PROFIT_VALIDATION_SPEC.fundingAssumptions.map(f => `${w.id}:${p}:${s}:${f}`))));
  const complete = (rows: readonly ProfitRunValidation[], keys: readonly string[]) => rows.length === keys.length
    && new Set(rows.map(r => r.key)).size === rows.length && rows.every(r => keys.includes(r.key))
    && keys.every(k => rows.some(r => r.key === k));
  const runSetComplete = complete(checks, expected(["weekly-forecast"]));
  const benchmarkSetComplete = complete(benchmarkChecks, expected(PROFIT_VALIDATION_SPEC.benchmarkPolicies));
  if (!runSetComplete) reasons.push("CANDIDATE_RUN_SET_MISSING_DUPLICATE_OR_UNDECLARED");
  if (!benchmarkSetComplete) reasons.push("BENCHMARK_RUN_SET_MISSING_DUPLICATE_OR_UNDECLARED");
  if (checks.some(r => !r.passed)) reasons.push("CANDIDATE_ECONOMICS_OR_ACCOUNTING_FAILED");
  if (benchmarkChecks.some(r => !r.accountingValid)) reasons.push("BENCHMARK_ACCOUNTING_FAILED");
  const benchmarkComparisons = PROFIT_VALIDATION_SPEC.fundingAssumptions.map(fundingAssumption => {
    const periods = PROFIT_STUDY_WINDOWS.map(w => {
      const candidate = checks.filter(r => r.key === `${w.id}:weekly-forecast:base:${fundingAssumption}`);
      const btc = benchmarkChecks.filter(r => r.key === `${w.id}:risk-managed-long-btc:base:${fundingAssumption}`);
      const eth = benchmarkChecks.filter(r => r.key === `${w.id}:risk-managed-long-eth:base:${fundingAssumption}`);
      const known = [candidate, btc, eth].every(list => list.length === 1 && list[0]!.accountingValid && finite(list[0]!.netPnlUsd));
      const candidateNetPnlUsd = known ? candidate[0]!.netPnlUsd! : null;
      const benchmarkMeanNetPnlUsd = known ? (btc[0]!.netPnlUsd! + eth[0]!.netPnlUsd!) / 2 : null;
      return { windowId: w.id, candidateNetPnlUsd, benchmarkMeanNetPnlUsd,
        excessNetPnlUsd: known ? candidateNetPnlUsd! - benchmarkMeanNetPnlUsd! : null };
    });
    const known = periods.every(p => finite(p.candidateNetPnlUsd) && finite(p.benchmarkMeanNetPnlUsd));
    const candidateNetPnlUsd = known ? periods.reduce((sum, p) => sum + p.candidateNetPnlUsd!, 0) : null;
    const benchmarkMeanNetPnlUsd = known ? periods.reduce((sum, p) => sum + p.benchmarkMeanNetPnlUsd!, 0) : null;
    const excessNetPnlUsd = known ? candidateNetPnlUsd! - benchmarkMeanNetPnlUsd! : null;
    return { fundingAssumption, passed: known && finite(excessNetPnlUsd) && excessNetPnlUsd > 0,
      candidateNetPnlUsd, benchmarkMeanNetPnlUsd, excessNetPnlUsd, periods };
  });
  if (benchmarkComparisons.some(c => !c.passed)) reasons.push("POOLED_BENCHMARK_EXCESS_FAILED_OR_UNKNOWN");
  const historicalEligible = validEnvelope && runSetComplete && benchmarkSetComplete
    && checks.every(r => r.passed) && benchmarkChecks.every(r => r.accountingValid)
    && benchmarkComparisons.every(c => c.passed);
  return { validationSpecSha256: PROFIT_VALIDATION_SPEC_SHA256,
    historicalEligible, paperPilotAllowed: historicalEligible,
    paperPilotRequiresSealedArtifactVerification: true,
    fullValidationPassed: false as const, prospectivePassed: false as const, realOrdersAllowed: false as const,
    prospectiveStatus: "INDEPENDENT_RECORDED_BOOK_EVIDENCE_VERIFIER_REQUIRED" as const,
    prospectiveEvidenceSupplied: object(envelope) && envelope.prospective !== undefined,
    reasons: [...reasons, "PROSPECTIVE_PROFIT_EVIDENCE_NOT_INDEPENDENTLY_VERIFIED"],
    runs: checks, benchmarks: benchmarkChecks, benchmarkComparisons,
    flatBenchmarkNetPnlUsd: 0, winProbability: null,
    evidenceInterpretation: PROFIT_VALIDATION_SPEC.historicalEvidence,
    benchmarkInterpretation: PROFIT_VALIDATION_SPEC.benchmark.interpretation };
}
