import { PORTFOLIO_SPEC, type Pair, type PortfolioPolicy } from "./types.js";

export const PORTFOLIO_PERIODS = Object.freeze({
  develop: { startMs: Date.parse("2024-01-01T00:00:00Z"), endMs: Date.parse("2025-01-01T00:00:00Z") },
  confirm: { startMs: Date.parse("2025-01-01T00:00:00Z"), endMs: Date.parse("2026-01-01T00:00:00Z") },
  test: { startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2026-08-01T00:00:00Z") },
});
export type PortfolioStage = keyof typeof PORTFOLIO_PERIODS;
export const PORTFOLIO_POLICIES: readonly PortfolioPolicy[] = Object.freeze([
  "multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat",
]);
export const PORTFOLIO_SCENARIOS = Object.freeze([
  Object.freeze({ id: "base-source-plus-hour", delayHours: 1, feeBps: 5, slippageBps: 1.5,
    fundingShiftMs: 0 as const, extraFundingBpsPerDay: 0 }),
  Object.freeze({ id: "base-source-as-end", delayHours: 1, feeBps: 5, slippageBps: 1.5,
    fundingShiftMs: -3_600_000 as const, extraFundingBpsPerDay: 0 }),
  Object.freeze({ id: "stress-source-plus-hour", delayHours: 2, feeBps: 7.5, slippageBps: 3,
    fundingShiftMs: 0 as const, extraFundingBpsPerDay: 1 }),
  Object.freeze({ id: "stress-source-as-end", delayHours: 2, feeBps: 7.5, slippageBps: 3,
    fundingShiftMs: -3_600_000 as const, extraFundingBpsPerDay: 1 }),
]);

export const PORTFOLIO_STUDY_PROTOCOL = Object.freeze({
  version: "btc-eth-persistent-target-study-v1", strategy: PORTFOLIO_SPEC,
  periods: PORTFOLIO_PERIODS, policies: PORTFOLIO_POLICIES, scenarios: PORTFOLIO_SCENARIOS,
  candidate: "multiscale-trend", comparisonRule: "sign-trend-90d",
  priorExposure: "2024_AND_2025_PREVIOUSLY_STUDIED;2026_JAN_JUL_RESERVED;AUGUST_EXCLUDED",
  initialization: "361_CONSECUTIVE_COMPLETED_PAIRED_UTC_DAILY_CLOSES;NO_FITTED_LABEL_BANK",
  economics: "SIGNED_ARCHIVED_ABSOLUTE_FUNDING_CASH_FLOWS;ALL_FOUR_SCENARIOS_REPORTED",
  fundingTiming: "SOURCE_PLUS_HOUR_AND_SOURCE_AS_END_ARE_UNVERIFIED_SENSITIVITIES_NOT_PROVEN_BOUNDS",
  unavailableFunding: "ANY_MISSING_REQUIRED_RATE_DURING_EXPOSURE_MAKES_ACCOUNTING_UNKNOWN",
  execution: "MAX_ACTUAL_TARGET_AVAILABILITY_AND_DECISION_PLUS_DELAY;ONE_PHASE_PER_HOUR;REDUCTIONS_CONFIRMED_BEFORE_ADDITIONS",
  terminalPolicy: "REQUEST_FLAT_FROM_END_MINUS_48H;RETRY_UNTIL_END;UNRESOLVED_INVENTORY_IS_UNKNOWN",
  cap: "12_USD_SHARED_BTC_ETH_EXECUTABLE_GROSS_NOTIONAL_AT_ADJUSTMENT;MARK_DRIFT_REQUIRES_REDUCTION",
  baselineMeaning: "CONSTANT_BTC_ETH_ARE_CAPPED_CONSTANT_USD_TARGETS_NOT_LITERAL_FIXED_UNIT_BUY_AND_HOLD",
  utility: "NET_PNL_USD_MINUS_HALF_MAXIMUM_DRAWDOWN_USD",
  gates: Object.freeze({
    minimumPortfolioExposureHours: 90 * 24, minimumPerAssetExposureHours: 30 * 24,
    minimumTargetCoverageFraction: .99, maximumDrawdownUsd: 3, maximumOneDayLossUsd: 1.2,
    positiveNetForPortfolioAndBothAssetsInEveryScenario: true,
    requireUtilityAboveFlatAndSignTrendInEveryScenario: true,
    passiveBenchmarks: "REPORT_SAME_COST_COMPARISONS;NOT_A_CLAIM_OF_PASSIVE_BENCHMARK_OUTPERFORMANCE",
    finalEvidence: "PAIRED_WEEKLY_95_PERCENT_LOWER_BOUND_ABOVE_ZERO_VS_FLAT_AND_SIGN_TREND_IN_ALL_SCENARIOS",
  }),
  noParameterSearch: true, realOrdersAllowed: false, automaticPromotion: false,
  limitation: "Historical candle execution and unresolved funding timing cannot certify actual venue fill profitability.",
});

export interface PortfolioEvidence {
  known: boolean; netPnlUsd: number | null; maximumDrawdownUsd: number | null;
  maximumOneDayLossUsd: number | null; exposureHours: number; targetCoverageFraction: number;
  perAsset: Pair<{ netPnlUsd: number | null; exposureHours: number }>;
}
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
export function portfolioEvidenceUtility(e: PortfolioEvidence): number | null {
  return e.known && finite(e.netPnlUsd) && finite(e.maximumDrawdownUsd)
    ? e.netPnlUsd - .5 * e.maximumDrawdownUsd : null;
}
export function portfolioEvidenceGates(candidate: PortfolioEvidence, reference: PortfolioEvidence) {
  const g = PORTFOLIO_STUDY_PROTOCOL.gates;
  const utility = portfolioEvidenceUtility(candidate), baselineUtility = portfolioEvidenceUtility(reference);
  return {
    completeAccounting: candidate.known && reference.known && finite(candidate.netPnlUsd)
      && finite(reference.netPnlUsd) && finite(candidate.maximumDrawdownUsd) && finite(candidate.maximumOneDayLossUsd),
    targetCoverage: Number.isFinite(candidate.targetCoverageFraction)
      && candidate.targetCoverageFraction >= g.minimumTargetCoverageFraction,
    meaningfulExposure: candidate.exposureHours >= g.minimumPortfolioExposureHours
      && Object.values(candidate.perAsset).every(a => a.exposureHours >= g.minimumPerAssetExposureHours),
    riskWithinLimits: finite(candidate.maximumDrawdownUsd) && candidate.maximumDrawdownUsd >= 0
      && candidate.maximumDrawdownUsd <= g.maximumDrawdownUsd
      && finite(candidate.maximumOneDayLossUsd) && candidate.maximumOneDayLossUsd >= 0
      && candidate.maximumOneDayLossUsd <= g.maximumOneDayLossUsd,
    positiveNetBothAssetsAndPortfolio: finite(candidate.netPnlUsd) && candidate.netPnlUsd > 0
      && Object.values(candidate.perAsset).every(a => finite(a.netPnlUsd) && a.netPnlUsd > 0),
    utilityAboveFlatAndSimpleRule: utility !== null && baselineUtility !== null
      && utility > 0 && utility > baselineUtility,
  };
}
