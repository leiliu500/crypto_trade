import assert from "node:assert/strict";
import test from "node:test";
import { CostAwareRidgeModel, COST_AWARE_RIDGE_SPEC } from "../src/distribution/cost-aware-model.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, STEP = 31 * 60_000, CUTOFF = 3 * DAY;
const features = (x = 0): number[] => [x, ...Array<number>(11).fill(0)];
function sample(signalAtMs: number, x = 0, grossPerFilled = 0, costPerFilled = 13, fraction = 1,
  symbol = "BTC/USD", actionId = "long-5m"): DistributionSample {
  const action = DISTRIBUTION_ACTIONS.find(action => action.id === actionId)!;
  return { id: `${symbol}:${actionId}:${signalAtMs}`, symbol, actionId, signalAtMs,
    completedAtMs: signalAtMs + action.horizonMs + 1500, features: features(x),
    outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({ scenario: scenario.id,
      status: fraction ? "FILLED" : "UNFILLED", grossBps: grossPerFilled * fraction,
      netBps: (grossPerFilled - costPerFilled * scenario.feeMultiplier) * fraction,
      filledFraction: fraction, entryAtMs: fraction ? signalAtMs + scenario.latencyMs : null,
      exitAtMs: signalAtMs + action.horizonMs + 2 * scenario.latencyMs, reason: fraction ? "DEADLINE" : "IOC_UNFILLED" })) };
}
function training(factory: (at: number, index: number) => DistributionSample = at => sample(at)): DistributionSample[] {
  return Array.from({ length: 60 }, (_, index) => factory(Math.floor(index / 20) * DAY + index % 20 * STEP, index));
}
const base = (model: CostAwareRidgeModel, x = 0, now = CUTOFF) => model.predictScenarios("BTC/USD", "long-5m", features(x), now)[0]!;
const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("fixed ridge learns a directional gross relationship that a constant forecast misses", () => {
  const samples = training((at, i) => sample(at, i % 2 ? 1 : -1, i % 2 ? 80 : -80));
  const model = new CostAwareRidgeModel(samples, CUTOFF);
  const constant = samples.reduce((sum, row) => sum + row.outcomes[0]!.netBps!, 0) / samples.length;
  for (const x of [-.8, .8]) {
    const prediction = base(model, x), truth = 80 * x - 13;
    assert.equal(prediction.reason, "READY"); assert.equal(prediction.samples, 60);
    assert.ok(Math.abs(prediction.meanNetBps! - truth) < Math.abs(constant - truth) / 2);
    assert.equal(Math.sign(prediction.meanNetBps!), Math.sign(truth));
    near(prediction.costBps!, 13); near(prediction.filledFraction!, 1);
  }
  assert.equal(COST_AWARE_RIDGE_SPEC.ridgeLambda, 16);
  assert.equal(COST_AWARE_RIDGE_SPEC.researchOnly, true);
  assert.equal("eligible" in base(model), false, "a forecast does not grant entry permission");
});

test("zero gross return with positive costs stays negative even with ridge regularization", () => {
  const model = new CostAwareRidgeModel(training((at, i) => sample(at, i % 2 ? 1 : -1, 0, 13)), CUTOFF);
  for (const x of [-1, 0, 1]) for (const prediction of model.predictScenarios("BTC/USD", "long-5m", features(x), CUTOFF)) {
    assert.equal(prediction.reason, "READY"); near(prediction.grossBps!, 0);
    assert.ok(prediction.costBps! >= 13 - 1e-9); near(prediction.meanNetBps!, -prediction.costBps!);
  }
});

test("partial fills preserve the requested-notional denominator and cost intercept is not shrunk", () => {
  const model = new CostAwareRidgeModel(training(at => sample(at, 0, 20, 8, .25)), CUTOFF);
  const prediction = base(model);
  assert.equal(prediction.reason, "READY"); near(prediction.filledFraction!, .25);
  near(prediction.grossBps!, 5); near(prediction.costBps!, 2); near(prediction.meanNetBps!, 3);
  const fit = model.diagnostics().fits.find(fit => fit.symbol === "BTC/USD" && fit.actionId === "long-5m" && fit.scenario === "base-250ms")!;
  near(fit.fill!.intercept, .25); near(fit.grossPerFilledUnit!.intercept, 20); near(fit.costPerFilledUnitBps!, 8);
  assert.ok(fit.fill!.coefficients.every(coefficient => coefficient === 0));
  assert.ok(fit.fill!.scales.every(scale => scale === .1), "constant training coordinates use the fixed scale floor");
});

test("higher observed costs reduce net forecasts without changing fitted gross or fill fractions", () => {
  const cheap = new CostAwareRidgeModel(training((at, i) => sample(at, i % 2 ? 1 : -1, 30, 5, .5)), CUTOFF);
  const expensive = new CostAwareRidgeModel(training((at, i) => sample(at, i % 2 ? 1 : -1, 30, 15, .5)), CUTOFF);
  const first = cheap.predictScenarios("BTC/USD", "long-5m", features(.5), CUTOFF);
  const second = expensive.predictScenarios("BTC/USD", "long-5m", features(.5), CUTOFF);
  first.forEach((row, i) => {
    near(second[i]!.grossBps!, row.grossBps!); near(second[i]!.filledFraction!, row.filledFraction!);
    near(row.meanNetBps! - second[i]!.meanNetBps!, 5 * DISTRIBUTION_SCENARIOS[i]!.feeMultiplier);
  });
});

test("genuine nonfills enter the fraction regression while absent or ineffective filled support remains unavailable", () => {
  const none = new CostAwareRidgeModel(training(at => sample(at, 0, 0, 13, 0)), CUTOFF);
  assert.equal(base(none).reason, "INSUFFICIENT_FILLED_SUPPORT");
  assert.equal(base(none).filledEffectiveSamples, 0); assert.equal(base(none).meanNetBps, null);
  const mostly = new CostAwareRidgeModel(training((at, i) => sample(at, 0, 20, 13, i % 2 ? 0 : 1)), CUTOFF);
  const p = base(mostly);
  assert.equal(p.reason, "READY"); assert.ok(p.filledFraction! > .49 && p.filledFraction! < .51);
  near(p.grossBps!, p.filledFraction! * 20); near(p.costBps!, p.filledFraction! * 13);
  const weak = new CostAwareRidgeModel(training((at, i) => sample(at, 0, 20, 13, i === 0 ? 1 : i < 17 ? .0001 : 0)), CUTOFF);
  assert.equal(base(weak).reason, "INSUFFICIENT_FILLED_SUPPORT");
  assert.ok(base(weak).filledEffectiveSamples < 2, "effective filled support uses recency times fraction");
});

test("strict cutoff, canonical validation and prediction clock prevent future or malformed label use", () => {
  const rows = training();
  for (const completedAtMs of [CUTOFF, CUTOFF + 1]) {
    const future = structuredClone(rows); future[0]!.completedAtMs = completedAtMs;
    assert.throws(() => new CostAwareRidgeModel(future, CUTOFF), /FUTURE/);
  }
  const corruptions: Array<(row: DistributionSample) => void> = [
    row => { row.outcomes[0]!.status = "INVALID"; row.outcomes[0]!.netBps = null; },
    row => { row.outcomes.pop(); }, row => { row.features[0] = NaN; }, row => { row.symbol = "DOGE/USD"; },
    row => { row.outcomes[0]!.filledFraction = 1.1; }, row => { row.id = "wrong"; },
  ];
  for (const corrupt of corruptions) {
    const invalid = structuredClone(rows); corrupt(invalid[0]!);
    assert.throws(() => new CostAwareRidgeModel(invalid, CUTOFF), /TRAINING_SAMPLE/);
  }
  assert.throws(() => new CostAwareRidgeModel([...rows, rows[0]!], CUTOFF), /TRAINING_SAMPLE/);
  const overlapping = sample(1000); assert.throws(() => new CostAwareRidgeModel([...rows, overlapping], CUTOFF), /TRAINING_SAMPLE/);
  const model = new CostAwareRidgeModel(rows, CUTOFF);
  assert.equal(base(model, 0, CUTOFF - 1).reason, "INVALID_COST_AWARE_PREDICTION_INPUT");
  assert.equal(base(model, 0, CUTOFF + DAY).reason, "STALE_TRAINING");
  assert.ok(model.predictScenarios("BTC/USD", "long-5m", features(1.1), CUTOFF).every(row => row.meanNetBps === null));
  assert.ok(model.predictScenarios("BTC/USD", "long-5m", [0], CUTOFF).every(row => row.meanNetBps === null));
});

test("asset/action banks stay isolated and fits remain deterministic and immutable after construction", () => {
  const btc = training((at, i) => sample(at, i % 2 ? 1 : -1, i % 2 ? 80 : -80));
  const eth = training(at => sample(at, 0, -60, 13, 1, "ETH/USD"));
  const short = training(at => sample(at, 0, -20, 13, 1, "BTC/USD", "short-5m"));
  const single = new CostAwareRidgeModel(btc, CUTOFF), model = new CostAwareRidgeModel([...btc, ...eth, ...short], CUTOFF);
  assert.deepEqual(base(single, .7), base(model, .7));
  assert.ok(single.predictScenarios("ETH/USD", "long-5m", features(), CUTOFF).every(row => row.reason === "NO_TRAINING_SAMPLES"));
  assert.ok(single.predictScenarios("BTC/USD", "short-5m", features(), CUTOFF).every(row => row.reason === "NO_TRAINING_SAMPLES"));
  const reordered = new CostAwareRidgeModel([...btc, ...eth, ...short].reverse(), CUTOFF);
  assert.deepEqual(model.diagnostics(), reordered.diagnostics());
  const before = model.diagnostics(); btc[0]!.features[0] = 0; btc[0]!.outcomes[0]!.netBps = -999;
  const exposed = model.diagnostics(); exposed.fits[0]!.trainingSampleIds.push("invented");
  if (exposed.fits[0]!.fill) exposed.fits[0]!.fill!.coefficients[0] = 999;
  assert.deepEqual(model.diagnostics(), before);
});

test("sample/day support and per-action retained banks remain bounded", () => {
  assert.equal(base(new CostAwareRidgeModel(training().slice(0, 47), CUTOFF)).reason, "INSUFFICIENT_SAMPLES");
  const oneDay = Array.from({ length: 60 }, (_, i) => sample(i * 360_000));
  assert.equal(base(new CostAwareRidgeModel(oneDay, DAY), 0, DAY).reason, "INSUFFICIENT_DAYS");
  const rows = Array.from({ length: COST_AWARE_RIDGE_SPEC.maximumSamplesPerAction + 1 }, (_, i) => sample(i * STEP));
  const cutoff = rows.at(-1)!.completedAtMs + 1, model = new CostAwareRidgeModel(rows, cutoff), stats = model.diagnostics();
  assert.equal(stats.acceptedSamples, rows.length); assert.equal(stats.retainedSamples, COST_AWARE_RIDGE_SPEC.maximumSamplesPerAction);
  const fit = stats.fits.find(row => row.symbol === "BTC/USD" && row.actionId === "long-5m" && row.scenario === "base-250ms")!;
  assert.equal(fit.trainingSampleIds.length, COST_AWARE_RIDGE_SPEC.maximumSamplesPerAction);
  assert.equal(fit.trainingSampleIds.includes(rows[0]!.id), false);
  assert.equal(model.predictScenarios("BTC/USD", "long-5m", features(), cutoff)[0]!.samples, COST_AWARE_RIDGE_SPEC.maximumSamplesPerAction);
});
