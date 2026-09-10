/** A single declared economic hypothesis. Changing it creates a new experiment. */
export const SPOT_TREND_SPEC = Object.freeze({
  version: "btc-spot-funded-weekly-trend-v1",
  symbol: "BTC/USD", movingAverageWeeks: 40,
  entryBufferFraction: 2 * (80 + 3) / 10_000,
  exitBufferFraction: 0,
  initialCashUsd: 100_000,
  maximumEntryPrincipalUsd: 1_000,
  entryPrincipalEquityFraction: .001,
  maximumMarkedNotionalUsd: 1_000,
  maximumMarkedEquityFraction: .01,
  maximumAccountDrawdownFraction: .05,
  historicalLotSize: .00000001,
  historicalMinimumQuantity: .00005,
  historicalMinimumNotionalUsd: .5,
  historicalTickSize: .1,
  scenarios: {
    base: { feeBps: 80, adverseSlippageBps: 3, additionalDelayWeeks: 0 },
    stress: { feeBps: 100, adverseSlippageBps: 10, additionalDelayWeeks: 1 },
  },
  rules: {
    signal: "LATEST_40_COMPLETED_NATIVE_WEEKS;ENTER_CLOSE_ABOVE_SMA_TIMES_1.0166;EXIT_CLOSE_BELOW_OR_EQUAL_SMA;HOLD_IN_BAND;BUFFER_REDUCES_TURNOVER_AND_IS_NOT_EXPECTED_PROFIT",
    execution: "FIRST_NATIVE_WEEK_OPEN_STRICTLY_AFTER_SIGNAL_AVAILABILITY;STRESS_ONE_ADDITIONAL_WEEK;LATEST_DELAY_ELIGIBLE_STATE_REPLACES_PRIOR_INTENT_EACH_OPEN;TERMINAL_FLATTEN_AT_LAST_OPEN",
    inventory: "CASH_FUNDED_LONG_OR_CASH;NO_SHORTS_BORROWING_FUNDING_PYRAMIDING_OR_ROUTINE_REBALANCING",
    risk: "ENTIRE_PURCHASE_INCLUDING_FEE_IS_ENTRY_PRINCIPAL_AT_RISK;GAINS_CAN_INCREASE_MARKED_EXPOSURE;WEEKLY_MARK_CAP_REDUCTIONS_AND_5_PERCENT_ACCOUNT_DRAWDOWN_HALT;GAPS_CAN_OVERRUN_LIMITS_BETWEEN_CHECKS",
    missingData: "REJECT_GAPS_DUPLICATES_AND_NONFINITE_BARS;NEVER_SYNTHESIZE_PRICES",
    liquidity: "HISTORICAL_WEEKLY_VOLUME_IS_NOT_EXECUTABLE_DEPTH;REPLAY_FILLS_ARE_COSTED_PROXIES;FORWARD_PAPER_REQUIRES_FRESH_SPOT_BOOKS",
    costs: "CURRENT_PUBLIC_TIER_1_FEES_APPLIED_TO_ALL_HISTORY_AS_FORWARD_COST_STRESS;NOT_HISTORICALLY_VERIFIED_ACCOUNT_FEES",
    accounting: "BUY_DEBITS_PRINCIPAL_AND_FEES;SELL_CREDITS_NET_PROCEEDS;EXIT_COSTS_INCLUDED_IN_LIQUIDATION_MARKS;IDLE_CASH_ZERO_YIELD",
  },
} as const);

export const SPOT_TREND_STUDY = Object.freeze({
  version: "btc-spot-funded-weekly-trend-study-v1",
  startMs: Date.UTC(2017, 0, 1), endMsExclusive: Date.UTC(2026, 8, 10),
  periods: [
    { id: "2017-2019", startMs: Date.UTC(2017, 0, 1), endMs: Date.UTC(2020, 0, 1) },
    { id: "2020-2022", startMs: Date.UTC(2020, 0, 1), endMs: Date.UTC(2023, 0, 1) },
    { id: "2023-2026-september", startMs: Date.UTC(2023, 0, 1), endMs: Date.UTC(2026, 8, 10) },
  ],
  policies: ["trend", "buy-hold", "cash"] as const,
  benchmark: "COSTED_BTC_BUY_HOLD_WITH_IDENTICAL_INITIAL_PRINCIPAL_BUDGET_STARTS_FIRST_AVAILABLE_OPEN_NOT_FIRST_BULL_SIGNAL;FIXED_UNITS_NO_MARK_CAP_REDUCTIONS_NOT_RISK_MATCHED;CASH_ZERO;5_PERCENT_ANNUAL_ON_INITIAL_ENTRY_BUDGET_OVER_FULL_WINDOW_IS_OPPORTUNITY_COST_ONLY",
  minimumClosedEpisodes: 8,
  bootstrap: { blockWeeks: 13, repetitions: 2_000, lowerQuantile: .05, seed: 0x49197bd3 },
  researchPaperScreen: "BASE_AND_STRESS_PRIMARY_NET_ABOVE_ZERO_AND_FULL_WINDOW_5_PERCENT_ALLOCATED_CAPITAL_HURDLE;AT_LEAST_8_CLOSED_EPISODES_PER_SCENARIO;LESS_STRESS_DRAWDOWN_THAN_BUY_HOLD;NO_ACCOUNT_DRAWDOWN_HALT;ALL_RUNS_TERMINAL_FLAT;NO_PROFIT_GUARANTEE",
  profitValidation: "HISTORICAL_SCREEN_IS_NOT_INDEPENDENT_PROFIT_VALIDATION;PROSPECTIVE_EVIDENCE_REQUIRED;RECENT_HISTORY_PREVIOUSLY_USED_BY_OTHER_CANDIDATES",
  gridSearchAllowed: false, liveTradingAllowed: false,
} as const);

export type SpotScenario = keyof typeof SPOT_TREND_SPEC.scenarios;
export type SpotPolicy = typeof SPOT_TREND_STUDY.policies[number];
