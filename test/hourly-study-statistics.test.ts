import test from "node:test";
import assert from "node:assert/strict";
import { pairedWeeklyPnlInterval, predictionErrorSummary } from "../src/research/hourly-study-statistics.js";

const calendar = (n: number, value: (i: number) => number) => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), netPnlUsd: value(i),
}));

test("hourly paired weekly inference preserves idle days and identical-policy pairing", () => {
  const rows = calendar(100, i => i % 10 === 0 ? .1 : 0);
  const result = pairedWeeklyPnlInterval(rows, rows);
  assert.equal(result.days, 100);
  assert.equal(result.meanDailyImprovementUsd, 0);
  assert.equal(result.lower95TotalUsd, 0);
});
test("hourly weekly interval reproduces constant losses and deterministic mixed paths", () => {
  const flat = calendar(100, () => 0);
  assert.ok(Math.abs(pairedWeeklyPnlInterval(calendar(100, () => -.01), flat).lower95TotalUsd! + 1) < 1e-10);
  const mixed = calendar(100, i => i % 7 === 0 ? -.2 : .04);
  assert.deepEqual(pairedWeeklyPnlInterval(mixed, flat), pairedWeeklyPnlInterval(mixed, flat));
});
test("hourly interval rejects missing calendar pairing and does not invent short-sample confidence", () => {
  assert.throws(() => pairedWeeklyPnlInterval(calendar(30, () => 0), calendar(29, () => 0)), /CALENDAR_MISMATCH/);
  const dates = calendar(31, () => 0).filter((_, i) => i !== 7);
  assert.throws(() => pairedWeeklyPnlInterval(dates, dates), /NONCONTIGUOUS/);
  assert.equal(pairedWeeklyPnlInterval(calendar(10, () => 0), calendar(10, () => 0)).lower95TotalUsd, null);
});
test("hourly prediction comparison uses all supplied outcomes and keeps empty metrics unknown", () => {
  assert.equal(predictionErrorSummary([]).modelMseBps2, null);
  const result = predictionErrorSummary([{ actual: 10, predicted: 0, unconditional: 2 }, { actual: -10, predicted: 0, unconditional: 2 }]);
  assert.equal(result.modelMseBps2, 100);
  assert.equal(result.modelBeatsZero, false);
  assert.equal(result.unconditionalMseBps2, 104);
});
