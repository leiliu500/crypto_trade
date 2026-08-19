import assert from "node:assert/strict";
import test from "node:test";
import { ceilToGrid, createGrid, decimalToUnits, floorToGrid, unitsToDecimal } from "../src/core/decimal.js";
import { LocalOrderBook } from "../src/core/order-book.js";
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
