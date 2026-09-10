import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { FundingRow } from "../src/research/hourly-data.js";
import { fitProfitModel, forecastProfitModel, type ProfitBar, type ProfitDailyClose,
  type ProfitForecast, type ProfitModelFit } from "../src/profit/model.js";
import { replayProfit } from "../src/profit/replay.js";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { replayProfitUtility } from "../src/profit/utility-replay.js";
import { evaluateProfitUtility, PROFIT_UTILITY_SPEC as U } from "../src/profit/utility.js";

const START = Date.UTC(2024, 0, 1), END = START + 14 * S.dayMs;
function baselineInput() {
  const bars: ProfitBar[] = [], funding: FundingRow[] = [], forecasts: ProfitForecast[] = [];
  for (let atMs = START; atMs < END; atMs += S.hourMs) for (const symbol of S.symbols) {
    bars.push({ symbol, openMs: atMs, open: 10_000, high: 10_010, low: 9990, close: 10_000, volume: 100 });
    funding.push({ symbol, timestampMs: atMs + S.hourMs, rate: .000001, absoluteRate: .01 });
  }
  for (const symbol of S.symbols) funding.push({ symbol, timestampMs: END + S.hourMs, rate: .000001, absoluteRate: .01 });
  for (const week of [0, 1]) for (const symbol of S.symbols) {
    const decisionMs = START + week * S.weekMs + S.candleFinalizationDelayMs;
    const lower = symbol === "BTC/USD" ? 200 : 100;
    forecasts.push({ version: S.version, id: `${symbol}:${week}`, modelId: "SYNTHETIC_TEST_MODEL", symbol,
      decisionMs, availableAtMs: decisionMs, expiresAtMs: decisionMs + S.maximumSignalAgeMs,
      horizonEndMs: decisionMs + S.weekMs, fitAtMs: START + 60_000, close: 10_000,
      sigmaDay: .02, sigmaHorizon: .02 * Math.sqrt(7), features: [1, 1, 1],
      meanGrossBps: lower + 10, lowerGrossBps: lower, upperGrossBps: lower + 20,
      nWeeks: 52, inputSha256: "a".repeat(64), modelInputSha256: "b".repeat(64), specSha256: "c".repeat(64),
      maximumLabelEndMs: START - S.dayMs, maximumLabelAvailableAtMs: START,
      intervalInterpretation: "MOVING_WEEK_BLOCK_BOOTSTRAP_CONDITIONAL_MEAN_NOT_PREDICTIVE_INTERVAL", winProbability: null });
  }
  return { bars, funding, forecasts, startMs: START, endMs: END,
    scenario: "base" as const, fundingAssumption: "source-plus-hour" as const };
}

test("the shared inventory kernel preserves the frozen v1 output byte for byte", () => {
  const hash = createHash("sha256").update(JSON.stringify(replayProfit(baselineInput()))).digest("hex");
  assert.equal(hash, "81493cbea5fb7b9f45bf2ba799cb354261517a5eb6b8cca072c8931a05e38c06");
});

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ENTRY = Date.UTC(2024, 0, 29), FINISH = ENTRY + 14 * S.dayMs;
const closes: ProfitDailyClose[] = [];
for (let closeMs = START - 600 * S.dayMs; closeMs <= FINISH; closeMs += S.dayMs) {
  const close = 10_000 * Math.exp(.01 * Math.sin((closeMs - START) / S.dayMs / 4));
  for (const symbol of S.symbols) closes.push({ symbol, closeMs, close });
}
const rawFits = [Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1)]
  .map(atMs => fitProfitModel(closes, atMs + S.candleFinalizationDelayMs)!);
function utilityInput(options: { mean?: number; spread?: number; nextSpread?: number } = {}) {
  const mean = options.mean ?? .6, spread = options.spread ?? 50;
  const fits = rawFits.map((fit, month): ProfitModelFit => {
    assert.ok(fit);
    const { id: _, ...body } = structuredClone(fit);
    body.coefficients = [mean, 0, 0];
    const uncertainty = month === 1 ? options.nextSpread ?? spread : spread;
    body.bootstrapCoefficients = Array.from({ length: S.bootstrapRepetitions }, (_, i) =>
      [mean + (i % 2 ? uncertainty : -uncertainty), 0, 0] as const);
    return { ...body, id: hash(body) };
  });
  const original = baselineInput(), shift = ENTRY - START;
  const forecasts = [ENTRY, ENTRY + S.weekMs].flatMap((midnight, i) => {
    const forecast = forecastProfitModel(fits[i]!, closes, midnight + S.candleFinalizationDelayMs);
    assert.ok(forecast); return forecast;
  });
  return { ...original, fits, forecasts, startMs: ENTRY, endMs: FINISH,
    bars: original.bars.map(bar => ({ ...bar, openMs: bar.openMs + shift })),
    funding: original.funding.map(rate => ({ ...rate, timestampMs: rate.timestampMs + shift })) };
}
const entries = (r: ReturnType<typeof replayProfitUtility>) => r.orders.filter(order => !order.reduceOnly);
const near = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("the explicit utility variant sizes a positive estimated mean despite a wide interval, without claiming realized profit", () => {
  const data = utilityInput();
  assert.ok(data.forecasts.every(f => f.lowerGrossBps < 0 && f.upperGrossBps > 0));
  assert.equal(replayProfit(data).orderCount, 0, "v1 confidence gate remains unchanged");
  const r = replayProfitUtility(data), e = entries(r);
  assert.equal(e.length, 1); assert.equal(e[0]!.reason, "POSITIVE_NET_MEAN_VARIANCE_FORECAST");
  assert.equal(r.version, U.version); assert.equal(r.estimatorVersion, S.version);
  assert.equal(r.policy, "weekly-mean-variance"); assert.equal(r.benchmarkOnly, false);
  assert.ok(r.netPnlUsd! < 0, "flat synthetic prices still incur genuine execution and funding costs");
  near(r.netPnlUsd, r.grossPnlUsd - r.feeUsd + r.fundingCashUsd!);
  assert.equal(r.completedTrades, 1); assert.equal(r.riskBreachCount, 0);
});

test("utility uncertainty caps entry quantity below the account notional ceiling", () => {
  const data = utilityInput(), f = data.forecasts.find(f => f.symbol === "BTC/USD")!;
  const r = replayProfitUtility(data), e = entries(r)[0]!;
  const utility = evaluateProfitUtility(data.fits[0]!, f, r.hurdleBps)!;
  assert.ok(utility.maximumEquityFraction < .01);
  assert.ok(e.qty * e.price <= 100_000 * utility.maximumEquityFraction + 1e-9);
  assert.ok(e.qty * e.price > 200 && e.qty * e.price < 300);
  assert.equal(r.maximumEntryNotionalUsd, e.qty * e.price);
});

test("monthly uncertainty increases reduce existing inventory through the shared deadband without opening again", () => {
  const r = replayProfitUtility(utilityInput({ spread: 1, nextSpread: 50 }));
  const e = entries(r), reductions = r.orders.filter(o => o.reason === "CAP_OR_RISK_REDUCTION");
  assert.equal(e.length, 1); assert.ok(e[0]!.qty * e[0]!.price > 990);
  assert.equal(reductions.length, 1); assert.equal(reductions[0]!.atMs, ENTRY + S.weekMs + S.hourMs);
  assert.ok(reductions[0]!.qty > e[0]!.qty * .7); assert.equal(r.completedTrades, 1);
  near(r.orders.filter(o => o.reduceOnly).reduce((sum, o) => sum + o.qty, 0), e[0]!.qty);
  near(r.trades[0]!.netPnlUsd, r.netPnlUsd!);
});

test("small utility target reductions remain within the quantity deadband", () => {
  const data = utilityInput({ spread: 35, nextSpread: 38 }), r = replayProfitUtility(data);
  const first = evaluateProfitUtility(data.fits[0]!, data.forecasts[0]!, r.hurdleBps)!;
  const second = evaluateProfitUtility(data.fits[1]!, data.forecasts[2]!, r.hurdleBps)!;
  assert.ok(second.maximumEquityFraction < first.maximumEquityFraction);
  assert.ok(second.maximumEquityFraction > first.maximumEquityFraction * .75);
  assert.equal(entries(r).length, 1); assert.equal(r.orders.length, 2);
});

test("a larger later utility target does not add to existing inventory", () => {
  const r = replayProfitUtility(utilityInput({ spread: 50, nextSpread: 1 }));
  assert.equal(entries(r).length, 1); assert.equal(r.orders.length, 2);
  assert.ok(r.maximumEntryNotionalUsd < 300);
});

test("estimated means below total costs remain flat, while valid negative means select a short", () => {
  const small = replayProfitUtility(utilityInput({ mean: .01 })); assert.equal(small.orderCount, 0);
  const short = replayProfitUtility(utilityInput({ mean: -.6 }));
  assert.equal(entries(short)[0]!.side, -1); assert.ok(short.fundingCashUsd! > 0);
  near(short.netPnlUsd, short.grossPnlUsd - short.feeUsd + short.fundingCashUsd!);
});

test("missing or altered fit evidence cannot authorize the utility variant", () => {
  const data = utilityInput();
  const missing = replayProfitUtility({ ...data, fits: [] });
  assert.equal(missing.orderCount, 0); assert.equal(missing.blockReasons.UTILITY_MODEL_FIT_UNAVAILABLE, 4);
  const changed = replayProfitUtility({ ...data, fits: data.fits.map(f => ({ ...f, coefficients: [100, 0, 0] as const })) });
  assert.equal(changed.orderCount, 0); assert.equal(changed.blockReasons.NO_POSITIVE_VALID_NET_MEAN_UTILITY, 4);
  assert.throws(() => replayProfitUtility({ ...data, fits: [...data.fits, data.fits[0]!] }), /DUPLICATE_FIT/);
  const { fits: _, ...withoutFits } = data;
  assert.throws(() => replayProfit({ ...withoutFits, policy: "weekly-mean-variance" }), /FITS_REQUIRED/);
});

test("utility study benchmarks preserve the original risk-managed long economics and receive explicit variant metadata", () => {
  const data = utilityInput({ mean: .01 });
  for (const policy of ["risk-managed-long-btc", "risk-managed-long-eth"] as const) {
    const benchmark = replayProfitUtility({ ...data, policy }), old = replayProfit({ ...data, policy });
    assert.equal(benchmark.version, U.version); assert.equal(benchmark.benchmarkOnly, true);
    assert.equal(entries(benchmark)[0]!.reason, "BENCHMARK_LONG_ENTRY");
    const { estimatorVersion: _, selectionSpec: __, ...comparable } = benchmark;
    assert.deepEqual({ ...comparable, version: S.version }, old);
    assert.ok(benchmark.maximumEntryNotionalUsd > 990, "benchmarks do not inherit alpha utility sizing");
  }
});
