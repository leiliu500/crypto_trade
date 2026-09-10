/** A new predeclared hypothesis following the rejected hourly experiment.
 * Parameters are not selected by the results of its development replay. */
export const PROFIT_SPEC = Object.freeze({
  version: "btc-eth-weekly-gross-forecast-inventory-v1",
  symbols: ["BTC/USD", "ETH/USD"] as const,
  dayMs: 86_400_000, hourMs: 3_600_000, weekMs: 7 * 86_400_000,
  fastLookbackDays: 7, slowLookbackDays: 90, volatilityLookbackDays: 30,
  minimumDailyVolatility: .005, featureClip: 3,
  forecastHorizonDays: 7, labelPublicationLagDays: 1,
  trainingLookbackDays: 365, minimumTrainingWeeks: 26,
  ridgeLambda: 10, bootstrapRepetitions: 256, bootstrapBlockWeeks: 4,
  bootstrapSeed: 0x6b51d927, lowerQuantile: .05, upperQuantile: .95,
  candleFinalizationDelayMs: 60_000,
  maximumSignalAgeMs: 48 * 3_600_000,
  maximumNotionalUsd: 1_000, maximumEquityFraction: .01,
  baseRiskFraction: .001, initialStopDailySigma: 4,
  maximumDrawdownFraction: .05, rollingLossFraction: .0075, sessionLossFraction: .0075,
  quantityDeadbandFraction: .25, switchImprovementFraction: .25,
  fundingReserveBpsPerDay: 3, costErrorReserveBps: 2,
  maximumQuoteAgeMs: 1_000, maximumSpreadBps: 5,
  maximumEntrySlippageBps: 3, maximumBookParticipation: .01,
  entryLatencyMs: 250, entryTtlMs: 2_000,
  interpretation: "CONDITIONAL_GROSS_MEAN_WITH_PARAMETER_UNCERTAINTY;NOT_A_RETURN_GUARANTEE",
});
