/** A single declared economic hypothesis. Changing it creates a new experiment. */
export declare const SPOT_TREND_SPEC: Readonly<{
    readonly version: "btc-spot-funded-weekly-trend-v1";
    readonly symbol: "BTC/USD";
    readonly movingAverageWeeks: 40;
    readonly entryBufferFraction: number;
    readonly exitBufferFraction: 0;
    readonly initialCashUsd: 100000;
    readonly maximumEntryPrincipalUsd: 1000;
    readonly entryPrincipalEquityFraction: 0.001;
    readonly maximumMarkedNotionalUsd: 1000;
    readonly maximumMarkedEquityFraction: 0.01;
    readonly maximumAccountDrawdownFraction: 0.05;
    readonly historicalLotSize: 1e-8;
    readonly historicalMinimumQuantity: 0.00005;
    readonly historicalMinimumNotionalUsd: 0.5;
    readonly historicalTickSize: 0.1;
    readonly scenarios: {
        readonly base: {
            readonly feeBps: 80;
            readonly adverseSlippageBps: 3;
            readonly additionalDelayWeeks: 0;
        };
        readonly stress: {
            readonly feeBps: 100;
            readonly adverseSlippageBps: 10;
            readonly additionalDelayWeeks: 1;
        };
    };
    readonly rules: {
        readonly signal: "LATEST_40_COMPLETED_NATIVE_WEEKS;ENTER_CLOSE_ABOVE_SMA_TIMES_1.0166;EXIT_CLOSE_BELOW_OR_EQUAL_SMA;HOLD_IN_BAND;BUFFER_REDUCES_TURNOVER_AND_IS_NOT_EXPECTED_PROFIT";
        readonly execution: "FIRST_NATIVE_WEEK_OPEN_STRICTLY_AFTER_SIGNAL_AVAILABILITY;STRESS_ONE_ADDITIONAL_WEEK;LATEST_DELAY_ELIGIBLE_STATE_REPLACES_PRIOR_INTENT_EACH_OPEN;TERMINAL_FLATTEN_AT_LAST_OPEN";
        readonly inventory: "CASH_FUNDED_LONG_OR_CASH;NO_SHORTS_BORROWING_FUNDING_PYRAMIDING_OR_ROUTINE_REBALANCING";
        readonly risk: "ENTIRE_PURCHASE_INCLUDING_FEE_IS_ENTRY_PRINCIPAL_AT_RISK;GAINS_CAN_INCREASE_MARKED_EXPOSURE;WEEKLY_MARK_CAP_REDUCTIONS_AND_5_PERCENT_ACCOUNT_DRAWDOWN_HALT;GAPS_CAN_OVERRUN_LIMITS_BETWEEN_CHECKS";
        readonly missingData: "REJECT_GAPS_DUPLICATES_AND_NONFINITE_BARS;NEVER_SYNTHESIZE_PRICES";
        readonly liquidity: "HISTORICAL_WEEKLY_VOLUME_IS_NOT_EXECUTABLE_DEPTH;REPLAY_FILLS_ARE_COSTED_PROXIES;FORWARD_PAPER_REQUIRES_FRESH_SPOT_BOOKS";
        readonly costs: "CURRENT_PUBLIC_TIER_1_FEES_APPLIED_TO_ALL_HISTORY_AS_FORWARD_COST_STRESS;NOT_HISTORICALLY_VERIFIED_ACCOUNT_FEES";
        readonly accounting: "BUY_DEBITS_PRINCIPAL_AND_FEES;SELL_CREDITS_NET_PROCEEDS;EXIT_COSTS_INCLUDED_IN_LIQUIDATION_MARKS;IDLE_CASH_ZERO_YIELD";
    };
}>;
export declare const SPOT_TREND_STUDY: Readonly<{
    readonly version: "btc-spot-funded-weekly-trend-study-v1";
    readonly startMs: number;
    readonly endMsExclusive: number;
    readonly periods: readonly [{
        readonly id: "2017-2019";
        readonly startMs: number;
        readonly endMs: number;
    }, {
        readonly id: "2020-2022";
        readonly startMs: number;
        readonly endMs: number;
    }, {
        readonly id: "2023-2026-september";
        readonly startMs: number;
        readonly endMs: number;
    }];
    readonly policies: readonly ["trend", "buy-hold", "cash"];
    readonly benchmark: "COSTED_BTC_BUY_HOLD_WITH_IDENTICAL_INITIAL_PRINCIPAL_BUDGET_STARTS_FIRST_AVAILABLE_OPEN_NOT_FIRST_BULL_SIGNAL;FIXED_UNITS_NO_MARK_CAP_REDUCTIONS_NOT_RISK_MATCHED;CASH_ZERO;5_PERCENT_ANNUAL_ON_INITIAL_ENTRY_BUDGET_OVER_FULL_WINDOW_IS_OPPORTUNITY_COST_ONLY";
    readonly minimumClosedEpisodes: 8;
    readonly bootstrap: {
        readonly blockWeeks: 13;
        readonly repetitions: 2000;
        readonly lowerQuantile: 0.05;
        readonly seed: 1226406867;
    };
    readonly researchPaperScreen: "BASE_AND_STRESS_PRIMARY_NET_ABOVE_ZERO_AND_FULL_WINDOW_5_PERCENT_ALLOCATED_CAPITAL_HURDLE;AT_LEAST_8_CLOSED_EPISODES_PER_SCENARIO;LESS_STRESS_DRAWDOWN_THAN_BUY_HOLD;NO_ACCOUNT_DRAWDOWN_HALT;ALL_RUNS_TERMINAL_FLAT;NO_PROFIT_GUARANTEE";
    readonly profitValidation: "HISTORICAL_SCREEN_IS_NOT_INDEPENDENT_PROFIT_VALIDATION;PROSPECTIVE_EVIDENCE_REQUIRED;RECENT_HISTORY_PREVIOUSLY_USED_BY_OTHER_CANDIDATES";
    readonly gridSearchAllowed: false;
    readonly liveTradingAllowed: false;
}>;
export type SpotScenario = keyof typeof SPOT_TREND_SPEC.scenarios;
export type SpotPolicy = typeof SPOT_TREND_STUDY.policies[number];
