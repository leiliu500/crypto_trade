import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { studyHash } from "../src/distribution/study.js";

const originalHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
  (_key, item: unknown) => typeof item === "bigint" ? String(item) : item)).digest("hex");

test("study hashing preserves JSON scalar, ordered object and training bank bytes", () => {
  const bank = [{ symbol: "BTC/USD", actionId: "long-5m", signalAtMs: 1_788_700_000_000,
    completedAtMs: 1_788_700_301_000, features: [0, -0, .25, -1, 1],
    outcomes: [{ scenario: "base-250ms", status: "FILLED", netBps: -13.5, grossBps: -.5,
      filledFraction: 1, entryAtMs: 1_788_700_000_250, exitAtMs: 1_788_700_301_000, reason: "DEADLINE" }] }];
  for (const value of [null, true, false, 0, -0, .001, 1e30, "é\n\u2028", [], {},
    { z: 1, a: 2, "12": "twelve", "2": "two", missing: undefined },
    [NaN, Infinity, -Infinity, undefined], bank]) assert.equal(studyHash(value), originalHash(value));
});

test("study hashing preserves BigInt live book sequences and nested private values", () => {
  const values = [1n, -1n, { kind: "BOOK", delta: { symbol: "BTC/USD", sequence: 999_999_999_999_999_999n,
    reset: true, receiveTsMs: 1_788_700_000_000, exchangeTsMs: 1_788_699_999_999,
    bids: [{ px: 90_000, qty: .002 }], asks: [{ px: 90_001, qty: .003 }] } },
  { kind: "PRIVATE", event: { ids: [0n, { next: 1n }], optional: undefined } }];
  for (const value of values) assert.equal(studyHash(value), originalHash(value));
});

test("mixed JSON and BigInt source events retain every link in the original event hash chain", () => {
  let expected = "", actual = "";
  for (let sequence = 0; sequence < 100; sequence++) {
    const event = { kind: "BOOK", delta: { symbol: sequence % 2 ? "ETH/USD" : "BTC/USD",
      sequence: sequence % 3 ? String(sequence) : BigInt(sequence), receiveTsMs: 1_788_700_000_000 + sequence,
      bids: [{ px: 1_000 + sequence, qty: .05 }], asks: [{ px: 1_001 + sequence, qty: .06 }] } };
    expected = originalHash([expected, event]); actual = studyHash([actual, event]);
    assert.equal(actual, expected);
  }
});

test("caller serialization errors propagate unchanged without retrying arbitrary TypeErrors", () => {
  for (const failure of [new TypeError("caller serialization failed"), new Error("caller failed"), "caller failure"]) {
    let calls = 0;
    const value = { toJSON() { calls++; throw failure; } };
    assert.throws(() => studyHash(value), error => error === failure);
    assert.equal(calls, 1);
  }
});

test("circular structures and nonserializable roots preserve rejection", () => {
  const circular: { self?: unknown } = {}; circular.self = circular;
  const withBigInt: { sequence: bigint; self?: unknown } = { sequence: 1n }; withBigInt.self = withBigInt;
  for (const value of [circular, withBigInt]) {
    assert.throws(() => studyHash(value), { name: "TypeError", message: /circular structure/i });
    assert.throws(() => originalHash(value), { name: "TypeError", message: /circular structure/i });
  }
  for (const value of [undefined, Symbol("unsupported"), () => {}]) {
    assert.throws(() => studyHash(value), TypeError);
    assert.throws(() => originalHash(value), TypeError);
  }
});
