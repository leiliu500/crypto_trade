import assert from "node:assert/strict";
import test from "node:test";
import { NetResidualCalibration, chooseNetAction } from "../src/research/hourly-net-calibration.js";

test("calibration mean, probabilities and tails describe the same shifted empirical distribution", () => {
  const c = new NetResidualCalibration([-3, -1, 0, 2, 4]);
  const p = c.predict({ location: 10, scale: 2 });
  assert.equal(p.meanNetBps, 10.8);
  assert.equal(p.probabilityNetPositive, 1);
  assert.equal(p.lower10NetBps, 4);
  assert.equal(p.upper90NetBps, 18);
  assert.equal(p.lowerTailMean10NetBps, 4);
  assert.notEqual(p.meanNetBps, 10);
});
test("zero payoffs and repeated values never count as profitable outcomes", () => {
  const c = new NetResidualCalibration([-1, 0, 0, 1]);
  assert.equal(c.predict({ location: 0, scale: 3 }).probabilityNetPositive, .25);
  assert.equal(c.predict({ location: -3, scale: 3 }).probabilityNetPositive, 0);
});
test("CRPS agrees with direct pairwise definition under shifts, scales, ties and extreme outcomes", () => {
  const z = [-7, -2, 0, 0, 3, 4, 9], c = new NetResidualCalibration(z);
  for (const location of [-10, 0, 100]) for (const scale of [.1, 1, 12]) for (const actual of [-1000, 0, 7, 2000]) {
    const ys = z.map(v => location + scale * v), n = ys.length;
    const expected = ys.reduce((s, y) => s + Math.abs(y - actual), 0) / n
      - ys.reduce((s, a) => s + ys.reduce((v, b) => v + Math.abs(a - b), 0), 0) / (2 * n * n);
    assert.ok(Math.abs(c.crps({ location, scale }, actual) - expected) < 1e-9);
  }
});
test("lower-tail expectation uses fractional boundary mass instead of a rounded sample count", () => {
  const c = new NetResidualCalibration([-10, ...Array<number>(14).fill(5)]);
  assert.equal(c.predict({ location: 0, scale: 1 }).lowerTailMean10NetBps, -5);
});
test("calibration snapshots are immutable and reject malformed distributions", () => {
  const values = [-1, 2], c = new NetResidualCalibration(values);
  values[0] = 1000;
  assert.equal(c.residualMean, .5);
  const d = c.diagnostics(); d.residuals[0] = -999;
  assert.equal(c.diagnostics().residuals[0], -1);
  for (const values of [[], [NaN], [Infinity]]) assert.throws(() => new NetResidualCalibration(values));
  for (const scale of [0, -1, NaN, Infinity]) assert.throws(() => c.predict({ location: 0, scale }));
});
test("entry decisions require both cost distributions and abstain on incoherent directions", () => {
  const c = new NetResidualCalibration([-10, 10, 10]);
  const pass = c.predict({ location: 20, scale: 1 }), fail = c.predict({ location: -20, scale: 1 });
  const good = { base: pass, stress: pass }, bad = { base: fail, stress: fail };
  assert.equal(chooseNetAction(good, bad).side, 1);
  assert.equal(chooseNetAction(bad, good).side, -1);
  assert.equal(chooseNetAction(good, good).reason, "INCOHERENT_BOTH_DIRECTIONS_QUALIFY");
  assert.equal(chooseNetAction({ base: pass, stress: fail }, bad).side, null);
  assert.equal(chooseNetAction({ base: { ...pass, meanNetBps: Infinity }, stress: pass }, bad).side, null);
  assert.equal(chooseNetAction({ base: { ...pass, probabilityNetPositive: .5 }, stress: pass }, bad).side, null);
});
