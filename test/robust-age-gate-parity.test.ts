import assert from "node:assert/strict";
import test from "node:test";
import { RobustAgeGate } from "../src/core/statistics.js";
import { ReferenceRobustAgeGate } from "./fixtures/robust-age-gate-reference.js";

type Configuration = ConstructorParameters<typeof RobustAgeGate>;
function compare(config: Configuration, observations: Iterable<readonly [number, number]>) {
  const reference = new ReferenceRobustAgeGate(...config), actual = new RobustAgeGate(...config);
  let i = 0;
  for (const [age, clock] of observations) {
    assert.deepEqual(actual.observe(age, clock), reference.observe(age, clock), `Exact observation ${i++}: age=${age}, clock=${clock}`);
  }
}
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

test("ordered age medians preserve exact arithmetic for even/odd lengths, duplicates, extremes and invalid ages", () => {
  const ages = [0, -0, Number.MIN_VALUE, 1e-280, 1e-12, .1, .2, .3, 1, 1, 1, 10, 100,
    Number.MAX_VALUE / 4, Number.MAX_VALUE / 2, Number.MAX_VALUE, -Number.MAX_VALUE, -250, -250.0001, -1, NaN, Infinity, -Infinity];
  for (const config of [[100, 1000, 6, 1, 250], [Number.MAX_VALUE, Infinity, 6, 0, 250],
    [100, 1000, 0, 2, 0], [100, 0, 6, 1, 250], [100, -1, 6, 0, 250]] satisfies Configuration[]) {
    const rows = Array.from({ length: 500 }, (_, i) => [ages[(i * 17) % ages.length]!, i % 11 ? i : i - 100] as const);
    compare(config, rows);
  }
});

test("ordered age window preserves FIFO expiry when older timestamps follow an unexpired head", () => {
  compare([100, 1000, 6, 1], [[1, 1000], [20, 2000], [80, 500], [-1, 1600], [1, 2000], [-1, 2001],
    [40, 4000], [0, 0], [100, 2000], [1, 3999], [3, 4000], [-1, 5000], [-1, 5001]]);
});

test("ordered age window keeps the exact 4096-sample cap through repeated FIFO compactions", () => {
  const next = random(0x45acdf);
  function* rows(): Generator<readonly [number, number]> {
    for (let i = 0; i < 9300; i++) yield [i % 7 ? Math.floor(next() * 1000) : next() * 1000, i];
  }
  compare([2000, Infinity, 6, 20, 250], rows());
});

test("large expiry batches and subsequent inserts match the original rolling window", () => {
  const next = random(0x9ae348);
  function* rows(): Generator<readonly [number, number]> {
    for (let cycle = 0; cycle < 3; cycle++) {
      const base = cycle * 20_000;
      for (let i = 0; i < 2200; i++) yield [next() * 250, base + i];
      // Expire a strict FIFO prefix, then the entire remaining window. Rejected
      // observations prune the queue too, despite not being added themselves.
      yield [Infinity, base + 5100]; yield [NaN, base + 5200];
      yield [-300, base + 10_000]; yield [10, base + 10_001];
    }
  }
  compare([2000, 3000, 6, 20, 250], rows());
});

test("seeded irregular receipt clocks and threshold-adjacent observations produce identical decisions", () => {
  const next = random(0x920961), config: Configuration = [20, 500, 6, 3, 25];
  const reference = new ReferenceRobustAgeGate(...config), actual = new RobustAgeGate(...config);
  let clock = 10_000, previousThreshold = 20;
  for (let i = 0; i < 15_000; i++) {
    clock += i % 101 === 0 ? 3000 : Math.floor(next() * 21) - 5;
    const age = i % 17 === 0 ? previousThreshold : i % 19 === 0 ? previousThreshold * (1 + Number.EPSILON)
      : i % 23 === 0 ? -25 : i % 29 === 0 ? -25.0001 : next() * 40;
    const expected = reference.observe(age, clock);
    assert.deepEqual(actual.observe(age, clock), expected, `Threshold-boundary observation ${i}`);
    previousThreshold = expected.thresholdMs;
  }
});

test("previously accepted nonfinite clock and unusual configuration semantics remain unchanged", () => {
  const clocks = [0, 100, NaN, -Infinity, Infinity, 500, -100, 1000];
  const ages = [0, -0, 20, -1, 100, NaN, Infinity];
  for (const config of [[100, NaN, 6, 20, 0], [NaN, 1000, 6, 0, NaN],
    [Infinity, Infinity, Infinity, 1, 250], [100, 1000, NaN, NaN, 0]] satisfies Configuration[]) {
    compare(config, Array.from({ length: 300 }, (_, i) => [ages[i % ages.length]!, clocks[i % clocks.length]!] as const));
  }
});
