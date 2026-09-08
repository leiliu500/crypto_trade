import assert from "node:assert/strict";
import test from "node:test";
import { ConditionalDistributionModel, DISTRIBUTION_SUPPORT } from "../src/distribution/model.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC,
  type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, STEP = DISTRIBUTION_SPEC.proposalIntervalMs;
const features = (first = 0) => [first, ...Array<number>(DISTRIBUTION_SPEC.featureDimension - 1).fill(0)];

function sample(signalAtMs: number, net: number | number[] = 25, firstFeature = 0,
  actionId = "long-15m", symbol = "BTC/USD"): DistributionSample {
  const action = DISTRIBUTION_ACTIONS.find(a => a.id === actionId)!;
  const outcomes = DISTRIBUTION_SCENARIOS.map((scenario, index) => ({ scenario: scenario.id,
    status: "FILLED" as const, netBps: typeof net === "number" ? net : net[index]!,
    grossBps: (typeof net === "number" ? net : net[index]!) + 10,
    filledFraction: 1, entryAtMs: signalAtMs + scenario.latencyMs,
    exitAtMs: signalAtMs + action.horizonMs + scenario.latencyMs, reason: "DEADLINE" }));
  return { id: `${symbol}:${actionId}:${signalAtMs}`, symbol, actionId, signalAtMs,
    completedAtMs: Math.max(...outcomes.map(o => o.exitAtMs)), features: features(firstFeature), outcomes };
}

function train(model: ConditionalDistributionModel, factory: (day: number, index: number) => DistributionSample =
  (day, index) => sample(day * DAY + index * STEP), days = 8, perDay = 12): DistributionSample[] {
  const samples: DistributionSample[] = [];
  for (let day = 0; day < days; day++) for (let index = 0; index < perDay; index++) {
    const value = factory(day, index); assert.equal(model.observe(value), true); samples.push(value);
  }
  return samples;
}

test("conditional distribution can recognize repeatable positive net outcomes and abstains on losing outcomes", () => {
  for (const net of [25, -5]) {
    const model = new ConditionalDistributionModel();
    const history = train(model, (day, i) => sample(day * DAY + i * STEP, net));
    const estimate = model.estimate("BTC/USD", "long-15m", features(), history.at(-1)!.completedAtMs);
    assert.equal(estimate.samples, 96); assert.equal(estimate.observedDays, 8);
    assert.ok(estimate.effectiveSamples >= DISTRIBUTION_SPEC.minimumEffectiveSamples);
    assert.equal(estimate.eligible, net > 0);
    assert.ok(net > 0 ? estimate.scoreBps! > 1 && estimate.meanNetBps! < net : estimate.scoreBps! < 0);
    assert.equal(estimate.reason, net > 0 ? "POSITIVE_DISTRIBUTIONAL_SCORE" : "SCORE_BELOW_MINIMUM");
  }
});

test("fixed market-feature neighborhoods distinguish contexts and abstain outside observed support", () => {
  const model = new ConditionalDistributionModel();
  const history = train(model, (day, i) => sample(day * DAY + i * STEP, i % 2 ? -25 : 25, i % 2 ? -1 : 1), 8, 24);
  const now = history.at(-1)!.completedAtMs;
  const positive = model.estimate("BTC/USD", "long-15m", features(1), now);
  const negative = model.estimate("BTC/USD", "long-15m", features(-1), now);
  assert.equal(positive.eligible, true); assert.equal(negative.eligible, false);
  assert.equal(positive.samples, 96); assert.equal(negative.samples, 96);
  const distant = Array<number>(DISTRIBUTION_SPEC.featureDimension).fill(1);
  assert.equal(model.estimate("BTC/USD", "long-15m", distant, now).reason, "OUT_OF_SUPPORT");
  // A single nearby sample cannot admit an otherwise distant high-count cloud.
  const fresh = sample(8 * DAY, 25); fresh.features = distant;
  assert.equal(model.observe(fresh), true);
  const isolated = model.estimate("BTC/USD", "long-15m", distant, fresh.completedAtMs);
  assert.equal(isolated.samples, 1); assert.equal(isolated.eligible, false);
  assert.equal(DISTRIBUTION_SUPPORT.maximumDistance, 1.5);
});

test("the worst matched cost or execution scenario controls the estimate", () => {
  const model = new ConditionalDistributionModel();
  const history = train(model, (day, i) => sample(day * DAY + i * STEP, [30, 20, -3]));
  const result = model.estimate("BTC/USD", "long-15m", features(), history.at(-1)!.completedAtMs);
  assert.equal(result.eligible, false); assert.ok(result.meanNetBps! < 0); assert.ok(Math.abs(result.tailLossBps! - 3) < 1e-10);
  const feeFailure = new ConditionalDistributionModel();
  const feeHistory = train(feeFailure, (day, i) => sample(day * DAY + i * STEP, [30, -5, 20]));
  assert.equal(feeFailure.estimate("BTC/USD", "long-15m", features(), feeHistory.at(-1)!.completedAtMs).eligible, false);
});

test("net returns already include fees and partial fills, and nonfills remain zero in the original denominator", () => {
  const model = new ConditionalDistributionModel();
  const history = train(model, (day, i) => {
    const value = sample(day * DAY + i * STEP, 10);
    for (const outcome of value.outcomes) {
      outcome.filledFraction = .5;
      if (i % 2) Object.assign(outcome, { status: "UNFILLED", filledFraction: 0, entryAtMs: null, netBps: 0, grossBps: 0 });
    }
    return value;
  });
  const now = history.at(-1)!.completedAtMs, result = model.estimate("BTC/USD", "long-15m", features(), now);
  const weights = history.map(s => 2 ** (-(now - s.completedAtMs) / DISTRIBUTION_SPEC.memoryHalfLifeMs));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const numerator = history.reduce((sum, s, i) => sum + weights[i]! * s.outcomes[0]!.netBps!, 0);
  assert.ok(Math.abs(result.meanNetBps! - numerator / (total + DISTRIBUTION_SPEC.priorWeight)) < 1e-10);
  assert.ok(result.fillProbability > .49 && result.fillProbability < .51);
  assert.equal(result.samples, 96);
});

test("sample validation rejects incomplete stress panels, malformed fills, future exits and invalid features", () => {
  const corruptions: Array<(s: DistributionSample) => void> = [
    s => { s.outcomes.pop(); },
    s => { s.outcomes[1]!.scenario = s.outcomes[0]!.scenario; },
    s => { s.outcomes[0]!.status = "INVALID"; },
    s => { s.outcomes[0]!.netBps = null; },
    s => { s.outcomes[0]!.netBps = 50; },
    s => { s.outcomes[0]!.entryAtMs = s.signalAtMs; },
    s => { s.completedAtMs = s.outcomes[0]!.exitAtMs - 1; },
    s => { s.outcomes[0]!.filledFraction = 1.1; },
    s => { s.outcomes[0]!.filledFraction = 0; },
    s => { s.outcomes[0]!.status = "UNFILLED"; },
    s => { s.features.pop(); },
    s => { s.features[0] = NaN; },
    s => { s.features[0] = 1.1; },
    s => { s.id = "incorrect-origin"; },
    s => { s.signalAtMs = -1; },
    s => { s.actionId = "unknown"; },
    s => { s.symbol = "LTC/USD"; },
  ];
  for (const corrupt of corruptions) {
    const model = new ConditionalDistributionModel(), value = sample(0); corrupt(value);
    assert.equal(model.observe(value), false); assert.equal(model.stats().acceptedSamples, 0);
  }
});

test("completed future labels cannot leak into earlier predictions and caller mutation cannot rewrite training", () => {
  const prefix = new ConditionalDistributionModel(), longer = new ConditionalDistributionModel();
  const history = train(prefix);
  for (const value of history) assert.equal(longer.observe(value), true);
  const cutoff = history.at(-1)!.completedAtMs;
  const before = prefix.estimate("BTC/USD", "long-15m", features(), cutoff);
  assert.equal(longer.observe(sample(9 * DAY, -500)), true);
  assert.deepEqual(longer.estimate("BTC/USD", "long-15m", features(), cutoff), before);
  history[0]!.features[0] = 1; history[0]!.outcomes[0]!.netBps = -100_000;
  assert.deepEqual(prefix.estimate("BTC/USD", "long-15m", features(), cutoff), before);
  const future = new ConditionalDistributionModel(); future.observe(sample(9 * DAY));
  assert.equal(future.estimate("BTC/USD", "long-15m", features(), cutoff).reason, "NO_COMPLETED_SAMPLES");
});

test("nonoverlap, canonical identity, and bounded retention reject duplicates even after eviction", () => {
  const model = new ConditionalDistributionModel(), first = sample(0);
  assert.equal(model.observe(first), true); assert.equal(model.observe(first), false);
  assert.equal(model.observe(sample(first.completedAtMs - 1)), false);
  assert.equal(model.observe({ ...sample(STEP), id: first.id }), false);
  for (let i = 1; i <= DISTRIBUTION_SPEC.maximumSamples; i++) assert.equal(model.observe(sample(i * STEP)), true);
  assert.equal(model.stats().retainedSamples, DISTRIBUTION_SPEC.maximumSamples);
  assert.equal(model.observe(first), false);
  // Different actions and symbols have separate exposure and timestamp banks.
  assert.equal(model.observe(sample(0, 20, 0, "short-15m")), true);
  assert.equal(model.observe(sample(0, 20, 0, "long-15m", "ETH/USD")), true);
});

test("calendar coverage and training freshness are required in addition to raw trade count", () => {
  const concentrated = new ConditionalDistributionModel();
  const shortHistory = train(concentrated, (day, i) => sample(day * DAY + i * STEP), 2, 24);
  const concentratedEstimate = concentrated.estimate("BTC/USD", "long-15m", features(), shortHistory.at(-1)!.completedAtMs);
  assert.equal(concentratedEstimate.samples, 48); assert.equal(concentratedEstimate.reason, "INSUFFICIENT_DAYS");
  const model = new ConditionalDistributionModel(), history = train(model), latest = history.at(-1)!.completedAtMs;
  assert.equal(model.estimate("BTC/USD", "long-15m", features(), latest + DAY + 1).reason, "STALE_TRAINING");
  const sparse = new ConditionalDistributionModel();
  const sparseHistory = train(sparse, (day, i) => sample(day * DAY + i * STEP), 8, 3);
  const sparseResult = sparse.estimate("BTC/USD", "long-15m", features(), sparseHistory.at(-1)!.completedAtMs);
  assert.equal(sparseResult.observedDays, 8); assert.equal(sparseResult.reason, "INSUFFICIENT_SAMPLES");
});

test("Kish effective sample count uses kernel and time weights instead of counting weak labels equally", () => {
  const model = new ConditionalDistributionModel();
  const history = train(model, (day, i) => sample(day * DAY + i * STEP, 25, i % 2 ? 1 : 0));
  const now = history.at(-1)!.completedAtMs, result = model.estimate("BTC/USD", "long-15m", features(), now);
  const weights = history.map(s => Math.exp(-(s.features[0]! ** 2) / 2)
    * 2 ** (-(now - s.completedAtMs) / DISTRIBUTION_SPEC.memoryHalfLifeMs));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const expected = total ** 2 / weights.reduce((sum, value) => sum + value ** 2, 0);
  assert.ok(Math.abs(result.effectiveSamples - expected) < 1e-10);
  assert.ok(result.effectiveSamples < result.samples);
});

test("many low-weight older labels do not satisfy the effective-sample requirement", () => {
  const model = new ConditionalDistributionModel(), now = 30 * DAY + 12 * STEP;
  for (let day = 0; day < 7; day++) {
    let dayWeight = 0;
    for (let i = 0; dayWeight < 1.01; i++) {
      const value = sample(day * DAY + i * STEP);
      assert.equal(model.observe(value), true);
      dayWeight += 2 ** (-(now - value.completedAtMs) / DISTRIBUTION_SPEC.memoryHalfLifeMs);
    }
  }
  for (let i = 0; i < 12; i++) assert.equal(model.observe(sample(30 * DAY + i * STEP)), true);
  const result = model.estimate("BTC/USD", "long-15m", features(), now);
  assert.ok(result.samples >= DISTRIBUTION_SPEC.minimumSamples);
  assert.equal(result.observedDays, 8);
  assert.ok(result.effectiveSamples < DISTRIBUTION_SPEC.minimumEffectiveSamples);
  assert.equal(result.reason, "INSUFFICIENT_EFFECTIVE_SAMPLES");
});

test("daily shared shocks increase uncertainty and observed downside tails reduce the score", () => {
  const independent = new ConditionalDistributionModel(), clustered = new ConditionalDistributionModel();
  const a = train(independent, (day, i) => sample(day * DAY + i * STEP, i % 2 ? 40 : -20));
  const b = train(clustered, (day, i) => sample(day * DAY + i * STEP, day % 2 ? 40 : -20));
  const first = independent.estimate("BTC/USD", "long-15m", features(), a.at(-1)!.completedAtMs);
  const second = clustered.estimate("BTC/USD", "long-15m", features(), b.at(-1)!.completedAtMs);
  assert.ok(second.meanNetBps! - second.lowerMeanNetBps! > first.meanNetBps! - first.lowerMeanNetBps!);
  assert.ok(Math.abs(first.tailLossBps! - 20) < 1e-10);
  assert.ok(Math.abs(first.scoreBps! - (first.lowerMeanNetBps! - DISTRIBUTION_SPEC.tailPenalty * 20)) < 1e-10);
  assert.equal(second.eligible, false);
});
