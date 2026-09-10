import assert from "node:assert/strict";
import test from "node:test";
import { WEEK_MS, type SpotWeek } from "../src/spot-trend/data.js";
import { spotTrendSignal, reconstructSpotTrend } from "../src/spot-trend/signal.js";
import { replaySpotTrend, bootstrapSpotWeeks } from "../src/spot-trend/replay.js";
import { SPOT_TREND_SPEC as S } from "../src/spot-trend/spec.js";

const start = Date.UTC(2020, 0, 2);
function weeks(closes: number[]): SpotWeek[] {
  return closes.map((close, i) => ({ openMs: start + i * WEEK_MS, endMs: start + (i + 1) * WEEK_MS,
    availableAtMs: start + (i + 1) * WEEK_MS + 60_000, open: i ? closes[i - 1]! : close,
    high: Math.max(i ? closes[i - 1]! : close, close) * 1.05,
    low: Math.min(i ? closes[i - 1]! : close, close) * .95, close, volume: 1_000, trades: 100 }));
}
const input = (bars: SpotWeek[], scenario: "base" | "stress" = "base", policy: "trend" | "buy-hold" | "cash" = "trend") =>
  ({ bars, startMs: bars[41]!.openMs, endMs: bars.at(-1)!.endMs, scenario, policy });

test("weekly signal requires 40 available consecutive closes and ignores unfinished prices", () => {
  const bars = weeks(Array.from({ length: 41 }, (_, i) => 100 + i));
  assert.equal(spotTrendSignal(bars, bars[39]!.endMs, "cash").reason, "WARMUP");
  assert.equal(spotTrendSignal(bars, bars[39]!.availableAtMs, "cash").state, "long");
  const changed = bars.map((b, i) => i === 40 ? { ...b, close: 1_000_000 } : b);
  assert.deepEqual(spotTrendSignal(changed, bars[39]!.availableAtMs, "cash"), spotTrendSignal(bars, bars[39]!.availableAtMs, "cash"));
  assert.throws(() => spotTrendSignal([...bars.slice(0, 20), ...bars.slice(21)], bars.at(-1)!.availableAtMs, "cash"));
});

test("hysteresis preserves state inside cost-scaled band and equality goes to cash", () => {
  const bars = weeks([...Array(39).fill(100), 101]);
  assert.equal(spotTrendSignal(bars, bars.at(-1)!.availableAtMs, "long").state, "long");
  assert.equal(spotTrendSignal(bars, bars.at(-1)!.availableAtMs, "cash").state, "cash");
  const equal = weeks(Array(40).fill(100));
  assert.equal(spotTrendSignal(equal, equal.at(-1)!.availableAtMs, "long").state, "cash");
  assert.equal(reconstructSpotTrend(bars, bars.at(-1)!.availableAtMs).state, "cash");
});

test("historical fills occur strictly after finalized signal; stress waits another native week", () => {
  const bars = weeks([...Array(40).fill(100), ...Array(7).fill(200)]);
  const base = replaySpotTrend(input(bars));
  const stress = replaySpotTrend(input(bars, "stress"));
  assert.equal(base.orders[0]!.timestampMs, bars[42]!.openMs);
  assert.equal(stress.orders[0]!.timestampMs, bars[43]!.openMs);
  assert.ok(base.orders[0]!.timestampMs > bars[40]!.availableAtMs);
  assert.equal(base.buys, 1); assert.equal(base.closedEpisodes, 1); assert.ok(base.terminalFlat);
  const buy = base.orders[0]!;
  assert.ok(buy.quantity * buy.price * (1 + buy.feeBps / 10_000) <= 100);
  assert.equal(base.finalQuantity, 0);
  assert.ok(Math.abs(base.netPnlUsd - base.realizedNetUsd) < 1e-8);
  assert.ok(Math.abs(base.weekly.reduce((n, w) => n + w.weeklyNetUsd, 0) - base.netPnlUsd) < 1e-8);
  assert.ok(base.netPnlUsd < 0, "flat holding prices must lose both-side costs");
});

test("cash is exactly flat and buy-hold starts independently of a bullish candidate", () => {
  const bars = weeks(Array(48).fill(100));
  const trend = replaySpotTrend(input(bars));
  const hold = replaySpotTrend(input(bars, "base", "buy-hold"));
  const cash = replaySpotTrend(input(bars, "base", "cash"));
  assert.equal(trend.buys, 0); assert.equal(hold.orders[0]!.timestampMs, bars[41]!.openMs);
  assert.equal(cash.netPnlUsd, 0); assert.equal(cash.feesUsd, 0); assert.equal(cash.orders.length, 0);
  assert.equal(cash.finalCashUsd, S.initialCashUsd);
  assert.ok(trend.fivePercentInitialBudgetHurdleUsd > 0);
});

test("missing weekly history rejects the replay and unavailable terminal volume leaves explicit inventory", () => {
  const bars = weeks([...Array(40).fill(100), ...Array(7).fill(200)]);
  assert.throws(() => replaySpotTrend(input([...bars.slice(0, 10), ...bars.slice(11)])), /INVALID_SPOT_REPLAY_BARS/);
  const last = bars.at(-1)!; last.volume = 0; last.trades = 0;
  const result = replaySpotTrend(input(bars));
  assert.equal(result.terminalFlat, false); assert.ok(result.finalQuantity > 0);
  assert.equal(result.closedEpisodes, 0);
});

test("later prices cannot change earlier signals, fills or marked cash", () => {
  const original = weeks([...Array(40).fill(100), ...Array.from({ length: 30 }, (_, i) => 200 + i)]);
  const changed = weeks([...Array(40).fill(100), ...Array.from({ length: 30 }, (_, i) => i < 20 ? 200 + i : 10)]);
  const before = replaySpotTrend(input(original)), after = replaySpotTrend(input(changed));
  assert.deepEqual(before.orders.filter(o => o.timestampMs < original[60]!.openMs), after.orders.filter(o => o.timestampMs < original[60]!.openMs));
  assert.deepEqual(before.weekly.filter(w => w.openMs < original[60]!.openMs), after.weekly.filter(w => w.openMs < original[60]!.openMs));
});

test("bootstrap keeps calendar cash weeks and is deterministic without inventing evidence", () => {
  const result = bootstrapSpotWeeks(Array(26).fill(-1), 13, 100, 123, .05);
  assert.equal(result.lowerMeanWeeklyNetUsd, -1); assert.equal(result.completeWeeks, 26);
  assert.deepEqual(result, bootstrapSpotWeeks(Array(26).fill(-1), 13, 100, 123, .05));
  assert.equal(bootstrapSpotWeeks([1], 13, 100, 123, .05).lowerMeanWeeklyNetUsd, null);
});
