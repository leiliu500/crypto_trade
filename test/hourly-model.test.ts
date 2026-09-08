import assert from "node:assert/strict";
import test from "node:test";
import type { HourlyBar } from "../src/research/hourly-data.js";
import { buildHourlyDataset, buildHourlyFeatures, buildHourlyTrainingRows, hourlyCandidateFeatures,
  HOURLY_CANDIDATES, HOURLY_MODEL_SPEC, HourlyRidgeModel, type HourlyCandidate,
  type HourlyHorizonHours, type HourlyTrainingRow } from "../src/research/hourly-model.js";

const HOUR = 3_600_000, START = Date.UTC(2024, 0, 1);
const candidate = (kind: "trend" | "recovery" = "trend", horizonHours: HourlyHorizonHours = 4) =>
  HOURLY_CANDIDATES.find(value => value.kind === kind && value.horizonHours === horizonHours)!;
function bars(count = 280, btcRate = .001, ethRate = .002): HourlyBar[] {
  return Array.from({ length: count }, (_, i) => (["BTC/USD", "ETH/USD"] as const).map(symbol => {
    const rate = symbol === "BTC/USD" ? btcRate : ethRate, base = symbol === "BTC/USD" ? 100 : 50;
    const open = base * Math.exp(rate * i), close = base * Math.exp(rate * (i + 1));
    return { symbol, openMs: START + i * HOUR, open, close,
      high: Math.max(open, close) * 1.001, low: Math.min(open, close) * .999, volume: 10 };
  })).flat();
}
function syntheticRows(count = 200, horizonHours: HourlyHorizonHours = 4): HourlyTrainingRow[] {
  return Array.from({ length: count }, (_, i) => (["BTC/USD", "ETH/USD"] as const).map(symbol => {
    const x = i % 5 - 2, decisionMs = START + i * HOUR, entryMs = decisionMs + HOUR;
    const exitMs = entryMs + horizonHours * HOUR;
    return { symbol, decisionMs, entryMs, exitMs, completedAtMs: exitMs + HOUR, horizonHours,
      features: [x, 0, 0, 0], grossBps: symbol === "BTC/USD" ? 7 + 30 * x : -9 - 20 * x };
  })).flat();
}
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
  `Expected ${actual} to be within ${tolerance} of ${expected}`);

test("closed hourly log-return features have the declared volatility scale and synchronized warmup", () => {
  const dataset = buildHourlyDataset(bars());
  assert.equal(buildHourlyFeatures(dataset, "BTC/USD", START + 168 * HOUR), null);
  const values = buildHourlyFeatures(dataset, "BTC/USD", START + 169 * HOUR)!;
  near(values[0]!, Math.sqrt(4)); near(values[1]!, Math.sqrt(24)); near(values[2]!, Math.sqrt(168));
  near(values[3]!, (.001 - .002) * 24 / (Math.hypot(.001, .002) * Math.sqrt(24)));
  assert.equal(dataset.points[0]!.decisionMs, START + 169 * HOUR);
  assert.deepEqual(buildHourlyFeatures(bars(), "BTC/USD", START + 169 * HOUR), values);
  assert.equal(buildHourlyFeatures(dataset, "BTC/USD", START + 169 * HOUR + 1), null);
});

test("a missing hour in either asset invalidates all affected lookbacks and then recovers", () => {
  for (const symbol of ["BTC/USD", "ETH/USD"] as const) {
    const input = bars().filter(bar => !(bar.symbol === symbol && bar.openMs === START + 80 * HOUR));
    const dataset = buildHourlyDataset(input);
    for (const own of ["BTC/USD", "ETH/USD"] as const) {
      assert.equal(buildHourlyFeatures(dataset, own, START + 200 * HOUR), null);
      assert.ok(buildHourlyFeatures(dataset, own, START + 250 * HOUR));
    }
  }
});

test("future or pre-lookback prices cannot change features, and cached data owns its inputs", () => {
  const input = bars(), decisionMs = START + 250 * HOUR;
  const dataset = buildHourlyDataset(input), before = buildHourlyFeatures(dataset, "BTC/USD", decisionMs)!;
  for (const bar of input) if (bar.openMs >= decisionMs || bar.openMs < START + 81 * HOUR) {
    bar.open *= 4; bar.close *= 4; bar.high *= 4; bar.low *= 4;
  }
  assert.deepEqual(buildHourlyFeatures(buildHourlyDataset(input), "BTC/USD", decisionMs), before);
  assert.deepEqual(buildHourlyFeatures(dataset, "BTC/USD", decisionMs), before);
  const copy = buildHourlyFeatures(dataset, "BTC/USD", decisionMs)!; copy[0] = 100;
  assert.deepEqual(buildHourlyFeatures(dataset, "BTC/USD", decisionMs), before);
});

test("constant completed price history yields finite zero-normalized features", () => {
  const dataset = buildHourlyDataset(bars(200, 0, 0));
  assert.deepEqual(buildHourlyFeatures(dataset, "BTC/USD", START + 190 * HOUR), [0, 0, 0, 0]);
  assert.deepEqual(buildHourlyFeatures(dataset, "ETH/USD", START + 190 * HOUR), [0, 0, 0, 0]);
});

test("labels use strictly later entry opens and require exit candle completion strictly before cutoff", () => {
  const dataset = buildHourlyDataset(bars()), decisionMs = START + 200 * HOUR;
  for (const horizon of [4, 24] as const) {
    const exitMs = decisionMs + (1 + horizon) * HOUR;
    const equal = buildHourlyTrainingRows(dataset, horizon, decisionMs, exitMs);
    assert.equal(equal.length, 0);
    assert.equal(buildHourlyTrainingRows(dataset, horizon, decisionMs, exitMs + 1).length, 0);
    assert.equal(buildHourlyTrainingRows(dataset, horizon, decisionMs, exitMs + HOUR).length, 0);
    const values = buildHourlyTrainingRows(dataset, horizon, decisionMs, exitMs + 2 * HOUR);
    assert.equal(values.length, 2);
    const btc = values.find(row => row.symbol === "BTC/USD")!;
    assert.equal(btc.decisionMs, decisionMs); assert.equal(btc.entryMs, decisionMs + HOUR);
    assert.equal(btc.exitMs, exitMs); assert.equal(btc.completedAtMs, exitMs + HOUR);
    near(btc.grossBps, Math.expm1(.001 * horizon) * 10_000);
  }
});

test("training labels reject missing holding hours and untradable endpoint bars", () => {
  const decisionMs = START + 200 * HOUR, cutoffMs = decisionMs + 7 * HOUR;
  for (const invalidHour of [201, 205]) {
    const input = bars(); input.find(bar => bar.symbol === "BTC/USD" && bar.openMs === START + invalidHour * HOUR)!.volume = 0;
    const rows = buildHourlyTrainingRows(buildHourlyDataset(input), 4, decisionMs, cutoffMs);
    assert.deepEqual(rows.map(row => row.symbol), ["ETH/USD"]);
  }
  const gap = bars().filter(bar => !(bar.symbol === "BTC/USD" && bar.openMs === START + 203 * HOUR));
  assert.deepEqual(buildHourlyTrainingRows(buildHourlyDataset(gap), 4, decisionMs, cutoffMs).map(row => row.symbol), ["ETH/USD"]);
});

test("the fixed ridge fits per-asset gross returns with unpenalized intercepts and train-only scaling", () => {
  const rows = syntheticRows(), cutoffMs = START + 210 * HOUR;
  const model = new HourlyRidgeModel(candidate(), rows, cutoffMs);
  const shrink = 200 / (200 + 16);
  near(model.predict("BTC/USD", [2, 0, 0, 0], cutoffMs)!, 7 + 60 * shrink);
  near(model.predict("ETH/USD", [2, 0, 0, 0], cutoffMs)!, -9 - 40 * shrink);
  const fits = model.diagnostics().fits, btc = fits.find(fit => fit.symbol === "BTC/USD")!;
  assert.equal(btc.samples, 200); assert.equal(btc.intercept, 7); near(btc.scales[0]!, Math.sqrt(2));
  assert.deepEqual(btc.scales.slice(1), [.1, .1, .1]);
  assert.equal(btc.latestCompletedMs, rows.at(-1)!.completedAtMs); assert.ok(btc.latestCompletedMs! < cutoffMs);
  assert.equal(btc.trainingRowsSha256.length, 64);
  assert.equal(model.predict("BTC/USD", [2, 0, 0, 0], cutoffMs - HOUR), null);
  assert.equal(model.predict("BTC/USD", [NaN, 0, 0, 0], cutoffMs), null);
});

test("recovery uses exactly the two registered interactions and four total candidates", () => {
  assert.equal(HOURLY_CANDIDATES.length, 4);
  assert.equal(new Set(HOURLY_CANDIDATES.map(value => value.id)).size, 4);
  assert.deepEqual(hourlyCandidateFeatures([-2, -3, 4, 0], "recovery"), [-2, -3, 4, 0, 3, -2]);
  assert.deepEqual(hourlyCandidateFeatures([2, 3, -4, 0], "recovery"), [2, 3, -4, 0, -3, 2]);
  assert.deepEqual(hourlyCandidateFeatures([2, 3, -4, 0], "trend"), [2, 3, -4, 0]);
  for (const fixed of HOURLY_CANDIDATES) {
    const rows = syntheticRows(200, fixed.horizonHours);
    const model = new HourlyRidgeModel(fixed, rows, START + 240 * HOUR);
    assert.equal(model.diagnostics().featureNames.length, fixed.kind === "trend" ? 4 : 6);
    assert.equal(model.diagnostics().fits[0]!.coefficients.length, fixed.kind === "trend" ? 4 : 6);
  }
  assert.equal(HOURLY_MODEL_SPEC.ridgePenalty, 16);
});

test("recovery interactions capture a synthetic nonlinear signal without choosing features from outcomes", () => {
  const rows = syntheticRows(512).map((row, i) => {
    const n = Math.floor(i / 2), base = [[-2, -1, 1, 2][n % 4]!, [-3, -1, 1, 3][Math.floor(n / 4) % 4]!,
      Math.floor(n / 16) % 2 ? -4 : 4, 0];
    const values = hourlyCandidateFeatures(base, "recovery");
    return { ...row, features: base, grossBps: 5 + 20 * values[4]! - 10 * values[5]! };
  });
  const cutoffMs = START + 522 * HOUR;
  const trend = new HourlyRidgeModel(candidate("trend"), rows, cutoffMs);
  const recovery = new HourlyRidgeModel(candidate("recovery"), rows, cutoffMs);
  const loss = (model: HourlyRidgeModel) => rows.reduce((sum, row) => sum + (model.predict(row.symbol, row.features, cutoffMs)! - row.grossBps) ** 2, 0);
  assert.ok(loss(recovery) < loss(trend) / 10);
});

test("frozen fits are immutable, deterministic and never learn from prediction calls", () => {
  const rows = syntheticRows(), cutoffMs = START + 210 * HOUR;
  const a = new HourlyRidgeModel(candidate(), rows, cutoffMs);
  const b = new HourlyRidgeModel(candidate(), [...rows].reverse(), cutoffMs);
  assert.deepEqual(a.diagnostics(), b.diagnostics());
  const before = a.diagnostics(), value = a.predict("BTC/USD", [1, 0, 0, 0], cutoffMs);
  for (const row of rows) { Object.assign(row, { grossBps: 10000 }); (row.features as number[])[0] = 1000; }
  const returned = a.diagnostics(); returned.fits[0]!.coefficients[0] = 10000;
  a.predict("BTC/USD", [100, 100, 100, 100], cutoffMs + 1000 * HOUR);
  assert.deepEqual(a.diagnostics(), before);
  assert.equal(a.predict("BTC/USD", [1, 0, 0, 0], cutoffMs + HOUR), value);
});

test("invalid bars, unregistered candidates, duplicate labels and equal/future cutoffs fail explicitly", () => {
  const input = bars(); assert.throws(() => buildHourlyDataset([...input, input[0]!]), /DUPLICATE_BAR/);
  assert.throws(() => buildHourlyDataset([{ ...input[0]!, openMs: START + 1 }]), /INVALID_BAR/);
  assert.throws(() => buildHourlyDataset([{ ...input[0]!, close: NaN }]), /INVALID_BAR/);
  const rows = syntheticRows(), cutoffMs = START + 210 * HOUR;
  assert.throws(() => new HourlyRidgeModel({ ...candidate(), id: "unregistered" }, rows, cutoffMs), /INVALID_FIT_INPUT/);
  assert.throws(() => new HourlyRidgeModel(candidate(), [...rows, rows[0]!], cutoffMs), /DUPLICATE_TRAINING_ROW/);
  assert.throws(() => new HourlyRidgeModel(candidate(), rows, rows.at(-1)!.completedAtMs), /FUTURE_TRAINING_ROW/);
  assert.throws(() => new HourlyRidgeModel(candidate(), [{ ...rows[0]!, completedAtMs: rows[0]!.exitMs }], cutoffMs), /INVALID_OR_FUTURE/);
  assert.throws(() => new HourlyRidgeModel(candidate(), [{ ...rows[0]!, entryMs: rows[0]!.decisionMs }], cutoffMs), /INVALID_OR_FUTURE/);
  assert.throws(() => new HourlyRidgeModel(candidate(), [{ ...rows[0]!, grossBps: Infinity }], cutoffMs), /INVALID_OR_FUTURE/);
  assert.throws(() => new HourlyRidgeModel({ ...candidate(), horizonHours: 12 } as unknown as HourlyCandidate, rows, cutoffMs), /INVALID_FIT_INPUT/);
  const empty = new HourlyRidgeModel(candidate(), [], cutoffMs);
  assert.equal(empty.predict("BTC/USD", [0, 0, 0, 0], cutoffMs), null);
  assert.equal(empty.diagnostics().fits[0]!.reason, "NO_TRAINING_ROWS");
});
