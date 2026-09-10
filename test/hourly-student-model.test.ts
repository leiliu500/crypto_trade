import assert from "node:assert/strict";
import test from "node:test";
import { fitLinearStudent, fitStudentBoost, STUDENT_BOOST_SPEC, studentNaturalGradient5,
  studentTCdf5, studentTNll5, studentTQuantile5, type StudentTrainingRow } from "../src/research/hourly-student-model.js";

const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} within ${tolerance} of ${expected}`);
function integrate(f: (x: number) => number, from: number, to: number, pieces = 4096): number {
  const width = (to - from) / pieces;
  let sum = f(from) + f(to);
  for (let i = 1; i < pieces; i++) sum += (i % 2 ? 4 : 2) * f(from + i * width);
  return sum * width / 3;
}

test("Student-t NLL includes the correct normalization and has stable extreme tails", () => {
  const densityAtZero = 8 / (3 * Math.PI * Math.sqrt(5));
  near(studentTNll5(7, 7, 1), -Math.log(densityAtZero));
  near(studentTNll5(7, 7, 10), -Math.log(densityAtZero) + Math.log(10));
  near(studentTNll5(9, 1, 3), studentTNll5(-7, 1, 3));
  near(Math.exp(-studentTNll5(Math.sqrt(5), 0, 1)), densityAtZero / 8);
  assert.ok(Number.isFinite(studentTNll5(1e200, 0, 1)));
  assert.throws(() => studentTNll5(1, 0, 0), /INVALID_DISTRIBUTION/);
  assert.throws(() => studentTNll5(NaN, 0, 1), /INVALID_DISTRIBUTION/);
});

test("natural gradients agree with numerical NLL derivatives and the t5 Fisher metric", () => {
  for (const [y, location, scale] of [[-20, 5, 8], [30, -2, 40], [4, 4, 1], [200, 0, 3]]) {
    const g = studentNaturalGradient5(y!, location!, scale!), locationStep = 1e-5, logStep = 1e-6;
    const dLocation = (studentTNll5(y!, location! + locationStep, scale!) - studentTNll5(y!, location! - locationStep, scale!)) / (2 * locationStep);
    const dLogScale = (studentTNll5(y!, location!, scale! * Math.exp(logStep)) - studentTNll5(y!, location!, scale! * Math.exp(-logStep))) / (2 * logStep);
    near(g.location, dLocation / (6 / (8 * scale! ** 2)), 2e-6);
    near(g.logScale, dLogScale / (10 / 8), 2e-8);
  }
  const extreme = studentNaturalGradient5(1e200, 0, 1);
  assert.ok(Number.isFinite(extreme.location)); near(extreme.logScale, -4);
});

test("t5 CDF matches independent quadrature in central and far-tail regions", () => {
  const constant = 8 / (3 * Math.PI * Math.sqrt(5));
  for (const x of [.1, .5, 1, Math.sqrt(5), 4.4, 5, 10, 20]) {
    const integrated = .5 + integrate(t => constant * (1 + t * t / 5) ** -3, 0, x);
    near(studentTCdf5(x), integrated, 1e-10);
    near(studentTCdf5(-x), 1 - studentTCdf5(x), 1e-14);
  }
  for (const x of [10, 100, 10_000]) {
    const upper = Math.sqrt(5) / x;
    const tail = integrate(u => 8 / (3 * Math.PI) * u ** 4 / (1 + u * u) ** 3, 0, upper);
    near(studentTCdf5(-x) / tail, 1, 1e-11);
  }
  assert.equal(studentTCdf5(0), .5); assert.equal(studentTCdf5(-Infinity), 0); assert.equal(studentTCdf5(Infinity), 1);
  assert.throws(() => studentTCdf5(NaN), /INVALID_CDF/);
});

test("t5 quantiles invert the CDF including the declared 10th and 90th percentiles", () => {
  near(studentTQuantile5(.9), 1.475884048824481, 1e-10);
  near(studentTQuantile5(.1), -1.475884048824481, 1e-10);
  near(studentTQuantile5(.975), 2.570581835636305, 1e-10);
  for (const probability of [1e-12, .0001, .01, .1, .25, .5, .9, .99, 1 - 1e-12]) {
    near(studentTCdf5(studentTQuantile5(probability)), probability, 2e-15);
  }
  assert.equal(studentTQuantile5(0), -Infinity); assert.equal(studentTQuantile5(1), Infinity);
  assert.throws(() => studentTQuantile5(-.01), /INVALID_QUANTILE/);
});

test("linear baseline uses weighted ridge16 with an unpenalized intercept and exact residual scale", () => {
  const rows = [{ features: [-1, 0], target: 0, weight: 1 }, { features: [1, 0], target: 30, weight: 2 }];
  const model = fitLinearStudent(rows, 2), diagnostic = model.diagnostics(), scale = Math.sqrt(8 / 9);
  near(diagnostic.intercept, 20); near(diagnostic.centers[0]!, 1 / 3); near(diagnostic.scales[0]!, scale);
  assert.equal(diagnostic.scales[1], .1); near(diagnostic.weightedESS, 9 / 5);
  near(diagnostic.coefficients[0]!, 15 * scale * 3 / 19); assert.equal(diagnostic.coefficients[1], 0);
  near(model.predict([1, 0]).location, 20 + 10 * 3 / 19);
  near(diagnostic.residualMean, 0); near(diagnostic.residualVariance, 200 * (16 / 19) ** 2);
  near(model.predict([0, 0]).scale, Math.sqrt(diagnostic.residualVariance * 3 / 5));
});

test("constant negative net targets retain their costs and the positive scale floor", () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({ features: [i % 7, 1], target: -13, weight: 1 }));
  for (const model of [fitStudentBoost(rows, 2), fitLinearStudent(rows, 2)]) {
    assert.deepEqual(model.predict([100, 1]), { location: -13, scale: 1 });
  }
});

test("boost trees enforce raw leaf support and deterministic feature ties", () => {
  const rows = Array.from({ length: 512 }, (_, i) => ({ features: [i < 256 ? -1 : 1, i < 256 ? -1 : 1], target: i < 256 ? -100 : 100, weight: 1 }));
  const enough = fitStudentBoost(rows, 2).diagnostics(), short = fitStudentBoost(rows.slice(0, 511), 2).diagnostics();
  assert.equal(enough.rounds[0]!.locationTree.kind, "split");
  if (enough.rounds[0]!.locationTree.kind === "split") {
    assert.equal(enough.rounds[0]!.locationTree.feature, 0);
    assert.equal(enough.rounds[0]!.locationTree.left.samples, 256);
    assert.equal(enough.rounds[0]!.locationTree.right.samples, 256);
  }
  for (const round of short.rounds) {
    assert.equal(round.locationTree.kind, "leaf"); assert.equal(round.logScaleTree.kind, "leaf");
  }
  const validate = (tree: typeof enough.rounds[number]["locationTree"], depth = 0) => {
    assert.ok(depth <= 2);
    if (tree.kind === "split") { assert.ok(tree.left.samples >= 256 && tree.right.samples >= 256); validate(tree.left, depth + 1); validate(tree.right, depth + 1); }
  };
  for (const round of enough.rounds) { validate(round.locationTree); validate(round.logScaleTree); }
});

function nonlinearRows(): StudentTrainingRow[] {
  return Array.from({ length: 6400 }, (_, i) => {
    const x = i % 5 - 2, high = Math.floor(i / 5) % 2, noiseIndex = Math.floor(i / 10) % 64;
    const noise = studentTQuantile5((noiseIndex + .5) / 64);
    return { features: [x, high], target: 30 * x * x - 60 + noise * (high ? 60 : 5), weight: 1 };
  });
}

test("boosting learns a nonlinear mean and conditional scale from a synthetic t5 response", () => {
  const rows = nonlinearRows(), model = fitStudentBoost(rows, 2), linear = fitLinearStudent(rows, 2);
  assert.ok(model.predict([2, 0]).location - model.predict([0, 0]).location > 60);
  assert.ok(model.predict([0, 1]).scale > model.predict([0, 0]).scale * 2);
  const loss = (fit: typeof model | typeof linear) => rows.reduce((sum, row) => {
    const p = fit.predict(row.features); return sum + studentTNll5(row.target, p.location, p.scale);
  }, 0) / rows.length;
  assert.ok(loss(model) < loss(linear) - .3);
});

test("every accepted common backtracking step preserves weighted NLL and prediction replay matches training", () => {
  const rows = nonlinearRows().map((row, i) => ({ ...row, weight: 2 ** (-i / 2160) }));
  const model = fitStudentBoost(rows, 2), d = model.diagnostics();
  assert.ok(d.acceptedRounds <= 48 && d.attemptedRounds <= 48);
  assert.equal(d.weightedNllHistory.length, d.acceptedRounds + 1);
  for (let i = 1; i < d.weightedNllHistory.length; i++) assert.ok(d.weightedNllHistory[i]! <= d.weightedNllHistory[i - 1]!);
  for (const round of d.rounds) assert.ok(STUDENT_BOOST_SPEC.backtrackingSteps.includes(round.step));
  let loss = 0, weights = 0;
  for (const row of rows) { const p = model.predict(row.features); loss += row.weight * studentTNll5(row.target, p.location, p.scale); weights += row.weight; }
  near(loss / weights, d.finalWeightedNll, 1e-12);
});

test("scale clamps are enforced without clamping finite location forecasts", () => {
  const rows = Array.from({ length: 512 }, (_, i) => ({ features: [0], target: i % 2 ? 1e6 : -1e6, weight: 1 }));
  const boosted = fitStudentBoost(rows, 1), baseline = fitLinearStudent(rows, 1);
  assert.equal(boosted.diagnostics().initialScale, 10_000);
  assert.equal(boosted.predict([0]).scale, 10_000); assert.equal(baseline.predict([0]).scale, 10_000);
  const shifted = rows.map(row => ({ ...row, target: row.target + 1e8 }));
  near(fitStudentBoost(shifted, 1).predict([0]).location, 1e8);
});

test("fits own their inputs, training histograms and diagnostics and never learn from prediction calls", () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ features: [i % 3 - 1], target: 5 + (i % 3 - 1) * 20, weight: 1 }));
  for (const fit of [fitStudentBoost, fitLinearStudent]) {
    const input = structuredClone(rows), model = fit(input, 1), before = model.diagnostics(), forecast = model.predict([1]);
    assert.deepEqual(fit(input, 1).diagnostics(), before);
    for (const row of input) { row.features[0] = 1e6; row.target = -1e6; row.weight = 100; }
    const external = model.diagnostics(); external.samples = 0;
    model.predict([1e6]); model.predict([-1e6]);
    assert.deepEqual(model.diagnostics(), before); assert.deepEqual(model.predict([1]), forecast);
  }
});

test("invalid rows, weights, feature dimensions and inference values fail explicitly", () => {
  const valid = { features: [1], target: 1, weight: 1 };
  for (const fit of [fitStudentBoost, fitLinearStudent]) {
    for (const invalid of [{ ...valid, weight: 0 }, { ...valid, weight: -1 }, { ...valid, weight: NaN },
      { ...valid, target: Infinity }, { ...valid, features: [NaN] }, { ...valid, features: [] },
      { ...valid, features: Array<number>(1) }]) assert.throws(() => fit([invalid], 1), /INVALID_TRAINING_ROW/);
    assert.throws(() => fit([], 1), /INVALID_TRAINING_INPUT/);
    assert.throws(() => fit([valid], 0), /INVALID_TRAINING_INPUT/);
    const model = fit([valid], 1);
    assert.throws(() => model.predict([NaN]), /INVALID_PREDICTION_FEATURES/);
    assert.throws(() => model.predict([]), /INVALID_PREDICTION_FEATURES/);
  }
});
