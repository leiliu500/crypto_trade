import assert from "node:assert/strict";
import test from "node:test";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { buildProfitDailyCloses, fitProfitModel, forecastProfitModel,
  type ProfitBar, type ProfitDailyClose } from "../src/profit/model.js";

const DAY = S.dayMs, HOUR = S.hourMs, DELAY = S.candleFinalizationDelayMs;
const START = Date.UTC(2019, 0, 1), FIT = Date.UTC(2020, 5, 1) + DELAY;
const near = (actual: number, expected: number, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} expected near ${expected}`);
function closes(drift = 0): ProfitDailyClose[] {
  return Array.from({ length: 560 }, (_, i) => S.symbols.map((symbol, j) => ({ symbol,
    closeMs: START + i * DAY, close: (j + 1) * 1000 * Math.exp(drift * i) }))).flat();
}
function hourly(days = 3): ProfitBar[] {
  return Array.from({ length: days * 24 }, (_, i) => S.symbols.map((symbol, j) => {
    const price = (j + 1) * 1000 + i;
    return { symbol, openMs: START + i * HOUR, open: price, high: price + 1,
      low: price - 1, close: price, volume: 10 };
  })).flat();
}

test("daily closes require all 24 hours and the fixed finalization delay", () => {
  const bars = hourly();
  const daily = buildProfitDailyCloses(bars, START + 3 * DAY + DELAY);
  assert.equal(daily.length, 6);
  assert.deepEqual(daily[0], { symbol: "BTC/USD", closeMs: START + DAY, close: 1023 });
  assert.equal(buildProfitDailyCloses(bars, START + 3 * DAY + DELAY - 1).length, 4);
  assert.equal(buildProfitDailyCloses(bars.filter(b => b.symbol !== "ETH/USD" || b.openMs !== START + HOUR),
    START + 3 * DAY + DELAY).length, 5);
  const before = structuredClone(bars);
  const future = { ...bars[0]!, openMs: START + 4 * DAY, close: NaN };
  assert.deepEqual(buildProfitDailyCloses([...bars].reverse().concat(future), START + 3 * DAY + DELAY), daily);
  assert.deepEqual(bars, before);
  assert.throws(() => buildProfitDailyCloses([...bars, bars[0]!], START + 3 * DAY + DELAY), /DUPLICATE_BAR/);
  assert.throws(() => buildProfitDailyCloses([{ ...bars[0]!, high: NaN }], START + DAY + DELAY), /INVALID_BAR/);
});

test("fixed ridge independently matches the closed form for constant normalized rows", () => {
  const drift = .001, fit = fitProfitModel(closes(drift), FIT)!;
  const x = [1, drift * Math.sqrt(7) / .005, drift * Math.sqrt(90) / .005];
  const y = Math.expm1(7 * drift) / (.005 * Math.sqrt(7));
  const denominator = S.ridgeLambda + fit.nRows * x.reduce((sum, v) => sum + v * v, 0);
  for (let i = 0; i < 3; i++) near(fit.coefficients[i]!, fit.nRows * y * x[i]! / denominator);
  const prediction = forecastProfitModel(fit, closes(drift), FIT)![0]!;
  const expectedMean = x.reduce((sum, v, i) => sum + fit.coefficients[i]! * v, 0) * .005 * Math.sqrt(7) * 10_000;
  near(prediction.meanGrossBps, expectedMean);
  near(prediction.lowerGrossBps, expectedMean); near(prediction.upperGrossBps, expectedMean);
  assert.ok(prediction.meanGrossBps < Math.expm1(7 * drift) * 10_000, "intercept and slope all receive shrinkage");
  assert.equal(prediction.winProbability, null);
  assert.match(prediction.intervalInterpretation, /CONDITIONAL_MEAN_NOT_PREDICTIVE/);
});

test("flat data yields zero gross mean and cannot manufacture edge from volatility floor", () => {
  const fit = fitProfitModel(closes(), FIT)!;
  assert.equal(fit.nRows, fit.nWeeks * 2); assert.ok(fit.nWeeks >= 26);
  assert.equal(fit.bootstrapCoefficients.length, 256);
  for (const forecast of forecastProfitModel(fit, closes(), FIT)!) {
    assert.equal(forecast.meanGrossBps, 0); assert.equal(forecast.lowerGrossBps, 0); assert.equal(forecast.upperGrossBps, 0);
    assert.equal(forecast.sigmaDay, .005); near(forecast.sigmaHorizon, .005 * Math.sqrt(7));
    assert.equal(forecast.availableAtMs, FIT); assert.equal(forecast.expiresAtMs, FIT + S.maximumSignalAgeMs);
  }
});

test("Monday labels mature a full extra day before first-of-month fitting", () => {
  const input = closes(.001), fit = fitProfitModel(input, FIT)!;
  assert.equal(fit.lastOriginMs, Date.UTC(2020, 4, 18) + DELAY);
  assert.equal(fit.maximumLabelEndMs, Date.UTC(2020, 4, 25));
  assert.equal(fit.maximumLabelAvailableAtMs, Date.UTC(2020, 4, 26) + DELAY);
  assert.ok(fit.maximumLabelAvailableAtMs <= FIT);
  assert.equal(fit.firstOriginMs % DAY, DELAY);
  assert.equal(new Date(fit.firstOriginMs).getUTCDay(), 1);
  const unusedChanged = input.map(c => c.closeMs > fit.maximumLabelEndMs ? { ...c, close: NaN } : { ...c });
  // Unknown values in admitted but unused days are invalid input, whereas
  // valid price changes there cannot affect fitted rows or their hash.
  assert.throws(() => fitProfitModel(unusedChanged, FIT), /INVALID_CLOSE/);
  const unusedValid = input.map(c => c.closeMs > fit.maximumLabelEndMs ? { ...c, close: c.close * 4 } : { ...c });
  assert.deepEqual(fitProfitModel(unusedValid, FIT), fit);
  const matureChanged = input.map(c => c.closeMs === fit.maximumLabelEndMs ? { ...c, close: c.close * 1.01 } : c);
  assert.notEqual(fitProfitModel(matureChanged, FIT)!.inputSha256, fit.inputSha256);
  const future = { symbol: "BTC/USD" as const, closeMs: FIT - DELAY + DAY, close: NaN };
  assert.deepEqual(fitProfitModel([...input, future], FIT), fit);
});

test("canonical fit and forecast hashes exclude future data and input order", () => {
  const input = closes(.001), before = structuredClone(input), fit = fitProfitModel(input, FIT)!;
  const shuffled = [...input].reverse().map(c => ({ close: c.close, closeMs: c.closeMs, symbol: c.symbol }));
  assert.deepEqual(fitProfitModel(shuffled, FIT), fit);
  assert.deepEqual(forecastProfitModel(fit, shuffled, FIT), forecastProfitModel(fit, input, FIT));
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(fit)); assert.ok(Object.isFrozen(fit.coefficients));
  assert.ok(fit.bootstrapCoefficients.every(Object.isFrozen));
  assert.match(fit.inputSha256, /^[a-f0-9]{64}$/);
  assert.match(fit.specSha256, /^[a-f0-9]{64}$/);
});

test("insufficient paired weeks or missing current history fail closed", () => {
  const input = closes(.001), fit = fitProfitModel(input, FIT)!;
  assert.equal(fitProfitModel(input.filter(c => c.symbol === "BTC/USD"), FIT), null);
  assert.equal(fitProfitModel(input.filter(c => c.closeMs >= FIT - 180 * DAY), FIT), null);
  const gapped = input.filter(c => c.symbol !== "ETH/USD" || c.closeMs !== FIT - DELAY - 5 * DAY);
  assert.equal(forecastProfitModel(fit, gapped, FIT), null);
  const oldGap = input.filter(c => c.closeMs !== FIT - DELAY - 200 * DAY);
  const gappedFit = fitProfitModel(oldGap, FIT)!;
  assert.ok(gappedFit.nWeeks < fit.nWeeks);
  assert.ok(gappedFit.excludedWeeks > fit.excludedWeeks);
  assert.equal(forecastProfitModel(null, input, FIT), null);
});

test("sample standard deviation uses thirty completed daily log returns", () => {
  const input = closes(), fit = fitProfitModel(input, FIT)!;
  const own = input.filter(c => c.symbol === "BTC/USD");
  const finalIndex = own.findIndex(c => c.closeMs === FIT - DELAY);
  const returns = Array.from({ length: 30 }, (_, i) => i % 2 === 0 ? .02 : -.01);
  for (let i = 0; i < returns.length; i++) {
    const at = finalIndex - 29 + i; own[at]!.close = own[at - 1]!.close * Math.exp(returns[i]!);
  }
  const prediction = forecastProfitModel(fit, input, FIT)![0]!;
  const mean = returns.reduce((a, b) => a + b, 0) / 30;
  near(prediction.sigmaDay, Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 29));
  const spike = input.map(c => c.symbol === "BTC/USD" && c.closeMs === FIT - DELAY ? { ...c, close: c.close * 1e50 } : c);
  for (const x of forecastProfitModel(fit, spike, FIT)![0]!.features.slice(1)) assert.ok(Math.abs(x) <= 3);
});

test("model and forecast timestamps, numeric inputs and obsolete models are rejected", () => {
  const input = closes(.001), fit = fitProfitModel(input, FIT)!;
  assert.throws(() => fitProfitModel(input, FIT - DELAY), /INVALID_FIT_TIME/);
  assert.throws(() => forecastProfitModel(fit, input, FIT + DAY), /INVALID_DECISION_TIME/);
  assert.throws(() => forecastProfitModel(fit, input, FIT - DELAY), /INVALID_DECISION_TIME/);
  assert.equal(forecastProfitModel(fit, input, Date.UTC(2020, 6, 6) + DELAY), null);
  assert.equal(forecastProfitModel({ ...fit, maximumLabelAvailableAtMs: FIT + 1 }, input, FIT), null);
  assert.equal(forecastProfitModel({ ...fit, coefficients: [1, NaN, 0] }, input, FIT), null);
  assert.throws(() => fitProfitModel([...input, input.find(c => c.closeMs === FIT - 30 * DAY - DELAY)!], FIT), /DUPLICATE_CLOSE/);
  assert.throws(() => fitProfitModel(input.map(c => c.closeMs === FIT - 30 * DAY - DELAY ? { ...c, close: -1 } : c), FIT), /INVALID_CLOSE/);
});
