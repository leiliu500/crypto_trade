import test from "node:test";
import assert from "node:assert/strict";
import { replayHorizonCarry, type HorizonCarryReplayInput } from "../src/carry/horizon-replay.js";
import { HORIZON_CARRY_SPEC as S } from "../src/carry/horizon-spec.js";

function fixture(rate: number): HorizonCarryReplayInput {
  const window = S.windows[1], H = S.hourMs, W = S.weekMs;
  const first = window.startMs - 100 * S.dayMs;
  const prices = { open: 100_000, high: 100_001, low: 99_999, close: 100_000, volume: 10 };
  const futureBars = Array.from({ length: (window.endMs - first) / H }, (_, i) => ({ symbol: "BTC/USD" as const, openMs: first + i * H, ...prices }));
  const funding = futureBars.map(b => ({ symbol: b.symbol, timestampMs: b.openMs + H, rate: rate / 100_000, absoluteRate: rate }));
  const weekStart = Math.floor(first / W) * W;
  const spotBars = Array.from({ length: Math.ceil((window.endMs - weekStart) / W) }, (_, i) => ({ symbol: "BTC/USD" as const,
    intervalMinutes: 10080 as const, openMs: weekStart + i * W, endMsExclusive: weekStart + (i + 1) * W,
    assumedAvailableAtMs: weekStart + (i + 1) * W + 60_000, ...prices, vwap: 100_000, trades: 10 }));
  return { ...window, scenario: "base", fundingEndShiftHours: 0, futureBars, funding, spotBars };
}
test("carry rejects cash-negative economics without manufactured entries", () => {
  const run = replayHorizonCarry(fixture(.1));
  assert.equal(run.completedCycles, 0); assert.equal(run.netCashPnlUsd, 0);
  assert.ok(run.decisions.length > 20); assert.ok(run.decisions.every(d => !d.signal.entryAllowed));
  assert.equal(run.runtimeActivationAllowed, false);
});
test("carry waits a full source week, integrates fixed-quantity funding, and flattens before terminal", () => {
  const run = replayHorizonCarry(fixture(6));
  assert.equal(run.completedCycles, 1); const cycle = run.cycles[0]!;
  const first = run.decisions.find(d => d.disposition === "ENTRY_QUEUED_NEXT_SOURCE_WEEK")!;
  assert.equal(cycle.entryMs, first.scheduledEntryMs);
  assert.ok(cycle.entryMs > first.atMs + 6 * S.dayMs);
  assert.equal(cycle.exitMs, run.effectiveTerminalAtMs); assert.equal(cycle.horizonTruncated, true);
  assert.ok(Math.abs(cycle.mark.knownFundingCashUsd - cycle.qty * 6 * (cycle.exitMs - cycle.entryMs) / S.hourMs) < 1e-8);
  assert.ok(Math.abs(cycle.netCashPnlUsd! - (cycle.mark.grossPricePnlUsd - cycle.mark.feesUsd + cycle.mark.knownFundingCashUsd)) < 1e-8);
  assert.ok(cycle.capitalBenchmarkUsd > 0); assert.ok(run.capitalBenchmarkExcessUsd! < run.netCashPnlUsd!);
  assert.equal(run.collateralGuardBreaches, 0); assert.equal(run.unresolvedMatchedQty, 0);
});
test("missing held funding remains unknown even after terminal flatten", () => {
  const input = fixture(6), missing = Date.UTC(2025, 0, 10, 1);
  input.funding = input.funding.filter(r => r.timestampMs !== missing);
  const run = replayHorizonCarry(input);
  assert.equal(run.missingHeldFundingHours, 1); assert.equal(run.accountingKnown, false);
  assert.equal(run.netCashPnlUsd, null); assert.equal(run.capitalBenchmarkExcessUsd, null);
  assert.equal(run.unresolvedMatchedQty, 0);
});
