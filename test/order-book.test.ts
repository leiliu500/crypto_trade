import assert from "node:assert/strict";
import test from "node:test";
import { LocalOrderBook, type BookDelta } from "../src/core/order-book.js";

const reset = (overrides: Partial<BookDelta> = {}): BookDelta => ({
  symbol: "BTC/USD", bids: [{ px: 100, qty: 2 }, { px: 99, qty: 3 }, { px: 98, qty: 4 }],
  asks: [{ px: 101, qty: 5 }, { px: 102, qty: 6 }, { px: 103, qty: 7 }],
  reset: true, exchangeTsMs: 1_000, receiveTsMs: 1_010, sourceId: "reset", ...overrides,
});

test("ordered snapshots retain hidden depth and preserve ages when deltas resume", () => {
  const book = new LocalOrderBook("BTC/USD", 2);
  const first = book.apply(reset());
  assert.equal(first.accepted, true);
  assert.equal(first.flow.bidAdded, 9);
  assert.equal(first.flow.askAdded, 18);
  assert.equal(first.state?.bids.length, 2);
  const next = book.apply(reset({ reset: false, sourceId: "delta", exchangeTsMs: 1_500, receiveTsMs: 1_510,
    bids: [{ px: 100, qty: 0 }, { px: 99, qty: 2 }], asks: [] }));
  assert.deepEqual(next.state?.bids, [{ px: 99, qty: 2, ageMs: 0 }, { px: 98, qty: 4, ageMs: 500 }]);
  assert.deepEqual(next.state?.asks, [{ px: 101, qty: 5, ageMs: 500 }, { px: 102, qty: 6, ageMs: 500 }]);
  assert.equal(next.flow.bidCanceled, 3);
  assert.equal(next.flow.bidAdded, 0);
  assert.equal(next.state?.sourceReset, false);
});

test("reset input, apply result, and later snapshots never share mutable levels", () => {
  const book = new LocalOrderBook("BTC/USD");
  const input = reset();
  const first = book.apply(input);
  input.bids[0]!.qty = 500;
  first.state!.bids[0]!.qty = 600;
  const snapshot = book.snapshot();
  assert.equal(snapshot.bids[0]!.qty, 2);
  snapshot.bids[0]!.qty = 700;
  assert.equal(book.snapshot().bids[0]!.qty, 2);
  const next = book.apply(reset({ reset: false, sourceId: "delta", exchangeTsMs: 1_001, receiveTsMs: 1_011,
    bids: [{ px: 100, qty: 1 }], asks: [] }));
  assert.equal(next.flow.bidCanceled, 1);
  assert.equal(next.state?.bids[0]!.qty, 1);
});

test("unordered or repeated reset prices preserve sequential flow and final depth", () => {
  const book = new LocalOrderBook("BTC/USD");
  book.apply(reset());
  const result = book.apply(reset({ sourceId: "unordered", exchangeTsMs: 1_001, receiveTsMs: 1_020,
    bids: [{ px: 99, qty: 1 }, { px: 100, qty: 2 }, { px: 99, qty: 3 }, { px: 99, qty: 0 }, { px: 98, qty: 4 }] }));
  assert.deepEqual(result.state?.bids, [{ px: 100, qty: 2, ageMs: 0 }, { px: 98, qty: 4, ageMs: 0 }]);
  assert.equal(result.flow.bidAdded, 9);
  assert.equal(result.flow.bidCanceled, 3);
  const ordered = book.apply(reset({ sourceId: "ordered-again", exchangeTsMs: 1_002, receiveTsMs: 1_030,
    bids: [{ px: 100, qty: 0 }, { px: 99, qty: 8 }] }));
  assert.deepEqual(ordered.state?.bids, [{ px: 99, qty: 8, ageMs: 0 }]);
  assert.equal(ordered.flow.bidAdded, 8);
  assert.equal(ordered.flow.bidCanceled, 0);
});

test("ordered reset optimization preserves duplicates, invalidation, and recovery", () => {
  const book = new LocalOrderBook("BTC/USD");
  book.apply(reset());
  assert.equal(book.apply(reset()).duplicate, true);
  assert.equal(book.snapshot().sequence, 1n);
  const bad = book.apply(reset({ sourceId: "invalid", bids: [{ px: 100, qty: NaN }] }));
  assert.equal(bad.reason, "INVALID_LEVEL");
  assert.equal(book.isValid(), false);
  assert.equal(book.snapshot().bids[0]!.qty, 2);
  assert.equal(book.apply(reset({ reset: false, sourceId: "missing" })).reason, "MISSING_RESET");
  assert.equal(book.apply(reset({ sourceId: "recover" })).accepted, true);
  assert.equal(book.apply(reset({ sourceId: "reverse", exchangeTsMs: 999 })).reason, "TIMESTAMP_REVERSAL");
  assert.equal(book.apply(reset({ sourceId: "crossed", bids: [{ px: 102, qty: 1 }] })).reason, "CROSSED_OR_EMPTY_BOOK");
  assert.equal(book.snapshot().bids[0]!.px, 102);
  assert.equal(book.snapshot().valid, false);
  assert.equal(book.apply(reset({ sourceId: "final" })).accepted, true);
  assert.equal(book.snapshot().sequence, 4n);
});
