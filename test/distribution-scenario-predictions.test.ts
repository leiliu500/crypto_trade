import assert from "node:assert/strict";
import test from "node:test";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC, type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, STEP = DISTRIBUTION_SPEC.proposalIntervalMs;
const features = (first = 0) => [first, ...Array<number>(DISTRIBUTION_SPEC.featureDimension - 1).fill(0)];
function sample(signalAtMs: number, nets = [30, 15, -5], first = 0): DistributionSample {
  const outcomes = DISTRIBUTION_SCENARIOS.map((scenario, index) => ({ scenario: scenario.id,
    status: "FILLED" as const, netBps: nets[index]!, grossBps: nets[index]! + 10,
    filledFraction: 1, entryAtMs: signalAtMs + scenario.latencyMs,
    exitAtMs: signalAtMs + 300_000 + scenario.latencyMs, reason: "DEADLINE" }));
  return { id: `BTC/USD:long-5m:${signalAtMs}`, symbol: "BTC/USD", actionId: "long-5m", signalAtMs,
    completedAtMs: Math.max(...outcomes.map(o => o.exitAtMs)), features: features(first), outcomes };
}
function predict(model: ConditionalDistributionModel, nowMs: number, context = features()) {
  return model.predictScenarios("BTC/USD", "long-5m", context, nowMs);
}
function assertMissing(rows: ReturnType<typeof predict>): void {
  assert.deepEqual(rows, DISTRIBUTION_SCENARIOS.map(s => ({ scenario: s.id,
    meanNetBps: null, samples: 0, effectiveSamples: 0 })));
}

test("scenario forecasts match production means for each matching cost outcome without using the worst scenario for all", () => {
  const model = new ConditionalDistributionModel();
  const scenarioControls = DISTRIBUTION_SCENARIOS.map(() => new ConditionalDistributionModel());
  let now = 0;
  for (let day = 0; day < 8; day++) for (let i = 0; i < 12; i++) {
    const row = sample(day * DAY + i * STEP, [30 + day, 15 + day, -5 + day], i % 2 ? .5 : 0);
    assert.equal(model.observe(row), true); now = row.completedAtMs;
    for (let scenarioIndex = 0; scenarioIndex < scenarioControls.length; scenarioIndex++) {
      const control = structuredClone(row), reference = row.outcomes[scenarioIndex]!;
      control.outcomes = control.outcomes.map(o => ({ ...o, netBps: reference.netBps, grossBps: reference.grossBps }));
      assert.equal(scenarioControls[scenarioIndex]!.observe(control), true);
    }
  }
  const rows = predict(model, now);
  assert.deepEqual(rows.map(r => r.scenario), DISTRIBUTION_SCENARIOS.map(s => s.id));
  for (let i = 0; i < rows.length; i++) {
    const control = scenarioControls[i]!.estimate("BTC/USD", "long-5m", features(), now);
    assert.equal(rows[i]!.meanNetBps, control.meanNetBps);
    assert.equal(rows[i]!.samples, control.samples);
    assert.equal(rows[i]!.effectiveSamples, control.effectiveSamples);
  }
  assert.ok(rows[0]!.meanNetBps! > rows[1]!.meanNetBps!);
  assert.ok(rows[1]!.meanNetBps! > rows[2]!.meanNetBps!);
  assert.equal(model.estimate("BTC/USD", "long-5m", features(), now).meanNetBps, rows[2]!.meanNetBps);
});

test("scenario forecasts exclude outcomes that have not completed at the prediction time", () => {
  const model = new ConditionalDistributionModel(), first = sample(0);
  assert.equal(model.observe(first), true);
  assertMissing(predict(model, first.completedAtMs - 1));
  const before = predict(model, first.completedAtMs);
  assert.equal(before[0]!.samples, 1);
  assert.equal(model.observe(sample(STEP, [900, 800, 700])), true);
  assert.deepEqual(predict(model, first.completedAtMs), before);
  const futureOnly = new ConditionalDistributionModel();
  assert.equal(futureOnly.observe(sample(DAY)), true);
  assertMissing(predict(futureOnly, first.completedAtMs));
});

test("scenario forecasts preserve coordinate, radius and recency support instead of inventing zero forecasts", () => {
  const model = new ConditionalDistributionModel(), row = sample(0, [30, 15, -5], -1);
  assert.equal(model.observe(row), true);
  assertMissing(predict(model, row.completedAtMs, features(1)));
  assertMissing(predict(model, row.completedAtMs, Array<number>(DISTRIBUTION_SPEC.featureDimension).fill(-1)));
  assertMissing(predict(model, row.completedAtMs + 100 * DAY, row.features));
  assertMissing(new ConditionalDistributionModel().predictScenarios("BTC/USD", "long-5m", features(), 0));
  assertMissing(model.predictScenarios("ETH/USD", "long-5m", row.features, row.completedAtMs));
  assertMissing(model.predictScenarios("BTC/USD", "short-5m", row.features, row.completedAtMs));
});

test("invalid scenario prediction inputs return explicit missing predictions for every scenario", () => {
  const model = new ConditionalDistributionModel(), row = sample(0);
  assert.equal(model.observe(row), true);
  for (const input of [features(NaN), features(Infinity), features(1.01), [], features().slice(1)])
    assertMissing(predict(model, row.completedAtMs, input));
  for (const now of [NaN, Infinity, -1, 1.5]) assertMissing(predict(model, now));
  assertMissing(model.predictScenarios("LTC/USD", "long-5m", features(), row.completedAtMs));
  assertMissing(model.predictScenarios("BTC/USD", "unknown", features(), row.completedAtMs));
});

test("research forecasts do not relax entry gates or mutate estimates and model state", () => {
  const model = new ConditionalDistributionModel(), row = sample(0);
  assert.equal(model.observe(row), true);
  const before = model.estimate("BTC/USD", "long-5m", features(), row.completedAtMs, 3);
  const stats = model.stats(), predictions = predict(model, row.completedAtMs);
  assert.equal(before.eligible, false); assert.equal(before.reason, "INSUFFICIENT_DAYS");
  assert.equal(predictions[0]!.meanNetBps, 30 / (1 + DISTRIBUTION_SPEC.priorWeight));
  assert.equal(predictions[1]!.meanNetBps, 15 / (1 + DISTRIBUTION_SPEC.priorWeight));
  predictions[0]!.meanNetBps = 1_000_000; predictions[0]!.samples = 999_999;
  assert.deepEqual(model.estimate("BTC/USD", "long-5m", features(), row.completedAtMs, 3), before);
  assert.deepEqual(model.stats(), stats);
  assert.equal(predict(model, row.completedAtMs)[0]!.samples, 1);
});
