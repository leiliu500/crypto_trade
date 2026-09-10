/** Fixed research gates. Unknown accounting must never coerce to a zero return. */
export interface AdaptiveAccountSummary {
  netPnlUsd: number | null;
  maximumDrawdownUsd: number | null;
  maximumOneDayLossUsd: number | null;
  completed: number;
  activeUtcDates: number;
  unknownTrades: number;
  perAsset: Array<{ symbol: string; completed: number; netPnlUsd: number | null; unknownTrades: number }>;
}
export interface AdaptiveScenarioSummary { base: AdaptiveAccountSummary; stress: AdaptiveAccountSummary; }
export const ADAPTIVE_SELECTION_RULE = Object.freeze({
  perAssetMinimumTrades: 20, portfolioMinimumTrades: 100, minimumActiveUtcDates: 40,
  maximumDrawdownUsd: 12, maximumOneDayLossUsd: 12,
  selectionUtility: "STRESS_NET_PNL_MINUS_0.5_MTM_DRAWDOWN; LEXICOGRAPHIC_ID_TIE" as const,
  assetSelection: "HIGHEST_UTILITY_ELIGIBLE_CANDIDATE_PER_ASSET_IN_2024; NO_COMBINATION_SEARCH" as const,
  portfolioRanking: "UTC_DAY_ALTERNATING" as const,
  requirePositiveBaseAndStressPerAsset: true,
  requireBeatingSelectedNonFlatBaselineInBothScenarios: true,
  finalConfidence: "BASE_PAIRED_WEEKLY_ONE_SIDED_95_PERCENT_LOWER_BOUND_POSITIVE_VS_FLAT_AND_SELECTED_BASELINE" as const,
});
const positive = (v: number | null) => v !== null && Number.isFinite(v) && v > 0;
const within = (v: number | null, cap: number) => v !== null && Number.isFinite(v) && v >= 0 && v <= cap;
function knownSafe(s: AdaptiveAccountSummary) {
  return s.netPnlUsd !== null && Number.isFinite(s.netPnlUsd) && s.unknownTrades === 0
    && within(s.maximumDrawdownUsd, ADAPTIVE_SELECTION_RULE.maximumDrawdownUsd)
    && within(s.maximumOneDayLossUsd, ADAPTIVE_SELECTION_RULE.maximumOneDayLossUsd);
}
export function adaptiveUtility(s: AdaptiveAccountSummary): number {
  return s.unknownTrades !== 0 || s.netPnlUsd === null || s.maximumDrawdownUsd === null
    || !Number.isFinite(s.netPnlUsd) || !Number.isFinite(s.maximumDrawdownUsd) ? -Infinity
    : s.netPnlUsd - .5 * s.maximumDrawdownUsd;
}
export function adaptiveAssetEligible(s: AdaptiveScenarioSummary, symbol: string) {
  return [s.base, s.stress].every(account => {
    const asset = account.perAsset.find(row => row.symbol === symbol);
    return knownSafe(account) && positive(account.netPnlUsd) && asset !== undefined && asset.unknownTrades === 0
      && positive(asset.netPnlUsd) && asset.completed >= ADAPTIVE_SELECTION_RULE.perAssetMinimumTrades;
  });
}
export function adaptivePortfolioGates(s: AdaptiveScenarioSummary, baseline: AdaptiveScenarioSummary) {
  return {
    fullPeriodKnownAndRiskWithinLimits: [s.base, s.stress].every(knownSafe),
    sufficientTrades: [s.base, s.stress].every(a => a.completed >= ADAPTIVE_SELECTION_RULE.portfolioMinimumTrades
      && a.activeUtcDates >= ADAPTIVE_SELECTION_RULE.minimumActiveUtcDates
      && ["BTC/USD", "ETH/USD"].every(symbol => (a.perAsset.find(row => row.symbol === symbol)?.completed ?? 0)
        >= ADAPTIVE_SELECTION_RULE.perAssetMinimumTrades)),
    positiveBaseAndStressForBothAssets: [s.base, s.stress].every(a => positive(a.netPnlUsd)
      && ["BTC/USD", "ETH/USD"].every(symbol => {
        const row = a.perAsset.find(row => row.symbol === symbol);
        return row !== undefined && row.unknownTrades === 0 && positive(row.netPnlUsd);
      })),
    beatsSelectedBaseline: (["base", "stress"] as const).every(scenario => {
      const a = s[scenario].netPnlUsd, b = baseline[scenario].netPnlUsd;
      return a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && a > b;
    }),
  };
}
