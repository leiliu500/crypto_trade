import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveHourlyRidgeModel, HOURLY_ADAPTIVE_MODEL_SPEC } from "../src/research/hourly-adaptive-model.js";
import { HOURLY_CANDIDATES, hourlyCandidateFeatures, type HourlyCandidate,
  type HourlyHorizonHours, type HourlySymbol, type HourlyTrainingRow } from "../src/research/hourly-model.js";

const HOUR = 3_600_000, DAY = 24 * HOUR, CUTOFF = Date.UTC(2025, 0, 1);
const candidate = (kind: "trend" | "recovery" = "trend", horizonHours: HourlyHorizonHours = 4) =>
  HOURLY_CANDIDATES.find(value => value.kind === kind && value.horizonHours === horizonHours)!;
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
  `Expected ${actual} to be within ${tolerance} of ${expected}`);

function row(decisionMs: number, features: number[] = [0, 0, 0, 0], grossBps = 0,
  symbol: HourlySymbol = "BTC/USD", horizonHours: HourlyHorizonHours = 4): HourlyTrainingRow {
  const entryMs = decisionMs + HOUR, exitMs = entryMs + horizonHours * HOUR;
  return { symbol, decisionMs, features, grossBps, entryMs, exitMs, completedAtMs: exitMs + HOUR, horizonHours };
}
function trainingRows(count = 6_000, cutoffMs = CUTOFF, horizonHours: HourlyHorizonHours = 4,
  symbol: HourlySymbol = "BTC/USD"): HourlyTrainingRow[] {
  return Array.from({ length: count }, (_, i) => {
    const x = i % 5 - 2;
    return row(cutoffMs - (count + 30 - i) * HOUR, [x, 0, 0, 0],
      symbol === "BTC/USD" ? 7 + 30 * x : -9 - 20 * x, symbol, horizonHours);
  });
}

test("completed-time half-life gives exact weighted centering, intercept and sum-weighted ridge shrinkage", () => {
  const older = row(CUTOFF - 91 * DAY - 6 * HOUR, [-1, 0, 0, 0], 0);
  const newer = row(CUTOFF - DAY - 6 * HOUR, [1, 0, 0, 0], 30);
  const fit = new AdaptiveHourlyRidgeModel(candidate(), [older, newer], CUTOFF).diagnostics().fits[0]!;
  const olderWeight = 2 ** (-91 / 90), expectedWeight = 3 * olderWeight;
  near(fit.weightSum, expectedWeight); near(fit.weightSquaredSum, 5 * olderWeight ** 2);
  near(fit.weightedESS, 9 / 5); near(fit.targetMeanGrossBps!, 20); near(fit.intercept!, 20);
  near(fit.targetStdGrossBps!, Math.sqrt(200)); near(fit.centers[0]!, 1 / 3);
  near(fit.scales[0]!, Math.sqrt(8 / 9));
  near(fit.coefficients[0]!, 15 * Math.sqrt(8 / 9) * expectedWeight / (expectedWeight + 16));
  assert.deepEqual(fit.scales.slice(1), [.1, .1, .1]);
  assert.deepEqual(fit.coefficients.slice(1), [0, 0, 0]);
  assert.equal(fit.reason, "INSUFFICIENT_TRAINING_ROWS");
});

test("a varying feature below the fixed scale floor preserves its weighted covariance", () => {
  const rows = [row(CUTOFF - 91 * DAY - 6 * HOUR, [-.01, 0, 0, 0], 0),
    row(CUTOFF - DAY - 6 * HOUR, [.01, 0, 0, 0], 30)];
  const fit = new AdaptiveHourlyRidgeModel(candidate(), rows, CUTOFF).diagnostics().fits[0]!;
  near(fit.centers[0]!, .01 / 3); assert.equal(fit.scales[0], .1);
  const xVariance = .0001 * 8 / 9;
  near(fit.coefficients[0]!, (fit.weightSum * xVariance * 1_500 / .1)
    / (fit.weightSum * xVariance / .01 + 16));
});

test("predictions require 6000 raw rows and sufficient weighted support independently for each asset", () => {
  const btc = trainingRows(), eth = trainingRows(5_999, CUTOFF, 4, "ETH/USD");
  const model = new AdaptiveHourlyRidgeModel(candidate(), [...btc, ...eth], CUTOFF);
  const [btcFit, ethFit] = model.diagnostics().fits;
  assert.equal(btcFit!.samples, 6_000); assert.equal(btcFit!.reason, "READY");
  assert.ok(btcFit!.weightedESS >= 1_000 && btcFit!.weightedESS < 6_000);
  assert.equal(ethFit!.samples, 5_999); assert.equal(ethFit!.reason, "INSUFFICIENT_TRAINING_ROWS");
  assert.equal(model.predict("ETH/USD", [2, 0, 0, 0], CUTOFF), null);
  const center = btcFit!.centers[0]!, scale = btcFit!.scales[0]!, weight = btcFit!.weightSum;
  near(model.predict("BTC/USD", [2, 0, 0, 0], CUTOFF)!, 7 + 30 * center + 30 * (2 - center) * weight / (weight + 16));
  near(btcFit!.coefficients[0]!, 30 * scale * weight / (weight + 16));
  const both = new AdaptiveHourlyRidgeModel(candidate(), [...btc, ...trainingRows(6_000, CUTOFF, 4, "ETH/USD")], CUTOFF);
  assert.ok(both.predict("BTC/USD", [2, 0, 0, 0], CUTOFF)! > 0);
  assert.ok(both.predict("ETH/USD", [2, 0, 0, 0], CUTOFF)! < 0);
  const empty = new AdaptiveHourlyRidgeModel(candidate(), [], CUTOFF);
  assert.equal(empty.predict("BTC/USD", [0, 0, 0, 0], CUTOFF), null);
  assert.equal(empty.diagnostics().fits[0]!.reason, "NO_TRAINING_ROWS");
  assert.equal(empty.diagnostics().fits[0]!.weightedESS, 0);
});

test("the decision window is exactly 365 UTC days including its lower bound", () => {
  const start = CUTOFF - 365 * DAY;
  const accepted = row(start);
  const diagnostics = new AdaptiveHourlyRidgeModel(candidate(), [accepted], CUTOFF).diagnostics();
  assert.equal(diagnostics.windowStartMs, start);
  // 2024 was a leap year: the trailing 365-day window starts January 2.
  assert.equal(start, Date.UTC(2024, 0, 2));
  assert.equal(diagnostics.fits[0]!.firstDecisionMs, start);
  assert.equal(diagnostics.fits[0]!.earliestCompletedMs, start + 6 * HOUR);
  assert.throws(() => new AdaptiveHourlyRidgeModel(candidate(), [row(start - HOUR)], CUTOFF), /OUT_OF_WINDOW/);
});

test("monthly fits expire at the actual next UTC month including leap February and year rollover", () => {
  for (const [cutoff, next] of [[Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 1)], [Date.UTC(2025, 11, 1), Date.UTC(2026, 0, 1)]]) {
    const model = new AdaptiveHourlyRidgeModel(candidate(), trainingRows(6_000, cutoff!), cutoff!);
    assert.equal(model.diagnostics().nextRefitMs, next);
    assert.equal(model.predict("BTC/USD", [0, 0, 0, 0], cutoff! - HOUR), null);
    assert.ok(Number.isFinite(model.predict("BTC/USD", [0, 0, 0, 0], cutoff!)!));
    assert.ok(Number.isFinite(model.predict("BTC/USD", [0, 0, 0, 0], next! - HOUR)!));
    assert.equal(model.predict("BTC/USD", [0, 0, 0, 0], next!), null);
    assert.equal(model.predict("BTC/USD", [0, 0, 0, 0], cutoff! + 1), null);
  }
  for (const invalid of [CUTOFF + HOUR, CUTOFF + DAY, CUTOFF + 1, NaN, Infinity])
    assert.throws(() => new AdaptiveHourlyRidgeModel(candidate(), [], invalid), /INVALID_FIT_INPUT/);
});

test("causal monthly refitting admits newly completed labels only to a new frozen model", () => {
  const oldRows = trainingRows().map(value => ({ ...value, features: [0, 0, 0, 0], grossBps: 0 }));
  const january = new AdaptiveHourlyRidgeModel(candidate(), oldRows, CUTOFF);
  const nextCutoff = Date.UTC(2025, 1, 1);
  const januaryRows = Array.from({ length: 715 }, (_, i) => row(CUTOFF + i * HOUR, [0, 0, 0, 0], 100));
  assert.throws(() => new AdaptiveHourlyRidgeModel(candidate(), [...oldRows, ...januaryRows], CUTOFF), /FUTURE_TRAINING_ROW/);
  const february = new AdaptiveHourlyRidgeModel(candidate(), [...oldRows, ...januaryRows], nextCutoff);
  assert.equal(january.predict("BTC/USD", [0, 0, 0, 0], nextCutoff - HOUR), 0);
  assert.equal(january.predict("BTC/USD", [0, 0, 0, 0], nextCutoff), null);
  assert.ok(february.predict("BTC/USD", [0, 0, 0, 0], nextCutoff)! > 0);
  assert.ok(february.diagnostics().fits[0]!.latestCompletedMs! < nextCutoff);
});

test("the registered four candidates retain their original dimensions and recovery interactions", () => {
  assert.equal(HOURLY_ADAPTIVE_MODEL_SPEC.ridgePenalty, 16);
  assert.equal(HOURLY_ADAPTIVE_MODEL_SPEC.minimumSamples, 6_000);
  assert.equal(HOURLY_ADAPTIVE_MODEL_SPEC.minimumWeightedESS, 1_000);
  assert.deepEqual(HOURLY_ADAPTIVE_MODEL_SPEC.candidates, HOURLY_CANDIDATES);
  for (const fixed of HOURLY_CANDIDATES) {
    const rows = [row(CUTOFF - 91 * DAY - (fixed.horizonHours + 2) * HOUR, [-2, -3, 4, 0], 1, "BTC/USD", fixed.horizonHours),
      row(CUTOFF - DAY - (fixed.horizonHours + 2) * HOUR, [2, 3, -4, 0], 2, "BTC/USD", fixed.horizonHours)];
    const diagnostic = new AdaptiveHourlyRidgeModel(fixed, rows, CUTOFF).diagnostics();
    const dimension = fixed.kind === "trend" ? 4 : 6;
    assert.equal(diagnostic.featureNames.length, dimension);
    assert.equal(diagnostic.fits[0]!.coefficients.length, dimension);
    const a = hourlyCandidateFeatures(rows[0]!.features, fixed.kind), b = hourlyCandidateFeatures(rows[1]!.features, fixed.kind);
    diagnostic.fits[0]!.centers.forEach((center, i) => near(center, (a[i]! + 2 * b[i]!) / 3));
  }
});

test("weighted recovery fitting learns a prescribed nonlinear synthetic signal", () => {
  const rows = trainingRows(6_400).map((value, n) => {
    const features = [[-2, -1, 1, 2][n % 4]!, [-3, -1, 1, 3][Math.floor(n / 4) % 4]!, Math.floor(n / 16) % 2 ? -4 : 4, 0];
    const interactions = hourlyCandidateFeatures(features, "recovery");
    return { ...value, features, grossBps: 5 + 20 * interactions[4]! - 10 * interactions[5]! };
  });
  const trend = new AdaptiveHourlyRidgeModel(candidate("trend"), rows, CUTOFF);
  const recovery = new AdaptiveHourlyRidgeModel(candidate("recovery"), rows, CUTOFF);
  const loss = (model: AdaptiveHourlyRidgeModel) => rows.reduce((sum, value) =>
    sum + (model.predict(value.symbol, value.features, CUTOFF)! - value.grossBps) ** 2, 0);
  assert.ok(loss(recovery) < loss(trend) / 100);
});

test("frozen diagnostics and hashes are deterministic, owned and unaffected by prediction inputs", () => {
  const rows = trainingRows(), model = new AdaptiveHourlyRidgeModel(candidate(), rows, CUTOFF);
  const before = model.diagnostics(), prediction = model.predict("BTC/USD", [1, 0, 0, 0], CUTOFF);
  assert.deepEqual(new AdaptiveHourlyRidgeModel(candidate(), [...rows].reverse(), CUTOFF).diagnostics(), before);
  const modified = structuredClone(rows); Object.assign(modified[0]!, { grossBps: 123 });
  const different = new AdaptiveHourlyRidgeModel(candidate(), modified, CUTOFF).diagnostics();
  assert.notEqual(different.fits[0]!.trainingRowsSha256, before.fits[0]!.trainingRowsSha256);
  assert.notEqual(different.fits[0]!.weightedRowsSha256, before.fits[0]!.weightedRowsSha256);
  assert.equal(before.specSha256.length, 64); assert.equal(before.fits[0]!.trainingRowsSha256.length, 64);
  for (const value of rows) { Object.assign(value, { grossBps: 10_000 }); (value.features as number[])[0] = 1_000; }
  const returned = model.diagnostics(); returned.fits[0]!.coefficients[0] = 1_000;
  model.predict("BTC/USD", [100, 100, 100, 100], CUTOFF + HOUR);
  assert.deepEqual(model.diagnostics(), before);
  assert.equal(model.predict("BTC/USD", [1, 0, 0, 0], CUTOFF + 2 * HOUR), prediction);
});

test("malformed, duplicate and equal-cutoff labels fail explicitly before prediction", () => {
  const valid = row(CUTOFF - 100 * HOUR);
  const invalidRows = [
    { ...valid, symbol: "OTHER/USD" }, { ...valid, horizonHours: 24 }, { ...valid, grossBps: Infinity },
    { ...valid, features: [NaN, 0, 0, 0] }, { ...valid, features: [0, 0, 0] },
    { ...valid, entryMs: valid.decisionMs }, { ...valid, decisionMs: valid.decisionMs + 1 },
    { ...valid, completedAtMs: valid.exitMs }, row(CUTOFF - 6 * HOUR), row(CUTOFF),
  ];
  for (const invalid of invalidRows) assert.throws(() => new AdaptiveHourlyRidgeModel(candidate(),
    [invalid as HourlyTrainingRow], CUTOFF), /INVALID_OR_FUTURE_TRAINING_ROW/);
  assert.throws(() => new AdaptiveHourlyRidgeModel(candidate(), [valid, valid], CUTOFF), /DUPLICATE_TRAINING_ROW/);
  assert.throws(() => new AdaptiveHourlyRidgeModel({ ...candidate(), id: "unregistered" }, [], CUTOFF), /INVALID_FIT_INPUT/);
  assert.throws(() => new AdaptiveHourlyRidgeModel({ ...candidate(), horizonHours: 12 } as unknown as HourlyCandidate, [], CUTOFF), /INVALID_FIT_INPUT/);
  const model = new AdaptiveHourlyRidgeModel(candidate(), trainingRows(), CUTOFF);
  assert.equal(model.predict("OTHER/USD" as HourlySymbol, [0, 0, 0, 0], CUTOFF), null);
  assert.equal(model.predict("BTC/USD", [NaN, 0, 0, 0], CUTOFF), null);
});
