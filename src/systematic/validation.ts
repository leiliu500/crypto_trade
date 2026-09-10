import { createHash } from "node:crypto";
import { SYSTEMATIC_SPEC as S } from "./spec.js";

const DAY = 86_400_000;
function freezeProtocol<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === "object") freezeProtocol(child);
  return Object.freeze(value);
}
/** Frozen before replay outcomes. These are declared research requirements,
 * not universal institutional thresholds or a guarantee of future returns.
 * Both historical periods have already been studied and are development data.
 */
export const SYSTEMATIC_VALIDATION_PROTOCOL = freezeProtocol({
  version: "systematic-profitability-validation-v1", strategyVersion: S.version,
  historicalInterpretation: "REPEATED_DEVELOPMENT_NOT_UNTOUCHED_HOLDOUT",
  developmentWindows: [
    { windowId: "development-2024", startMs: Date.UTC(2024, 0, 1), endMs: Date.UTC(2025, 0, 1) },
    { windowId: "development-2025-h1", startMs: Date.UTC(2025, 0, 1), endMs: Date.UTC(2025, 6, 1) },
  ],
  scenarios: ["base", "stress"], fundingSensitivities: ["source-plus-hour", "source-as-end"],
  minimumCompletedTradesPerDevelopmentRun: 20, minimumCompletedTradesPerAsset: 5,
  minimumActiveWeeksPerRun: 8,
  activeWeekDefinition: "NONOVERLAPPING_SEVEN_DAY_BLOCKS_FROM_WINDOW_START_WITH_COMPLETED_TRADES",
  positiveNetRequiredForEachAssetAndRun: true,
  benchmark: { name: "FLAT_CASH_WITHOUT_INTEREST", netPnlUsd: 0 },
  studyRiskNotionalUsd: 1000, maximumDrawdownUsd: 200, maximumDrawdownStudyNotionalFraction: .20,
  drawdownBasis: "PEAK_TO_TROUGH_LIQUIDATION_EQUITY_INCLUDING_OPEN_POSITIONS_AND_COSTS",
  uncertainty: { method: "MOVING_BLOCK_BOOTSTRAP_COMPLETE_CALENDAR_DAILY_NET",
    blockDays: 7, repetitions: 2000, seed: 0x519e57a1, lowerQuantile: .05,
    minimumLowerMeanNetUsdPerDay: 0,
    interpretation: "NOMINAL_DEPENDENCE_AWARE_NOT_MULTIPLE_RESEARCH_ADJUSTED_OR_PROFIT_GUARANTEE" },
  prospective: { required: true, minimumCalendarDays: 90, minimumCompletedTradesPerRun: 30,
    registrationMustPrecedeWindow: true, sourceMustRemainFrozen: true, configMustRemainFrozen: true,
    evidenceKind: "RECORDED_BOOK_PAPER", fundingMustBeVerified: true, scenarios: ["base", "stress"] },
  unknownAccounting: "FAIL_CLOSED", syntheticEvidence: "REJECT",
  realOrdersAuthorized: false,
});
export const SYSTEMATIC_VALIDATION_PROTOCOL_SHA256 = createHash("sha256")
  .update(JSON.stringify(SYSTEMATIC_VALIDATION_PROTOCOL)).digest("hex");

export interface SystematicValidationRun {
  windowId: "development-2024" | "development-2025-h1" | "prospective";
  scenario: "base" | "stress";
  fundingAssumption: "source-plus-hour" | "source-as-end" | "verified-settlements";
  strategyVersion: string; protocolSha256: string; strategySourceSha256: string; strategyConfigSha256: string; dataSha256: string;
  evidenceKind: "HOURLY_CANDLE_PROXY" | "RECORDED_BOOK_PAPER";
  startMs: number; endMs: number;
  accountingKnown: boolean; synthetic: boolean;
  completedTrades: number; netPnlUsd: number | null; maxDrawdownUsd: number | null;
  fundingRequiredHours: number; fundingObservedHours: number; missingFundingHours: number;
  fundingTimestampVerified: boolean;
  dailyNetPnlUsd: Array<{ date: string; netPnlUsd: number | null; completedTrades: number }>;
  perAsset: Array<{ symbol: string; completedTrades: number; netPnlUsd: number | null }>;
}
export interface SystematicProspectiveRegistration {
  registeredAtMs: number; startMs: number; endMs: number; strategySourceSha256: string; strategyConfigSha256: string;
}
export interface SystematicValidationInput {
  protocolSha256: string; strategySourceSha256: string; strategyConfigSha256: string;
  registeredAtMs: number; asOfMs: number;
  runs: readonly SystematicValidationRun[];
  prospectiveRegistration?: SystematicProspectiveRegistration;
}
export interface SystematicRunValidation {
  key: string; passed: boolean; reasons: string[]; lowerMeanNetUsdPerDay: number | null; activeWeeks: number;
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && value <= 8_640_000_000_000_000;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-7, Math.abs(b) * 1e-9);
const key = (run: Pick<SystematicValidationRun, "windowId" | "scenario" | "fundingAssumption">) =>
  `${run.windowId}:${run.scenario}:${run.fundingAssumption}`;

/** Resamples complete seven-day chunks of calendar P&L, including idle days.
 * Blocks preserve short serial dependence; this does not establish arbitrary
 * dependence coverage or correct repeated historical strategy experimentation.
 */
export function systematicDailyNetLowerBound(values: readonly number[]): number | null {
  const u = SYSTEMATIC_VALIDATION_PROTOCOL.uncertainty;
  if (!Array.isArray(values) || values.length < u.blockDays * 2 || !values.every(finite)) return null;
  let state = u.seed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
  const means: number[] = [], starts = values.length - u.blockDays + 1;
  for (let sample = 0; sample < u.repetitions; sample++) {
    let total = 0, filled = 0;
    while (filled < values.length) {
      const start = Math.floor(random() * starts), length = Math.min(u.blockDays, values.length - filled);
      for (let offset = 0; offset < length; offset++) total += values[start + offset]!;
      filled += length;
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(u.lowerQuantile * (means.length - 1))]!;
  return Number.isFinite(lower) ? lower : null;
}

function validateRun(run: SystematicValidationRun, input: SystematicValidationInput): SystematicRunValidation {
  const reasons: string[] = [], protocol = SYSTEMATIC_VALIDATION_PROTOCOL;
  const fail = (condition: boolean, reason: string) => { if (condition) reasons.push(reason); };
  const prospective = run.windowId === "prospective";
  const expectedWindow = prospective ? input.prospectiveRegistration
    : protocol.developmentWindows.find(window => window.windowId === run.windowId);
  fail(!expectedWindow || !time(run.startMs) || !time(run.endMs) || run.startMs % DAY !== 0
    || run.endMs % DAY !== 0 || run.endMs <= run.startMs || run.startMs !== expectedWindow.startMs
    || run.endMs !== expectedWindow.endMs || run.endMs > input.asOfMs, "WINDOW_INVALID");
  fail(run.strategyVersion !== S.version || run.protocolSha256 !== SYSTEMATIC_VALIDATION_PROTOCOL_SHA256
    || run.strategySourceSha256 !== input.strategySourceSha256 || run.strategyConfigSha256 !== input.strategyConfigSha256
    || !hash(run.dataSha256), "EVIDENCE_IDENTITY_MISMATCH");
  fail(run.synthetic !== false, "SYNTHETIC_OR_UNDECLARED_EVIDENCE");
  fail(prospective ? run.evidenceKind !== protocol.prospective.evidenceKind
    : !["HOURLY_CANDLE_PROXY", "RECORDED_BOOK_PAPER"].includes(run.evidenceKind), "EVIDENCE_KIND_INVALID");
  fail(run.accountingKnown !== true || !finite(run.netPnlUsd), "ACCOUNTING_UNKNOWN");
  fail(!count(run.fundingRequiredHours) || !count(run.fundingObservedHours) || !count(run.missingFundingHours)
    || run.fundingObservedHours !== run.fundingRequiredHours || run.missingFundingHours !== 0, "FUNDING_COVERAGE_INCOMPLETE");
  fail(prospective && run.fundingTimestampVerified !== true, "PROSPECTIVE_FUNDING_UNVERIFIED");
  fail(!finite(run.netPnlUsd) || run.netPnlUsd <= 0, "NET_PROFIT_NOT_POSITIVE");
  fail(!finite(run.maxDrawdownUsd) || run.maxDrawdownUsd < 0
    || run.maxDrawdownUsd > protocol.maximumDrawdownUsd, "DRAWDOWN_LIMIT_FAILED");
  fail(!count(run.completedTrades) || run.completedTrades < (prospective
    ? protocol.prospective.minimumCompletedTradesPerRun : protocol.minimumCompletedTradesPerDevelopmentRun), "INSUFFICIENT_TRADES");
  const assets = Array.isArray(run.perAsset) ? run.perAsset : [];
  const validAssets = assets.length === 2 && assets.every(row => row && typeof row === "object")
    && new Set(assets.map(row => row.symbol)).size === 2
    && ["BTC/USD", "ETH/USD"].every(symbol => assets.some(row => row.symbol === symbol));
  fail(!validAssets, "ASSET_EVIDENCE_MISSING");
  fail(assets.some(row => !row || !count(row.completedTrades) || row.completedTrades < protocol.minimumCompletedTradesPerAsset
    || !finite(row.netPnlUsd) || row.netPnlUsd <= 0), "ASSET_PROFIT_OR_TRADES_FAILED");
  fail(validAssets && (assets.reduce((sum, row) => sum + row.completedTrades, 0) !== run.completedTrades
    || !finite(run.netPnlUsd) || !assets.every(row => finite(row.netPnlUsd))
    || !near(assets.reduce((sum, row) => sum + (row.netPnlUsd ?? NaN), 0), run.netPnlUsd)), "ASSET_ACCOUNTING_MISMATCH");
  let dailyValid = time(run.startMs) && time(run.endMs) && run.endMs > run.startMs
    && Array.isArray(run.dailyNetPnlUsd) && run.dailyNetPnlUsd.length === (run.endMs - run.startMs) / DAY;
  const values: number[] = [];
  let dailyCompletedTrades = 0, cumulativeNet = 0, highWaterNet = 0, dailyDrawdownUsd = 0;
  const activeWeekNumbers = new Set<number>();
  if (dailyValid) for (let i = 0; i < run.dailyNetPnlUsd.length; i++) {
    const row = run.dailyNetPnlUsd[i]!;
    if (!row || row.date !== new Date(run.startMs + i * DAY).toISOString().slice(0, 10)
      || !finite(row.netPnlUsd) || !count(row.completedTrades)) {
      dailyValid = false; break;
    }
    values.push(row.netPnlUsd);
    dailyCompletedTrades += row.completedTrades;
    if (row.completedTrades > 0) activeWeekNumbers.add(Math.floor(i / 7));
    cumulativeNet += row.netPnlUsd;
    highWaterNet = Math.max(highWaterNet, cumulativeNet);
    dailyDrawdownUsd = Math.max(dailyDrawdownUsd, highWaterNet - cumulativeNet);
  }
  fail(!dailyValid, "DAILY_ACCOUNTING_INCOMPLETE");
  fail(dailyValid && (!finite(run.netPnlUsd) || !near(values.reduce((sum, value) => sum + value, 0), run.netPnlUsd)),
    "DAILY_ACCOUNTING_MISMATCH");
  fail(dailyValid && dailyCompletedTrades !== run.completedTrades, "DAILY_TRADE_COUNT_MISMATCH");
  fail(!dailyValid || activeWeekNumbers.size < protocol.minimumActiveWeeksPerRun, "INSUFFICIENT_ACTIVE_WEEKS");
  fail(dailyValid && (!finite(run.maxDrawdownUsd) || run.maxDrawdownUsd + 1e-7 < dailyDrawdownUsd),
    "DRAWDOWN_ACCOUNTING_MISMATCH");
  const lowerMeanNetUsdPerDay = dailyValid ? systematicDailyNetLowerBound(values) : null;
  fail(lowerMeanNetUsdPerDay === null || lowerMeanNetUsdPerDay <= 0, "NET_UNCERTAINTY_GATE_FAILED");
  return { key: key(run), passed: reasons.length === 0, reasons, lowerMeanNetUsdPerDay,
    activeWeeks: dailyValid ? activeWeekNumbers.size : 0 };
}

/** Repeated development can reject a candidate, but cannot authorize activation.
 * Real orders are never authorized by this research verdict. The caller must
 * verify externally sealed source/data artifacts as well as these economics.
 */
export function evaluateSystematicValidation(input: SystematicValidationInput) {
  const reasons: string[] = [], protocol = SYSTEMATIC_VALIDATION_PROTOCOL;
  const validEnvelope = Boolean(input && input.protocolSha256 === SYSTEMATIC_VALIDATION_PROTOCOL_SHA256
    && hash(input.strategySourceSha256) && hash(input.strategyConfigSha256)
    && time(input.registeredAtMs) && time(input.asOfMs)
    && input.registeredAtMs <= input.asOfMs && Array.isArray(input.runs));
  if (!validEnvelope) return { protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256,
    developmentPassed: false, prospectivePassed: false, paperActivationAllowed: false,
    realOrdersAllowed: false, reasons: ["VALIDATION_ENVELOPE_INVALID"], runs: [] as SystematicRunValidation[] };
  const expectedDevelopment = protocol.developmentWindows.flatMap(window => protocol.scenarios.flatMap(scenario =>
    protocol.fundingSensitivities.map(fundingAssumption => `${window.windowId}:${scenario}:${fundingAssumption}`)));
  const expectedProspective = protocol.scenarios.map(scenario => `prospective:${scenario}:verified-settlements`);
  const knownKeys = new Set([...expectedDevelopment, ...expectedProspective]);
  const seen = new Set<string>();
  let validRunSet = true;
  for (const run of input.runs) {
    if (!run || !knownKeys.has(key(run)) || seen.has(key(run))) { validRunSet = false; continue; }
    seen.add(key(run));
  }
  if (!validRunSet) reasons.push("DUPLICATE_OR_UNDECLARED_RUN");
  const checks = input.runs.filter(run => run && knownKeys.has(key(run))).map(run => validateRun(run, input));
  const passed = (expected: string[]) => validRunSet && expected.every(id => checks.find(check => check.key === id)?.passed === true);
  const developmentPassed = passed(expectedDevelopment);
  if (!developmentPassed) reasons.push("DEVELOPMENT_ECONOMICS_FAILED_OR_INCOMPLETE");
  const registration = input.prospectiveRegistration;
  const prospectiveRegistrationValid = Boolean(registration && time(registration.registeredAtMs)
    && time(registration.startMs) && time(registration.endMs) && registration.startMs % DAY === 0
    && registration.endMs % DAY === 0 && registration.registeredAtMs >= input.registeredAtMs
    && registration.registeredAtMs <= registration.startMs && registration.endMs <= input.asOfMs
    && registration.endMs - registration.startMs >= protocol.prospective.minimumCalendarDays * DAY
    && registration.strategySourceSha256 === input.strategySourceSha256
    && registration.strategyConfigSha256 === input.strategyConfigSha256);
  const prospectivePassed = prospectiveRegistrationValid && passed(expectedProspective);
  if (!prospectivePassed) reasons.push("PROSPECTIVE_PROFIT_EVIDENCE_REQUIRED");
  return { protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, developmentPassed, prospectivePassed,
    paperActivationAllowed: developmentPassed && prospectivePassed, realOrdersAllowed: false,
    reasons, runs: checks };
}
