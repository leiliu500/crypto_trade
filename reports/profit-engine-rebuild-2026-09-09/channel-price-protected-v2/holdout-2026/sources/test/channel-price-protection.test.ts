import assert from "node:assert/strict";
import test from "node:test";
import type { FundingRow, HourlyBar } from "../src/research/hourly-data.js";
import { evaluatePriceProtectedChannelEntry, replayPriceProtectedChannel, type ChannelSignal } from "../src/channel/replay.js";
import { CHANNEL_SPEC as S, CHANNEL_PRICE_PROTECTED_SPEC as P } from "../src/channel/spec.js";
const T = Date.UTC(2024, 0, 1), H = S.hourMs, D = S.dayMs;
const signal = (side: 1 | -1): ChannelSignal => ({ symbol: "BTC/USD", endMs: T, close: 100, atr: 10,
  entrySide: side, longExit: false, shortExit: false });
function history() {
  const bars: HourlyBar[] = [], funding: FundingRow[] = [];
  for (const symbol of S.symbols) for (let t = T - 60 * D; t < T + 6 * D; t += H) {
    const p = t < T - D ? 100 : 110;
    bars.push({ symbol, openMs: t, open: p, high: p + 1, low: p - 1, close: p, volume: 1000 });
    if (t >= T) funding.push({ symbol, timestampMs: t + H, rate: .00001, absoluteRate: .01 });
  }
  return { bars, funding, startMs: T, endMs: T + 6 * D, scenario: "base" as const };
}
test("price protection fixes the original signal stop and sizes risk from actual fill", () => {
  const long = evaluatePriceProtectedChannelEntry(signal(1), 105), short = evaluatePriceProtectedChannelEntry(signal(-1), 95);
  assert.equal(long.eligible, true); assert.equal(short.eligible, true);
  if (!long.eligible || !short.eligible) throw new Error("missing eligible entry");
  assert.equal(long.protection.fixedStopPx, 80); assert.equal(long.protection.actualEntryStopDistance, 25);
  assert.equal(short.protection.fixedStopPx, 120); assert.equal(short.protection.actualEntryStopDistance, 25);
  assert.equal(long.protection.entryDisplacementAtr, .5);
  const favorable = evaluatePriceProtectedChannelEntry(signal(1), 95);
  assert.equal(favorable.eligible && favorable.protection.fixedStopPx, 80);
  assert.equal(favorable.eligible && favorable.protection.actualEntryStopDistance, 15);
});
test("symmetric displacement limits and invalid fixed stops reject without inventing a new stop", () => {
  for (const side of [1, -1] as const) for (const px of [94.999, 105.001])
    assert.deepEqual(evaluatePriceProtectedChannelEntry(signal(side), px), { eligible: false, reason: "ENTRY_PRICE_DISPLACEMENT" });
  assert.deepEqual(evaluatePriceProtectedChannelEntry({ ...signal(1), atr: .01 }, 100), { eligible: false, reason: "ENTRY_INVALID_FIXED_SIGNAL_STOP" });
  assert.deepEqual(evaluatePriceProtectedChannelEntry({ ...signal(1), atr: 100 }, 100), { eligible: false, reason: "ENTRY_INVALID_FIXED_SIGNAL_STOP" });
});
test("a displaced executable quote skips the daily signal and cannot retry after price returns", () => {
  const input = history();
  const changed = input.bars.find(b => b.symbol === "BTC/USD" && b.openMs === T + H)!;
  Object.assign(changed, { open: 114, high: 115, low: 113, close: 114 });
  const run = replayPriceProtectedChannel(input);
  assert.equal(run.version, P.version);
  assert.equal(run.orders.some(o => o.symbol === "BTC/USD" && !o.reduceOnly && o.atMs < T + D), false);
  assert.equal(run.haltReasons.ENTRY_PRICE_DISPLACEMENT, 1);
  assert.equal(run.orders.some(o => o.symbol === "ETH/USD" && !o.reduceOnly), true);
});
test("entry ledger retains causal stop evidence and actual protected risk stays within allocation", () => {
  const input = history(), run = replayPriceProtectedChannel(input);
  const entries = run.orders.filter(o => !o.reduceOnly);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const p = entry.entryProtection!;
    assert.ok(p.signalEndMs + S.finalizationLagMs <= entry.atMs);
    assert.ok(p.entryDisplacementAtr <= .5 + 1e-12);
    assert.equal(p.fixedStopPx, p.signalClose - entry.side * 2 * p.signalAtr);
    const risk = entry.qty * (p.actualEntryStopDistance + entry.price * 2 * (S.feesBps.base + S.adverseSlippageBps.base) / 10000);
    assert.ok(risk <= 50 + 1e-8);
  }
  const modified = history();
  for (const bar of modified.bars) if (bar.openMs >= T + 3 * D) {
    bar.high += 100;
  }
  assert.deepEqual(replayPriceProtectedChannel(modified).orders.filter(o => !o.reduceOnly && o.atMs < T + D), entries);
  assert.ok(Math.abs(run.netPnlUsd! - (run.grossPnlUsd - run.feeUsd + run.fundingCashUsd!)) < 1e-7);
});
