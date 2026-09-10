import { createHash } from "node:crypto";

/** Sealed before any outcome of this distinct carry hypothesis is calculated.
 * Conservative research assumptions are not authenticated venue/account terms.
 * This coarse spot-week/perpetual-hour proxy cannot authorize trading. */
export const HORIZON_CARRY_SPEC = Object.freeze({
  version: "btc-matched-quantity-long-horizon-carry-v1",
  symbol: "BTC/USD",
  scope: "DEVELOPMENT_ECONOMIC_SCREEN_ONLY",
  hypothesisRegistry: "SEPARATE_FROM_CONCURRENT_55D_CHANNEL_TREND_HYPOTHESIS;NO_OUTCOME_SELECTED_FALLBACK",
  initialEquityUsd: 100_000,
  hourMs: 3_600_000,
  dayMs: 86_400_000,
  weekMs: 604_800_000,
  yearDays: 365,
  forecastLookbackDays: 90,
  forecastHaircutFraction: .5,
  forecastUnits: "MEAN_MATURED_ABSOLUTE_USD_PER_BTC_HOUR",
  forecastAnnualization: "MEAN_ABSOLUTE_RATE*8760/DECISION_PERPETUAL_PRICE",
  holdingDays: 180,
  fundingExitLookbackDays: 28,
  fundingExitConsecutiveWeeks: 2,
  decisionUtcWeekday: 4,
  decisionDelayMs: 60_000,
  entryDelayWeeks: 1,
  spotIntervalMinutes: 10_080,
  perpetualIntervalMinutes: 60,
  maximumLegNotionalUsd: 1_000,
  maximumLegEquityFraction: .01,
  collateralMultiple: 2,
  collateralGuardFraction: .20,
  annualCapitalHurdleFraction: .05,
  basisUnwindReserveBps: 75,
  quantityStepBtc: .0001,
  minimumQuantityBtc: .0001,
  fixedMatchedQuantity: true,
  automaticCollateralTransfers: false,
  capitalDefinition: "ALL_IN_SPOT_PURCHASE_CASH_PLUS_TWICE_PERPETUAL_ENTRY_NOTIONAL",
  quantityPolicy: "SHARED_LOT_FLOOR_AT_ENTRY;MIN_OF_BOTH_LEG_NOTIONAL_AND_AVAILABLE_CAPITAL_CAPS;NO_ADD_OR_REBALANCE",
  maximumLegNotionalAppliesAt: "ENTRY;MARKED_EXPOSURE_REPORTED_SEPARATELY",
  collateralGuardPolicy: "HOURLY_ADVERSE_PERPETUAL_HIGH_MARK;EXIT_NEXT_ELIGIBLE_SPOT_WEEK_OPEN;ANY_INTERVENING_GUARD_BREACH_FAILS",
  terminalPolicy: "FLATTEN_AT_LAST_SPOT_WEEK_OPEN_WHOSE_WHOLE_BAR_ENDS_BY_WINDOW_END;DISCLOSE_HORIZON_TRUNCATION",
  allowTruncatedHorizonEntries: true,
  sameBoundaryExitAndReentry: false,
  postExitEntryPolicy: "NEW_CAUSAL_WEEKLY_DECISION_AND_NEXT_SOURCE_WEEK_OPEN_REQUIRED",
  fundingKnownAt: "MAPPED_INTERVAL_END",
  actualFeeVerified: false,
  historicalMarginVerified: false,
  evidenceKind: "INDEPENDENT_SPOT_WEEKLY_TRADES_AND_PERPETUAL_HOURLY_CANDLE_PROXY",
  benchmark: "5_PERCENT_SIMPLE_ANNUAL_HURDLE_ON_ACTUAL_COMMITTED_CAPITAL_FOR_ACTUAL_HOLDING_TIME;NOT_CREDITED_CASH_INTEREST",
  scenarios: Object.freeze({
    base: Object.freeze({ spotFeeBps: 80, perpetualFeeBps: 5, slippageBpsPerExecution: 2 }),
    stress: Object.freeze({ spotFeeBps: 100, perpetualFeeBps: 7.5, slippageBpsPerExecution: 5 }),
  }),
  fundingEndShiftHours: Object.freeze([0, 1] as const),
  windows: Object.freeze([
    Object.freeze({ id: "development-2024", startMs: 1_704_067_200_000, endMs: 1_735_689_600_000 }),
    Object.freeze({ id: "confirmation-2025-h1", startMs: 1_735_689_600_000, endMs: 1_751_328_000_000 }),
  ] as const),
  acceptance: Object.freeze({
    minimumCompletedCyclesPerWindowScenario: 1,
    netFundedCashMustBeStrictlyPositive: true,
    capitalBenchmarkExcessMustBeStrictlyPositive: true,
    allEightRunsRequired: true,
    allMarginAndSourceEvidenceKnown: true,
    noMissingHeldPriceOrFunding: true,
    noUnresolvedLegsOrCollateralGuardBreaches: true,
    historicalPositiveProxyIsInsufficientForExecution: true,
    fullValidationAllowed: false,
    runtimeActivationAllowed: false,
    realOrdersAllowed: false,
    futureProfitGuaranteed: false,
  }),
} as const);

export const HORIZON_CARRY_SPEC_SHA256 = createHash("sha256")
  .update(JSON.stringify(HORIZON_CARRY_SPEC)).digest("hex");
export type HorizonCarryScenario = keyof typeof HORIZON_CARRY_SPEC.scenarios;
export type HorizonFundingEndShiftHours = typeof HORIZON_CARRY_SPEC.fundingEndShiftHours[number];
export type HorizonCarryWindow = typeof HORIZON_CARRY_SPEC.windows[number];
export type HorizonCarryWindowId = HorizonCarryWindow["id"];
