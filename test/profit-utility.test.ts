import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fitProfitModel, forecastProfitModel, type ProfitDailyClose,
  type ProfitForecast, type ProfitModelFit } from "../src/profit/model.js";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { evaluateProfitUtility, PROFIT_UTILITY_SPEC as U, PROFIT_UTILITY_SPEC_SHA256 } from "../src/profit/utility.js";

const START = Date.UTC(2019, 0, 1), FIT = Date.UTC(2020, 5, 1) + S.candleFinalizationDelayMs;
const closes: ProfitDailyClose[] = Array.from({ length: 560 }, (_, i) => S.symbols.map(symbol => ({
  symbol, closeMs: START + i * S.dayMs, close: 10_000 }))).flat();
const original = fitProfitModel(closes, FIT)!;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected)
  <= 1e-10 * Math.max(1e-9, Math.abs(expected)), `${actual} != ${expected}`);
/** Controlled coefficients are synthetic unit-test inputs, not observed alpha.
 * Refit IDs and forecasts retain the production model's identity convention. */
function fixture(meanGrossBps = 37.01, bootstrapSpreadBps = 0) {
  const fit = structuredClone(original), scale = S.minimumDailyVolatility * Math.sqrt(S.forecastHorizonDays) * 10_000;
  fit.coefficients = [meanGrossBps / scale, 0, 0];
  fit.bootstrapCoefficients = Array.from({ length: S.bootstrapRepetitions }, (_, i) =>
    [(meanGrossBps + (i % 2 ? 1 : -1) * bootstrapSpreadBps) / scale, 0, 0] as const);
  const { id: _oldId, ...body } = fit; fit.id = hash(body);
  const forecast = forecastProfitModel(fit, closes, FIT)![0]!;
  return { fit, forecast };
}

test("utility uses decimal-return sample variance and the second-order denominator before applying the quarter fraction", () => {
  const { fit, forecast } = fixture(37.01, 10), costBps = 37;
  const result = evaluateProfitUtility(fit, forecast, costBps)!;
  const netMean = (forecast.meanGrossBps - costBps) / 10_000;
  const parameterVariance = (10 / 10_000) ** 2 * S.bootstrapRepetitions / (S.bootstrapRepetitions - 1);
  const variance = S.minimumDailyVolatility ** 2 * 7 + parameterVariance;
  near(result.parameterVariance, parameterVariance); near(result.variance, variance);
  near(result.maximumEquityFraction, .25 * netMean / (variance + netMean ** 2));
  near(result.score, netMean / Math.sqrt(variance));
  assert.equal(result.side, 1); assert.ok(result.maximumEquityFraction > 0 && result.maximumEquityFraction < .01);
  assert.equal(U.confidenceIntervalGate, false); assert.equal(U.winProbability, null); assert.equal(U.returnGuarantee, false);
  assert.match(PROFIT_UTILITY_SPEC_SHA256, /^[a-f0-9]{64}$/);
});

test("increasing parameter uncertainty reduces the utility allocation without changing the gross mean", () => {
  const low = fixture(37.01, 1), high = fixture(37.01, 500);
  const a = evaluateProfitUtility(low.fit, low.forecast, 37)!, b = evaluateProfitUtility(high.fit, high.forecast, 37)!;
  near(low.forecast.meanGrossBps, high.forecast.meanGrossBps);
  assert.ok(b.parameterVariance > a.parameterVariance); assert.ok(b.variance > a.variance);
  assert.ok(b.maximumEquityFraction < a.maximumEquityFraction); assert.ok(b.score < a.score);
});

test("a conditional-mean confidence interval crossing zero does not veto a positive after-cost utility allocation", () => {
  const { fit, forecast } = fixture(50, 100);
  assert.ok(forecast.lowerGrossBps < 0 && forecast.upperGrossBps > 0);
  const result = evaluateProfitUtility(fit, forecast, 37)!;
  assert.equal(result.side, 1); near(result.netMeanBps, 13);
  assert.equal(result.maximumEquityFraction, .01, "the hard equity cap limits a larger approximate Kelly fraction");
});

test("long and short use equal positive net-mean sizing while zero or negative net means remain ineligible", () => {
  const long = fixture(37.01, 10), short = fixture(-37.01, 10);
  const a = evaluateProfitUtility(long.fit, long.forecast, 37)!, b = evaluateProfitUtility(short.fit, short.forecast, 37)!;
  assert.equal(a.side, 1); assert.equal(b.side, -1); near(a.maximumEquityFraction, b.maximumEquityFraction);
  near(a.netMeanBps, b.netMeanBps); near(a.score, b.score);
  assert.equal(evaluateProfitUtility(long.fit, long.forecast, long.forecast.meanGrossBps), null);
  assert.equal(evaluateProfitUtility(long.fit, long.forecast, 38), null);
  const zero = fixture(0, 0); assert.equal(evaluateProfitUtility(zero.fit, zero.forecast, 0), null);
  for (const cost of [-1, NaN, Infinity]) assert.equal(evaluateProfitUtility(long.fit, long.forecast, cost), null);
});

test("fit hashes and causal identity prevent coefficient replacement, borrowed forecasts and unreconciled metadata", () => {
  const mutations: Array<(fit: ProfitModelFit, forecast: ProfitForecast) => void> = [
    fit => { fit.coefficients = [100, 0, 0]; },
    fit => { fit.bootstrapCoefficients = [[100, 0, 0], ...fit.bootstrapCoefficients.slice(1)]; },
    fit => { fit.id = "f".repeat(64); }, fit => { fit.inputSha256 = "f".repeat(64); },
    fit => { fit.nWeeks = 1; }, fit => { fit.nRows++; }, fit => { fit.bootstrapReplicates--; },
    fit => { fit.validUntilMs = FIT; }, fit => { fit.maximumLabelAvailableAtMs = FIT + S.dayMs; },
    (_fit, f) => { f.modelId = "f".repeat(64); }, (_fit, f) => { f.modelInputSha256 = "f".repeat(64); },
    (_fit, f) => { f.id = "f".repeat(64); }, (_fit, f) => { f.specSha256 = "f".repeat(64); },
    (_fit, f) => { f.availableAtMs++; }, (_fit, f) => { f.expiresAtMs++; },
    (_fit, f) => { f.horizonEndMs++; }, (_fit, f) => { f.maximumLabelEndMs++; },
    (_fit, f) => { f.decisionMs = FIT + S.dayMs; },
  ];
  for (const mutate of mutations) { const { fit, forecast } = fixture(); mutate(fit, forecast);
    assert.equal(evaluateProfitUtility(fit, forecast, 37), null); }
});

test("recomputed forecast statistics reject forged mean, interval, volatility and predictive probability claims", () => {
  const mutations: Array<(forecast: ProfitForecast) => void> = [
    f => { f.meanGrossBps += 100; }, f => { f.lowerGrossBps += 100; }, f => { f.upperGrossBps += 100; },
    f => { f.sigmaHorizon *= 10; }, f => { f.sigmaDay = 0; }, f => { f.close = NaN; },
    f => { f.features = [0, 0, 0]; }, f => { f.features = [1, 4, 0]; },
    f => { f.features = [1, NaN, 0]; }, f => { f.meanGrossBps = Infinity; },
    f => { (f as unknown as { winProbability: number }).winProbability = .95; },
  ];
  for (const mutate of mutations) { const { fit, forecast } = fixture(); mutate(forecast);
    assert.equal(evaluateProfitUtility(fit, forecast, 37), null); }
});

test("utility is deterministic, leaves the fitted evidence intact, and handles missing input without throwing", () => {
  const data = fixture(37.01, 10), before = structuredClone(data);
  assert.deepEqual(evaluateProfitUtility(data.fit, data.forecast, 37), evaluateProfitUtility(data.fit, data.forecast, 37));
  assert.deepEqual(data, before);
  assert.equal(evaluateProfitUtility(null as unknown as ProfitModelFit, data.forecast, 37), null);
  assert.equal(evaluateProfitUtility(data.fit, null as unknown as ProfitForecast, 37), null);
});
