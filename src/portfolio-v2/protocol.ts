import { PORTFOLIO_STUDY_PROTOCOL as V1, PORTFOLIO_PERIODS, PORTFOLIO_SCENARIOS,
  type PortfolioEvidence } from "../portfolio/protocol.js";
import type { PortfolioPolicy } from "../portfolio/types.js";
import { RISK_SPEC } from "./risk.js";

export { PORTFOLIO_PERIODS, PORTFOLIO_SCENARIOS };
export const CANDIDATES = Object.freeze(["sign-trend-90d", "multiscale-trend"] as const);
export type CandidatePolicy = typeof CANDIDATES[number];
export const POLICIES: readonly PortfolioPolicy[] = Object.freeze([
  "multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat",
]);
export const UNGOVERNED_POLICIES: readonly CandidatePolicy[] = Object.freeze(["multiscale-trend", "sign-trend-90d"]);
export const RISK_STUDY_PROTOCOL = Object.freeze({
  version: "btc-eth-risk-governed-portfolio-study-v2", strategy: V1.strategy, risk: RISK_SPEC,
  periods: PORTFOLIO_PERIODS, scenarios: PORTFOLIO_SCENARIOS, policies: POLICIES,
  candidatePolicies: CANDIDATES, ungovernedAblations: UNGOVERNED_POLICIES,
  priorExposure: V1.priorExposure,
  reasonForNewProtocol: "V1_MULTISCALE_FAILED_DRAWDOWN_AND_SIMPLE_RULE_COMPARISON;V1_RESULTS_REMAIN_FAILED",
  purpose: "SELECT_A_RISK_GOVERNED_STRATEGY_ON_DEVELOPMENT_DATA;THE_SIMPLE_RULE_CAN_WIN",
  economics: V1.economics, fundingTiming: V1.fundingTiming, unavailableFunding: V1.unavailableFunding,
  execution: V1.execution, terminalPolicy: V1.terminalPolicy, initialization: V1.initialization,
  riskObservation: "PRE_AND_POST_TRADE_LIQUIDATION_EQUITY_INCLUDING_OBSERVED_SIGNED_FUNDING_AND_EXIT_COSTS",
  fillSequencing: "BTC_THEN_ETH_WITH_POST_FILL_RISK_OBSERVATION;REMAINING_INCREASES_CANCEL_IF_CURRENT_CAP_EXCEEDED;NO_EXTRA_PHASE",
  dailyBoundary: "BOUNDARY_PRICE_AND_FUNDING_BELONG_TO_PREVIOUS_DAY;RESET_REFERENCE_BEFORE_NEW_DAY_FILLS",
  unknownAccounting: "PERMANENT_RISK_HALT_AND_FLATTEN_ON_EXECUTABLE_QUOTES;NET_REMAINS_UNKNOWN",
  selection: "ELIGIBLE_CANDIDATE_WITH_MAXIMUM_MINIMUM_SCENARIO_UTILITY;EXACT_TIE_PREFERS_SIMPLE_90_DAY_RULE",
  selectionFreeze: "DEVELOPMENT_SELECTION_SEALED_BEFORE_2025;NO_RESELECTION_IN_CONFIRM_OR_TEST",
  stageInitialization: "EACH_DECLARED_PERIOD_STARTS_FLAT_WITH_100000_USD_AND_A_FRESH_RISK_STATE;NOT_A_CONTINUOUS_MULTIYEAR_EQUITY_CURVE",
  utility: "NET_PNL_USD_MINUS_HALF_MAXIMUM_OF_MARK_AND_LIQUIDATION_DRAWDOWN_USD",
  gates: Object.freeze({
    minimumPortfolioExposureHours: V1.gates.minimumPortfolioExposureHours,
    minimumPerAssetExposureHours: V1.gates.minimumPerAssetExposureHours,
    minimumTargetCoverageFraction: V1.gates.minimumTargetCoverageFraction,
    maximumDrawdownUsd: 3, maximumLiquidationDrawdownUsd: 3, maximumOneDayLossUsd: 1.2,
    maximumObservedDailyLiquidationLossUsd: 1.2,
    positiveNetForPortfolioAndBothAssetsInEveryScenario: true,
    strictlyPositiveUtilityEveryScenario: true,
    complexPolicyMustBeatGovernedSimpleUtilityInEveryScenario: true,
    simpleWinner: "SIMPLE_RULE_SELECTED;NO_INCREMENTAL_ALPHA_OR_MODEL_SUPERIORITY_CLAIM",
    finalEvidence: "PAIRED_WEEKLY_LOWER_95_ABOVE_ZERO_VS_FLAT_ALL_SCENARIOS;ALSO_VS_GOVERNED_SIMPLE_IF_COMPLEX_SELECTED",
    intervalCaveat: "NOMINAL_BLOCK_BOOTSTRAP;NOT_MULTIPLICITY_ADJUSTED;NO_GLOBAL_BEST_MODEL_CLAIM",
    otherComparisons: "GOVERNED_CONSTANT_ASSETS_AND_UNGOVERNED_SIGNALS_REPORTED;NOT_PROMOTION_THRESHOLDS",
  }),
  noParameterSearch: true, automaticPromotion: false, realOrdersAllowed: false,
  limitations: [V1.limitation,
    "Reducing exposure cannot create predictive edge. Price gaps and missing execution liquidity can overshoot risk budgets.",
    "2024 and 2025 have already been studied; the 2026 reserved period is required for later evidence.",
    "Minimum lots can leave capital idle. Cash lock is retained rather than resetting losses to resume trading."],
});

export interface RiskEvidence extends PortfolioEvidence {
  maximumLiquidationDrawdownUsd: number | null;
  maximumObservedDailyLiquidationLossUsd: number | null;
}
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
export function riskUtility(e: RiskEvidence): number | null {
  return e.known && finite(e.netPnlUsd) && finite(e.maximumDrawdownUsd) && finite(e.maximumLiquidationDrawdownUsd)
    ? e.netPnlUsd - .5 * Math.max(e.maximumDrawdownUsd, e.maximumLiquidationDrawdownUsd) : null;
}
export function riskEvidenceGates(e: RiskEvidence) {
  const g = RISK_STUDY_PROTOCOL.gates, utility = riskUtility(e);
  return {
    completeAccounting: e.known && finite(e.netPnlUsd) && finite(e.maximumDrawdownUsd)
      && finite(e.maximumLiquidationDrawdownUsd) && finite(e.maximumOneDayLossUsd)
      && finite(e.maximumObservedDailyLiquidationLossUsd),
    targetCoverage: Number.isFinite(e.targetCoverageFraction) && e.targetCoverageFraction >= g.minimumTargetCoverageFraction,
    meaningfulExposure: e.exposureHours >= g.minimumPortfolioExposureHours
      && Object.values(e.perAsset).every(a => a.exposureHours >= g.minimumPerAssetExposureHours),
    riskWithinLimits: finite(e.maximumDrawdownUsd) && e.maximumDrawdownUsd >= 0 && e.maximumDrawdownUsd <= g.maximumDrawdownUsd
      && finite(e.maximumLiquidationDrawdownUsd) && e.maximumLiquidationDrawdownUsd >= 0
      && e.maximumLiquidationDrawdownUsd <= g.maximumLiquidationDrawdownUsd
      && finite(e.maximumOneDayLossUsd) && e.maximumOneDayLossUsd >= 0 && e.maximumOneDayLossUsd <= g.maximumOneDayLossUsd
      && finite(e.maximumObservedDailyLiquidationLossUsd) && e.maximumObservedDailyLiquidationLossUsd >= 0
      && e.maximumObservedDailyLiquidationLossUsd <= g.maximumObservedDailyLiquidationLossUsd,
    positiveNetBothAssetsAndPortfolio: finite(e.netPnlUsd) && e.netPnlUsd > 0
      && Object.values(e.perAsset).every(a => finite(a.netPnlUsd) && a.netPnlUsd > 0),
    positiveUtility: utility !== null && utility > 0,
  };
}
export interface PolicyScenarioEvidence { policy: CandidatePolicy; scenario: string; evidence: RiskEvidence }
export function selectRiskPolicy(rows: readonly PolicyScenarioEvidence[]) {
  if (rows.length !== CANDIDATES.length * PORTFOLIO_SCENARIOS.length
    || rows.some(r => !CANDIDATES.includes(r.policy) || !PORTFOLIO_SCENARIOS.some(s => s.id === r.scenario)))
    throw new Error("RISK_SELECTION_REQUIRES_EXACT_SCENARIO_SET");
  const evaluations = CANDIDATES.map(policy => {
    const scenarios = PORTFOLIO_SCENARIOS.map(s => {
      const matching = rows.filter(r => r.policy === policy && r.scenario === s.id);
      if (matching.length !== 1) throw new Error("RISK_SELECTION_REQUIRES_EXACT_SCENARIO_SET");
      const evidence = matching[0]!.evidence;
      const reference = rows.filter(r => r.policy === "sign-trend-90d" && r.scenario === s.id);
      if (reference.length !== 1) throw new Error("RISK_SELECTION_MISSING_SIMPLE_REFERENCE");
      const utility = riskUtility(evidence), simpleUtility = riskUtility(reference[0]!.evidence);
      const gates = { ...riskEvidenceGates(evidence), comparisonSatisfied: policy === "sign-trend-90d"
        || utility !== null && simpleUtility !== null && utility > simpleUtility };
      return { scenario: s.id, gates, utility, simpleUtility };
    });
    return { policy, eligible: scenarios.every(s => Object.values(s.gates).every(Boolean)), scenarios,
      worstScenarioUtility: scenarios.every(s => s.utility !== null) ? Math.min(...scenarios.map(s => s.utility!)) : null };
  });
  const eligible = evaluations.filter(e => e.eligible).sort((a, b) => b.worstScenarioUtility! - a.worstScenarioUtility!
    || CANDIDATES.indexOf(a.policy) - CANDIDATES.indexOf(b.policy));
  const selected = eligible[0]?.policy ?? null;
  return { selected, evaluations, incrementalAlphaClaim: false,
    selectionMeaning: selected === "sign-trend-90d" ? "SIMPLE_RULE_SELECTED;NO_COMPLEX_MODEL_SUPERIORITY"
      : selected === "multiscale-trend" ? "COMPLEX_POLICY_DEVELOPMENT_WINNER_REQUIRES_LATER_CONFIRMATION" : "NO_ELIGIBLE_POLICY" };
}
