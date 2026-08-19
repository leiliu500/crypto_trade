import assert from "node:assert/strict";
import test from "node:test";
import { ceilToGrid, createGrid, decimalToUnits, floorToGrid, unitsToDecimal } from "../src/core/decimal.js";
import { LocalOrderBook } from "../src/core/order-book.js";
import { FeatureEngine } from "../src/core/features.js";
import { estimateSweep } from "../src/execution/book-walk.js";
import { mad, median, quantile, RobustAgeGate } from "../src/core/statistics.js";

test("exact decimal grids never emit off-increment quantities", () => {
  const grid = createGrid("0.0001");
  assert.equal(decimalToUnits("1.2345", 4), 12_345n);
  assert.equal(unitsToDecimal(12_300n, 4), "1.23");
  assert.equal(floorToGrid("1.23459", { ...grid, scale: 5, incrementUnits: 10n }), "1.2345");
  assert.equal(ceilToGrid("1.23451", { ...grid, scale: 5, incrementUnits: 10n }), "1.2346");
  assert.throws(() => decimalToUnits("1.23451", 4));
});

test("Alpaca reset/delta book is idempotent and fails closed", () => {
  const book = new LocalOrderBook("BTC/USD");
  const reset = { symbol: "BTC/USD", bids: [{ px: 100, qty: 2 }], asks: [{ px: 101, qty: 3 }], reset: true, exchangeTsMs: 1_000, receiveTsMs: 1_010, sourceId: "a" };
  const first = book.apply(reset);
  assert.equal(first.accepted, true);
  assert.equal(first.state?.bids[0]?.qty, 2);
  const duplicate = book.apply(reset);
  assert.equal(duplicate.duplicate, true);
  assert.equal(book.snapshot().sequence, 1n);
  const update = book.apply({ ...reset, reset: false, sourceId: "b", exchangeTsMs: 1_001, receiveTsMs: 1_011, bids: [{ px: 100, qty: 0 }, { px: 99, qty: 4 }], asks: [] });
  assert.equal(update.accepted, true);
  assert.equal(update.state?.bids[0]?.px, 99);
  const reversal = book.apply({ ...reset, reset: false, sourceId: "c", exchangeTsMs: 999, receiveTsMs: 1_012 });
  assert.equal(reversal.accepted, false);
  assert.equal(book.isValid(), false);
});

test("crossed books and missing reset cannot become tradeable", () => {
  const book = new LocalOrderBook("BTC/USD");
  const missing = book.apply({ symbol: "BTC/USD", bids: [{ px: 100, qty: 1 }], asks: [{ px: 101, qty: 1 }], reset: false, exchangeTsMs: 1, receiveTsMs: 2, sourceId: "x" });
  assert.equal(missing.reason, "MISSING_RESET");
  const crossed = book.apply({ symbol: "BTC/USD", bids: [{ px: 101, qty: 1 }], asks: [{ px: 101, qty: 1 }], reset: true, exchangeTsMs: 2, receiveTsMs: 3, sourceId: "y" });
  assert.equal(crossed.accepted, false);
  assert.equal(crossed.reason, "CROSSED_OR_EMPTY_BOOK");
  const requiresNewReset = book.apply({ symbol: "BTC/USD", bids: [{ px: 100, qty: 1 }], asks: [{ px: 102, qty: 1 }], reset: false, exchangeTsMs: 3, receiveTsMs: 4, sourceId: "z" });
  assert.equal(requiresNewReset.reason, "MISSING_RESET");
});

test("book walking returns exact VWAP and respects a price cap", () => {
  const result = estimateSweep([{ px: 100, qty: 1 }, { px: 101, qty: 2 }], 2);
  assert.deepEqual(result, { filledQty: 2, vwap: 100.5, worstPx: 101, notional: 201 });
  assert.equal(estimateSweep([{ px: 100, qty: 1 }, { px: 101, qty: 2 }], 2, 100), null);
});

test("robust statistics implement quantile, median, MAD and dynamic stale threshold", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(mad([1, 2, 3]), 1);
  assert.equal(quantile([0, 10], .95), 9.5);
  const gate = new RobustAgeGate(100, 10_000, 6, 3);
  gate.observe(10, 1); gate.observe(11, 2); gate.observe(9, 3);
  const normal = gate.observe(12, 4);
  assert.equal(normal.stale, false);
  const stale = gate.observe(1_000, 5);
  assert.equal(stale.stale, true);
  assert.ok(stale.thresholdMs >= 100);
});

test("provider timestamps slightly ahead of the local clock are clamped within an explicit tolerance", () => {
  const gate = new RobustAgeGate(100, 10_000, 6, 3, 50);
  assert.deepEqual(gate.observe(-16, 1), { stale: false, thresholdMs: 100, adjustedAgeMs: 0 });
  const excessiveLead = gate.observe(-51, 2);
  assert.equal(excessiveLead.stale, true);
  assert.equal(excessiveLead.adjustedAgeMs, -51);
});

test("kinematic features remain finite under bursty and irregular event timestamps", () => {
  const engine = new FeatureEngine();
  let timestampMs = 0;
  let freshSamples = 0;
  for (let i = 0; i < 2_000; i += 1) {
    if (i % 2 === 0) timestampMs += 1_000;
    const noise = ((((i + 1) * 48_271) % 2_147_483_647) / 2_147_483_647 - .5) * .01;
    const mid = 100 + noise;
    const features = engine.onBook({
      symbol: "TEST/USD", bids: [{ px: mid - .005, qty: 10 }], asks: [{ px: mid + .005, qty: 10 }],
      sequence: BigInt(i + 1), exchangeTsMs: timestampMs, receiveTsMs: timestampMs, valid: true, sourceReset: true,
    });
    assert.ok(features);
    for (const value of Object.values(features)) if (typeof value === "number") assert.equal(Number.isFinite(value), true);
    if (features.warmedUp && !features.stale) freshSamples += 1;
  }
  assert.ok(freshSamples > 0);
});

test("a long observation gap resets kinematics and fails closed for that event", () => {
  const engine = new FeatureEngine();
  let features;
  for (let i = 0; i < 40; i += 1) {
    const timestampMs = i * 500;
    features = engine.onBook({ symbol: "TEST/USD", bids: [{ px: 99.995, qty: 10 }], asks: [{ px: 100.005, qty: 10 }],
      sequence: BigInt(i + 1), exchangeTsMs: timestampMs, receiveTsMs: timestampMs, valid: true, sourceReset: true });
  }
  assert.equal(features?.warmedUp, true);
  const gapMs = 30_000;
  const afterGap = engine.onBook({ symbol: "TEST/USD", bids: [{ px: 100.005, qty: 10 }], asks: [{ px: 100.015, qty: 10 }],
    sequence: 41n, exchangeTsMs: gapMs, receiveTsMs: gapMs, valid: true, sourceReset: true });
  assert.equal(afterGap?.stale, true);
  assert.equal(afterGap?.warmedUp, false);
  assert.equal(Number.isFinite(afterGap?.velocityZ ?? Number.NaN), true);
  const recovered = engine.onBook({ symbol: "TEST/USD", bids: [{ px: 100.006, qty: 10 }], asks: [{ px: 100.016, qty: 10 }],
    sequence: 42n, exchangeTsMs: gapMs + 100, receiveTsMs: gapMs + 100, valid: true, sourceReset: true });
  assert.equal(recovered?.stale, false);
});
