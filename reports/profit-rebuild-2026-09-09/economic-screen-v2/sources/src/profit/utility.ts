import { createHash } from "node:crypto";
import type { ProfitForecast, ProfitModelFit } from "./model.js";
import { PROFIT_SPEC as S } from "./spec.js";

/** Separate, predeclared hypothesis after v1 produced no qualifying entries.
 * The causal ridge forecast and its confidence interval remain unchanged.
 *
 * Mathematical motivation: maximizing expected log wealth, and accounting for
 * uncertain model parameters before allocating, are discussed in the primary
 * papers https://www.columbia.edu/~ww2040/PortfolioChoice96.pdf (Browne & Whitt)
 * and https://arxiv.org/abs/1803.03573 (Bauder et al.). This implementation is
 * neither paper's exact optimal policy or posterior model. Its explicit local
 * approximation is E[log(1+wR)] ≈ w*mu - w²*(variance+mu²)/2. The unconstrained
 * quadratic maximizer is mu/(variance+mu²); we use one quarter and cap at 1%.
 * Historical return volatility plus bootstrap conditional-mean variance is an
 * uncertainty proxy, not a calibrated predictive distribution or profit proof.
 */
export const PROFIT_UTILITY_SPEC = Object.freeze({
  version: "btc-eth-weekly-mean-variance-inventory-v2",
  forecastVersion: S.version,
  decision: "POSITIVE_ABSOLUTE_GROSS_MEAN_MINUS_FULL_ROUND_TRIP_COST_HURDLE",
  confidenceIntervalGate: false,
  parameterVariance: "SAMPLE_VARIANCE_OF_BOOTSTRAP_CONDITIONAL_MEAN_DECIMAL_RETURNS",
  variance: "HISTORICAL_WEEKLY_VOLATILITY_SQUARED_PLUS_PARAMETER_VARIANCE",
  fraction: "MIN(0.01,0.25*NET_MEAN/(VARIANCE+NET_MEAN_SQUARED))",
  fractionalKellyMultiplier: .25,
  maximumEquityFraction: .01,
  score: "NET_MEAN_DIVIDED_BY_SQRT_VARIANCE",
  quantityDeadbandFraction: S.quantityDeadbandFraction,
  switchImprovementFraction: S.switchImprovementFraction,
  remainingControls: "ONE_SLOT; FULL_COST_HURDLE; NOTIONAL_AND_REMAINING_RISK_CAPS; LOTS; STOPS; FUNDING_COVERAGE",
  varianceInterpretation: "HISTORICAL_VOLATILITY_AND_PARAMETER_UNCERTAINTY_PROXY_NOT_CALIBRATED_PREDICTIVE_DISTRIBUTION",
  sizingInterpretation: "FRACTIONAL_SECOND_ORDER_EXPECTED_LOG_UTILITY_APPROXIMATION_NOT_EXACT_KELLY",
  validation: "UNCHANGED_EIGHT_RUN_AFTER_COST_ECONOMIC_AND_ACCOUNTING_GATES; PRIOR_FAILURES_PRESERVED",
  winProbability: null,
  returnGuarantee: false,
  sources: ["https://www.columbia.edu/~ww2040/PortfolioChoice96.pdf", "https://arxiv.org/abs/1803.03573"],
});
export const PROFIT_UTILITY_SPEC_SHA256 = createHash("sha256").update(JSON.stringify(PROFIT_UTILITY_SPEC)).digest("hex");
export interface ProfitUtilityDecision {
  side: 1 | -1; netMeanBps: number; parameterVariance: number; variance: number;
  score: number; maximumEquityFraction: number;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const time = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)
  && value >= 0 && value <= 8_640_000_000_000_000;
const vector = (value: unknown): value is readonly [number, number, number] => Array.isArray(value)
  && value.length === 3 && value.every(finite);
const near = (left: number, right: number) => Math.abs(left - right)
  <= 1e-10 * Math.max(1e-6, Math.abs(left), Math.abs(right));
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const monday = (value: number) => time(value) && value % S.dayMs === S.candleFinalizationDelayMs
  && new Date(value).getUTCDay() === 1;
const quantile = (sorted: readonly number[], q: number) => {
  const index = (sorted.length - 1) * q, lower = Math.floor(index), weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[Math.ceil(index)]! * weight;
};

/** Allocation feasibility from one unchanged causal model forecast. A positive
 * estimated net mean is necessary, but is not evidence of realized profit.
 * The caller must further cap quantity for risk, cash, lots and execution. */
export function evaluateProfitUtility(fit: ProfitModelFit, forecast: ProfitForecast, costBps: number): ProfitUtilityDecision | null {
  if (!fit || !forecast || !finite(costBps) || costBps < 0 || fit.version !== S.version || forecast.version !== S.version
    || !sha(fit.id) || !sha(fit.inputSha256) || fit.specSha256 !== hash(S) || forecast.specSha256 !== fit.specSha256
    || !vector(fit.coefficients) || !Array.isArray(fit.bootstrapCoefficients)
    || fit.bootstrapCoefficients.length !== S.bootstrapRepetitions || !fit.bootstrapCoefficients.every(vector)
    || fit.bootstrapReplicates !== S.bootstrapRepetitions || fit.bootstrapBlockWeeks !== S.bootstrapBlockWeeks
    || !Number.isSafeInteger(fit.nWeeks) || fit.nWeeks < S.minimumTrainingWeeks
    || fit.nWeeks > Math.ceil(S.trainingLookbackDays / 7) || fit.nRows !== 2 * fit.nWeeks
    || !Number.isSafeInteger(fit.excludedWeeks) || fit.excludedWeeks < 0
    || !time(fit.fitAtMs) || !time(fit.validUntilMs) || !monday(fit.firstOriginMs) || !monday(fit.lastOriginMs)
    || fit.lastOriginMs - fit.firstOriginMs < (fit.nWeeks - 1) * S.weekMs
    || fit.firstOriginMs < fit.fitAtMs - S.trainingLookbackDays * S.dayMs
    || fit.maximumLabelEndMs !== fit.lastOriginMs - S.candleFinalizationDelayMs + S.forecastHorizonDays * S.dayMs
    || fit.maximumLabelAvailableAtMs !== fit.lastOriginMs + (S.forecastHorizonDays + S.labelPublicationLagDays) * S.dayMs
    || fit.maximumLabelAvailableAtMs > fit.fitAtMs) return null;
  const fitDate = new Date(fit.fitAtMs);
  if (fit.fitAtMs !== Date.UTC(fitDate.getUTCFullYear(), fitDate.getUTCMonth(), 1) + S.candleFinalizationDelayMs
    || fit.validUntilMs !== Date.UTC(fitDate.getUTCFullYear(), fitDate.getUTCMonth() + 1, 1) + S.candleFinalizationDelayMs) return null;
  const fitBody = { version: fit.version, fitAtMs: fit.fitAtMs, validUntilMs: fit.validUntilMs,
    nWeeks: fit.nWeeks, nRows: fit.nRows, excludedWeeks: fit.excludedWeeks,
    firstOriginMs: fit.firstOriginMs, lastOriginMs: fit.lastOriginMs,
    maximumLabelEndMs: fit.maximumLabelEndMs, maximumLabelAvailableAtMs: fit.maximumLabelAvailableAtMs,
    inputSha256: fit.inputSha256, specSha256: fit.specSha256, coefficients: fit.coefficients,
    bootstrapCoefficients: fit.bootstrapCoefficients, bootstrapBlockWeeks: fit.bootstrapBlockWeeks,
    bootstrapReplicates: fit.bootstrapReplicates };
  if (hash(fitBody) !== fit.id || forecast.modelId !== fit.id || forecast.modelInputSha256 !== fit.inputSha256
    || forecast.fitAtMs !== fit.fitAtMs || forecast.nWeeks !== fit.nWeeks
    || forecast.maximumLabelEndMs !== fit.maximumLabelEndMs || forecast.maximumLabelAvailableAtMs !== fit.maximumLabelAvailableAtMs
    || !S.symbols.includes(forecast.symbol) || !monday(forecast.decisionMs)
    || forecast.decisionMs < fit.fitAtMs || forecast.decisionMs >= fit.validUntilMs
    || forecast.availableAtMs !== forecast.decisionMs
    || forecast.expiresAtMs !== forecast.decisionMs + S.maximumSignalAgeMs
    || forecast.horizonEndMs !== forecast.decisionMs + S.weekMs
    || !sha(forecast.inputSha256) || !sha(forecast.id)
    || forecast.id !== hash({ version: S.version, modelId: fit.id, symbol: forecast.symbol,
      decisionMs: forecast.decisionMs, inputSha256: forecast.inputSha256 })
    || !vector(forecast.features) || forecast.features[0] !== 1
    || forecast.features.slice(1).some(x => Math.abs(x) > S.featureClip)
    || !finite(forecast.close) || forecast.close <= 0 || !finite(forecast.sigmaDay) || forecast.sigmaDay < S.minimumDailyVolatility
    || !finite(forecast.sigmaHorizon) || !near(forecast.sigmaHorizon, forecast.sigmaDay * Math.sqrt(S.forecastHorizonDays))
    || ![forecast.meanGrossBps, forecast.lowerGrossBps, forecast.upperGrossBps].every(finite)
    || forecast.intervalInterpretation !== "MOVING_WEEK_BLOCK_BOOTSTRAP_CONDITIONAL_MEAN_NOT_PREDICTIVE_INTERVAL"
    || forecast.winProbability !== null) return null;
  const means = fit.bootstrapCoefficients.map(beta => dot(beta, forecast.features) * forecast.sigmaHorizon);
  const meanGross = dot(fit.coefficients, forecast.features) * forecast.sigmaHorizon;
  if (!finite(meanGross) || !means.every(finite) || !near(meanGross * 10_000, forecast.meanGrossBps)) return null;
  const ordered = [...means].map(mean => mean * 10_000).sort((a, b) => a - b);
  // Authenticate interval values; their sign never acts as an entry gate.
  if (!near(quantile(ordered, S.lowerQuantile), forecast.lowerGrossBps)
    || !near(quantile(ordered, S.upperQuantile), forecast.upperGrossBps)) return null;
  const netMeanBps = Math.abs(forecast.meanGrossBps) - costBps;
  if (!(netMeanBps > 0)) return null;
  const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
  const parameterVariance = means.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (means.length - 1);
  const variance = forecast.sigmaHorizon ** 2 + parameterVariance, muNet = netMeanBps / 10_000;
  const denominator = variance + muNet ** 2;
  const score = muNet / Math.sqrt(variance);
  const maximumEquityFraction = Math.min(PROFIT_UTILITY_SPEC.maximumEquityFraction,
    PROFIT_UTILITY_SPEC.fractionalKellyMultiplier * muNet / denominator);
  if (![mean, parameterVariance, variance, denominator, score, maximumEquityFraction].every(finite)
    || parameterVariance < 0 || variance <= 0 || denominator <= 0 || maximumEquityFraction <= 0) return null;
  return { side: forecast.meanGrossBps > 0 ? 1 : -1, netMeanBps, parameterVariance, variance, score, maximumEquityFraction };
}
