import assert from "node:assert/strict";
import test from "node:test";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { RegimeDistributionModel, REGIME_DISTRIBUTION_SPEC } from "../src/distribution/regime-model.js";
import { DISTRIBUTION_SCENARIOS as SCENARIOS, DISTRIBUTION_SPEC as S, type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, START = Date.UTC(2026, 8, 1);
const features = (trend = 0, flow = 0, volatility = 0) => {
  const values = Array<number>(12).fill(0); values[7] = trend; values[1] = flow; values[5] = volatility; return values;
};
function sample(atMs: number, values: number[], gross: number, fraction = 1): DistributionSample {
  const completedAtMs = atMs + 300_750;
  return { id: `BTC/USD:long-5m:${atMs}`, symbol: "BTC/USD", actionId: "long-5m", signalAtMs: atMs,
    completedAtMs, features: values, outcomes: SCENARIOS.map(scenario => ({ scenario: scenario.id,
      status: fraction ? "FILLED" : "UNFILLED", filledFraction: fraction,
      entryAtMs: fraction ? atMs + scenario.latencyMs : null, exitAtMs: completedAtMs,
      grossBps: fraction ? gross : 0, netBps: fraction ? gross - (scenario.id === "fees-1.5x" ? 18 : 13) * fraction : 0,
      reason: fraction ? "DEADLINE" : "LIMIT_NOT_REACHED" })) };
}
function rows(regimes: Array<{ values: number[]; gross: number; fraction?: number }>, perDay = 16, days = [0, 1, 2]) {
  return days.flatMap(day => Array.from({ length: perDay }, (_, i) => regimes.map((regime, j) =>
    sample(START + day * DAY + (i * regimes.length + j) * 360_000, [...regime.values], regime.gross, regime.fraction ?? 1)))).flat();
}
function trained(samples: DistributionSample[]) {
  const model = new RegimeDistributionModel(); for (const row of samples) assert.equal(model.observe(row), true); return model;
}
const now = (samples: DistributionSample[]) => samples.at(-1)!.completedAtMs + 1000;
const predict = (model: RegimeDistributionModel, values: number[], atMs: number, days = 3) =>
  model.predictScenarios("BTC/USD", "long-5m", values, atMs, days);
const estimate = (model: RegimeDistributionModel, values: number[], atMs: number, days = 3) =>
  model.estimate("BTC/USD", "long-5m", values, atMs, days);

test("supervised depth-two regimes preserve a profitable nonlinear state that broad averaging mixes", () => {
  const samples = rows([
    { values: features(-.1, -.1), gross: -30 }, { values: features(-.1, .1), gross: -30 },
    { values: features(.1, -.1), gross: -30 }, { values: features(.1, .1), gross: 70 },
  ]);
  const model = trained(samples), original = new ConditionalDistributionModel();
  for (const row of samples) assert.equal(original.observe(row), true);
  const atMs = now(samples), value = estimate(model, features(.1, .1), atMs);
  assert.equal(value.eligible, true); assert.equal(value.samples, 48); assert.ok(value.scoreBps! > 1);
  assert.equal(original.estimate("BTC/USD", "long-5m", features(.1, .1), atMs, 3).eligible, false);
  assert.equal(estimate(model, features(.1, -.1), atMs).eligible, false);
  const tree = model.diagnostics().trees[0]!;
  assert.equal(tree.leafCount, 3); assert.equal(tree.splitCount, 2); assert.equal(tree.maximumDepth, 2);
  const flat = JSON.stringify(tree.tree);
  assert.ok(flat.includes('"samples":48')); assert.ok(!flat.includes('"feature":5'));
});

test("zero gross retains full empirical costs under the zero-gross prior", () => {
  const samples = rows([{ values: features(), gross: 0 }], 24), model = trained(samples);
  const predictions = predict(model, features(), now(samples));
  assert.deepEqual(predictions.map(p => p.grossBps), [0, 0, 0]);
  predictions.forEach((p, i) => {
    const cost = i === 1 ? 18 : 13;
    assert.ok(Math.abs(p.costBps! - cost) < 1e-10); assert.ok(Math.abs(p.meanNetBps! + cost) < 1e-10);
  });
  assert.equal(estimate(model, features(), now(samples)).eligible, false);
});

test("partial fills and genuine nonfills retain the requested-notional denominator exactly once", () => {
  const samples = rows([{ values: features(), gross: 20, fraction: .5 }, { values: features(), gross: 0, fraction: 0 }], 12);
  const model = trained(samples), atMs = now(samples), values = predict(model, features(), atMs);
  const weights = samples.map(row => 2 ** (-(atMs - row.completedAtMs) / S.memoryHalfLifeMs));
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const gross = samples.reduce((sum, row, j) => sum + weights[j]! * row.outcomes[i]!.grossBps!, 0) / (total + S.priorWeight);
    const cost = samples.reduce((sum, row, j) => sum + weights[j]! * (row.outcomes[i]!.grossBps! - row.outcomes[i]!.netBps!), 0) / total;
    assert.ok(Math.abs(values[i]!.grossBps! - gross) < 1e-10);
    assert.ok(Math.abs(values[i]!.costBps! - cost) < 1e-10);
    assert.ok(Math.abs(values[i]!.meanNetBps! - (gross - cost)) < 1e-10);
  }
  const expectedFillProbability = samples.reduce((sum, row, i) => sum + weights[i]! * Number(row.outcomes[0]!.status === "FILLED"), 0) / total;
  assert.ok(Math.abs(estimate(model, features(), atMs).fillProbability - expectedFillProbability) < 1e-10);
});

test("future completed labels cannot change an earlier forecast and cache rewinds remain causal", () => {
  const samples = rows([{ values: features(), gross: 30 }], 24), atMs = now(samples);
  const model = trained(samples), original = predict(model, features(), atMs);
  const future = sample(atMs + DAY, features(.1), 1000);
  assert.equal(model.observe(future), true);
  assert.deepEqual(predict(model, features(), atMs), original);
  assert.notDeepEqual(predict(model, features(), future.completedAtMs), original);
  assert.deepEqual(predict(model, features(), atMs), original);
  assert.equal(estimate(model, features(), samples[0]!.completedAtMs - 1).reason, "NO_COMPLETED_SAMPLES");
});

test("leaf support never substitutes scenario count for observations or lowers the 48-sample gate", () => {
  const samples = rows([{ values: features(-.1), gross: -50 }, { values: features(.1), gross: 50 }], 14);
  const model = trained(samples), atMs = now(samples);
  estimate(model, features(.1), atMs);
  assert.equal(model.diagnostics().trees[0]!.leafCount, 1);
  assert.equal(estimate(model, features(.1), atMs).samples, 84);
  const insufficient = trained(rows([{ values: features(), gross: 50 }], 15));
  assert.equal(estimate(insufficient, features(), START + 2 * DAY + 6_000_000).reason, "INSUFFICIENT_SAMPLES");
  assert.ok(predict(insufficient, features(), START + 2 * DAY + 6_000_000)[0]!.meanNetBps !== null);
});

test("effective sample and requested date requirements remain explicit gates", () => {
  const sparse = rows([{ values: features(), gross: 70 }], 16, [0, 1, 25]);
  const sparseModel = trained(sparse), sparseEstimate = estimate(sparseModel, features(), now(sparse));
  assert.equal(sparseEstimate.observedDays, 3); assert.ok(sparseEstimate.effectiveSamples < 32);
  assert.equal(sparseEstimate.reason, "INSUFFICIENT_EFFECTIVE_SAMPLES");
  const samples = rows([{ values: features(), gross: 70 }], 24), model = trained(samples);
  assert.equal(estimate(model, features(), now(samples), 3).eligible, true);
  assert.equal(estimate(model, features(), now(samples), 7).reason, "INSUFFICIENT_DAYS");
  assert.equal(estimate(model, features(), now(samples), 4).reason, "INVALID_ESTIMATE_INPUT");
});

test("cached partitions expire when a selected leaf loses weighted day support, then rewind exactly", () => {
  const samples = [{ day: 0, count: 2, offset: 0 }, { day: 5, count: 23, offset: 0 }, { day: 6, count: 23, offset: 18 * 3_600_000 }]
    .flatMap(({ day, count, offset }) => Array.from({ length: count }, (_, i) => [-1, 1].map((side, j) =>
      sample(START + day * DAY + offset + (2 * i + j) * 360_000, features(side * .1), side * 50)))).flat();
  const model = trained(samples), atMs = now(samples), first = predict(model, features(.1), atMs);
  const initial = model.diagnostics().trees[0]!;
  assert.equal(initial.leafCount, 2); assert.ok(initial.expiresAtMs! > atMs);
  assert.equal(estimate(model, features(.1), initial.expiresAtMs! - 1).observedDays, 3);
  predict(model, features(.1), initial.expiresAtMs! + 1);
  assert.equal(model.diagnostics().trees[0]!.leafCount, 1);
  assert.deepEqual(predict(model, features(.1), atMs), first);
  assert.equal(model.diagnostics().trees[0]!.leafCount, 2);
});

test("sampling-phase volatility is never a split input even when it perfectly predicts synthetic labels", () => {
  const samples = rows([{ values: features(0, 0, -1), gross: -60 }, { values: features(0, 0, 1), gross: 60 }]);
  const model = trained(samples), atMs = now(samples);
  assert.deepEqual(predict(model, features(0, 0, -1), atMs), predict(model, features(0, 0, 1), atMs));
  assert.equal(model.diagnostics().trees[0]!.splitCount, 0);
  assert.deepEqual(REGIME_DISTRIBUTION_SPEC.excludedFeatureIndices, [5]);
});

test("uncertainty and loss-tail penalties still reject positive means and stale samples", () => {
  const samples = rows([{ values: features(), gross: -50 }, { values: features(), gross: 110 }], 16);
  const model = trained(samples), value = estimate(model, features(), now(samples));
  assert.ok(value.meanNetBps! > 1); assert.ok(value.lowerMeanNetBps! < value.meanNetBps!);
  assert.ok(value.tailLossBps! > 0); assert.ok(value.scoreBps! < value.lowerMeanNetBps!);
  assert.equal(value.reason, "SCORE_BELOW_MINIMUM");
  assert.equal(estimate(model, features(), now(samples) + DAY).reason, "STALE_TRAINING");
});

test("canonical validation, bounded inputs and returned diagnostics prevent corruption", () => {
  const model = new RegimeDistributionModel(), original = sample(START, features(), 30);
  assert.equal(model.observe(original), true); assert.equal(model.observe(original), false);
  assert.equal(model.observe(sample(START + 1000, features(), 30)), false);
  const malformed = sample(START + 360_000, features(), 30); malformed.outcomes[0]!.netBps = NaN;
  assert.equal(model.observe(malformed), false);
  const unknown = sample(START + 360_000, features(), 30);
  Object.assign(unknown.outcomes[0]!, { status: "INVALID", netBps: null, grossBps: null });
  assert.equal(model.observe(unknown), false);
  const atMs = original.completedAtMs + 1, before = predict(model, features(), atMs);
  original.outcomes[0]!.grossBps = 10000; original.features[0] = 1;
  assert.deepEqual(predict(model, features(), atMs), before);
  const diagnostics = model.diagnostics(); Object.assign(diagnostics.trees[0]!.tree, { threshold: 999 });
  assert.deepEqual(predict(model, features(), atMs), before);
  assert.ok(predict(model, features(2), atMs).every(row => row.meanNetBps === null));
  assert.ok(predict(model, features(NaN), atMs).every(row => row.meanNetBps === null));
  assert.equal(model.estimate("SOL/USD", "long-5m", features(), atMs, 3).reason, "INVALID_ESTIMATE_INPUT");
  assert.equal(model.stats().acceptedSamples, 1); assert.equal(model.stats().rejectedSamples, 4);
  assert.equal(model.stats().version, S.version); assert.equal(model.stats().modelVersion, REGIME_DISTRIBUTION_SPEC.version);
});

test("repeated fits are deterministic and asset/action banks remain isolated", () => {
  const samples = rows([{ values: features(-.1), gross: -50 }, { values: features(.1), gross: 50 }]);
  const a = trained(samples), b = trained(samples), atMs = now(samples);
  assert.deepEqual(predict(a, features(.1), atMs), predict(b, features(.1), atMs));
  assert.deepEqual(a.diagnostics(), b.diagnostics());
  assert.equal(a.estimate("ETH/USD", "long-5m", features(.1), atMs, 3).reason, "NO_COMPLETED_SAMPLES");
  assert.equal(a.estimate("BTC/USD", "short-5m", features(.1), atMs, 3).reason, "NO_COMPLETED_SAMPLES");
});
