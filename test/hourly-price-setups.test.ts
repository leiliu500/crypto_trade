import assert from "node:assert/strict";
import test from "node:test";
import { HOUR_MS as H, type HourlyBar, type HourlySymbol } from "../src/research/hourly-data.js";
import { buildHourlyPriceSetups, HOURLY_PRICE_SETUP_IDS, HOURLY_PRICE_SETUP_SPEC,
  type HourlyPriceSetupId } from "../src/research/hourly-price-setups.js";

const START = Date.UTC(2023, 0, 1);
function candles(closes: readonly number[], symbol: HourlySymbol = "BTC/USD", start = START): HourlyBar[] {
  return closes.map((close, i) => {
    const open = closes[i - 1] ?? close;
    return { symbol, openMs: start + i * H, open, close, high: Math.max(open, close) + .1,
      low: Math.min(open, close) - .1, volume: 10 };
  });
}
const build = (bars: readonly HourlyBar[], setupId: HourlyPriceSetupId = "channel-breakout-24h",
  fromMs = START, toMs = START + 500 * H) => buildHourlyPriceSetups(bars, setupId, fromMs, toMs);
function breakoutCloses() { return [...Array<number>(168).fill(100), 101, 102, 100, 103, 104]; }
function recoveryCloses() {
  return [...Array.from({ length: 168 }, (_, i) => 100 + i * .1), 114, 115.55, 116.2, 116.9, 117.6];
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `Expected ${actual} near ${expected}`);

test("fixed setup rules need only own completed prices and emit both directions without a sample bank", () => {
  assert.deepEqual(HOURLY_PRICE_SETUP_IDS, ["channel-breakout-24h", "trend-recovery-24h"]);
  assert.equal(HOURLY_PRICE_SETUP_SPEC.trainingSamplesRequired, false);
  assert.equal(HOURLY_PRICE_SETUP_SPEC.peerRequired, false);
  assert.equal(Object.isFrozen(HOURLY_PRICE_SETUP_SPEC), true);
  assert.equal(Object.isFrozen(HOURLY_PRICE_SETUP_IDS), true);
  for (const side of [1, -1] as const) {
    const input = candles(breakoutCloses().map(close => side === 1 ? close : 200 - close));
    const signals = build(input);
    assert.deepEqual(signals.map(signal => [signal.decisionMs, signal.side]),
      [[START + 169 * H, side], [START + 172 * H, side]]);
    assert.ok(signals.every(signal => signal.symbol === "BTC/USD" && signal.horizonHours === 24
      && signal.strength > 0 && signal.roomBps > 0));
  }
});

test("channel excludes current high/low, uses strict bounds, and suppresses persistent breakouts", () => {
  const input = candles(breakoutCloses());
  input[168]!.high = 200; // Current high cannot raise this decision's prior channel.
  const first = build(input)[0]!;
  assert.equal(first.decisionMs, START + 169 * H);
  assert.equal(build(candles([...Array<number>(168).fill(100), 100.1])).length, 0);
  assert.equal(build(candles([...Array<number>(168).fill(100), 99.9])).length, 0);
  const rising = candles([...Array<number>(168).fill(100), 101, 102, 103, 104]);
  assert.equal(build(rising).length, 1);
  const falling = candles([...Array<number>(168).fill(100), 99, 98, 97, 96]);
  assert.equal(build(falling).length, 1);
});

test("channel uses high/low from exactly the preceding 24 bars, including the oldest bound", () => {
  for (const side of [1, -1] as const) {
    const base = candles([...Array<number>(168).fill(100), side === 1 ? 101 : 99]);
    const outside = structuredClone(base), inside = structuredClone(base);
    if (side === 1) { outside[143]!.high = 110; inside[144]!.high = 110; }
    else { outside[143]!.low = 90; inside[144]!.low = 90; }
    assert.equal(build(outside).length, 1);
    assert.equal(build(inside).length, 0);
  }
});

test("geometric room includes true-range gaps and strength uses prior channel distance", () => {
  const input = candles([...Array<number>(168).fill(100), 110]);
  Object.assign(input[168]!, { open: 109, high: 111, low: 108 });
  const signal = build(input)[0]!, atr = (13 * .2 + 11) / 14;
  near(signal.roomBps, 2 * atr / 110 * 10_000);
  near(signal.strength, (110 - 100.1) / atr);
  assert.equal("meanNetBps" in signal, false);
  assert.equal("probability" in signal, false);
});

test("recovery confirms a delayed band crossing after the EMA crossing and triggers once", () => {
  for (const side of [1, -1] as const) {
    const input = candles(recoveryCloses().map(close => side === 1 ? close : 200 - close));
    const signals = build(input, "trend-recovery-24h");
    assert.deepEqual(signals.map(signal => [signal.decisionMs, signal.side]), [[START + 171 * H, side]]);
    assert.ok(signals[0]!.strength > .25);
    assert.equal(build(input.slice(0, 170), "trend-recovery-24h").length, 0);
  }
});

test("recovery requires current EMA trend and a pullback within exactly four prior bars", () => {
  const trend = Array.from({ length: 180 }, (_, i) => 100 + i * .1);
  assert.equal(build(candles(trend), "trend-recovery-24h").length, 0);
  const history = Array.from({ length: 168 }, (_, i) => 100 + i * .1);
  const fourth = [...history, 114, 115.55, 115.55, 115.55, 116.5];
  const fifth = [...history, 114, 115.55, 115.55, 115.55, 115.55, 116.5];
  assert.deepEqual(build(candles(fourth), "trend-recovery-24h").map(signal => signal.decisionMs), [START + 173 * H]);
  assert.deepEqual(build(candles(fifth), "trend-recovery-24h"), []);
  const fallingTrend = [...Array.from({ length: 168 }, (_, i) => 130 - i * .1), 111.8, 112.05, 112.1, 112.8];
  assert.equal(build(candles(fallingTrend), "trend-recovery-24h").some(signal => signal.side === 1), false);
});

test("169-bar readiness and close timestamp boundaries do not manufacture warmup transitions", () => {
  const input = candles(breakoutCloses()), at = START + 169 * H;
  assert.equal(build(input.slice(0, 168)).length, 0);
  assert.equal(build(input, "channel-breakout-24h", START, at).length, 0);
  assert.equal(build(input, "channel-breakout-24h", START, at + 1).length, 1);
  assert.equal(build(input, "channel-breakout-24h", at, at + 1)[0]!.decisionMs, at);
  assert.equal(build(input, "channel-breakout-24h", at + 1, at + H).length, 0);
  const alreadyBreaking = candles([...Array<number>(167).fill(100), 101, 102, 103]);
  assert.equal(build(alreadyBreaking).length, 0);
});

test("valid future prices cannot change earlier setup events and slicing the output range preserves state", () => {
  for (const setupId of HOURLY_PRICE_SETUP_IDS) {
    const closes = setupId === "channel-breakout-24h" ? breakoutCloses() : recoveryCloses();
    const input = candles([...closes, 120, 130, 125]), cutoff = START + closes.length * H;
    const earlier = build(input, setupId, START, cutoff + 1);
    const altered = input.map(bar => bar.openMs >= cutoff
      ? { ...bar, open: bar.open * 2, high: bar.high * 2, low: bar.low * 2, close: bar.close * 2 } : bar);
    assert.deepEqual(build(altered, setupId, START, cutoff + 1), earlier);
    assert.deepEqual(build(input.slice(0, closes.length), setupId, START, cutoff + 1), earlier);
    const all = build(input, setupId), fromMs = START + 170 * H;
    assert.deepEqual(build(input, setupId, fromMs), all.filter(signal => signal.decisionMs >= fromMs));
  }
});

test("each asset is independent and a missing own hour resets EMA and 169-bar readiness", () => {
  const own = candles(breakoutCloses()), peer = candles(recoveryCloses(), "ETH/USD");
  for (const setupId of HOURLY_PRICE_SETUP_IDS) {
    const full = build([...own, ...peer], setupId);
    assert.deepEqual(full.filter(signal => signal.symbol === "BTC/USD"), build(own, setupId));
    assert.deepEqual(full.filter(signal => signal.symbol === "ETH/USD"), build(peer, setupId));
    assert.deepEqual(build([...own, ...peer].reverse(), setupId), full);
  }
  const before = candles(Array.from({ length: 180 }, (_, i) => 100 + i));
  const after = candles(recoveryCloses(), "BTC/USD", START + 181 * H);
  const expected = build(after, "trend-recovery-24h");
  assert.equal(expected.length, 1);
  assert.deepEqual(build([...before, ...after], "trend-recovery-24h").filter(signal => signal.decisionMs >= START + 181 * H), expected);
  const early = candles([...Array<number>(167).fill(100), 101], "BTC/USD", START + 181 * H);
  assert.equal(build([...before, ...early]).filter(signal => signal.decisionMs >= START + 181 * H).length, 0);
});

test("flat prices do not produce infinities, inputs remain unchanged, and malformed candles fail explicitly", () => {
  const flat = candles(Array<number>(180).fill(100)).map(bar => ({ ...bar, high: 100, low: 100 }));
  for (const setupId of HOURLY_PRICE_SETUP_IDS) assert.deepEqual(build(flat, setupId), []);
  const input = candles(breakoutCloses()), before = structuredClone(input);
  build(input); assert.deepEqual(input, before);
  assert.throws(() => build([...input, input[0]!]), /DUPLICATE_PRICE_SETUP_BAR/);
  for (const changed of [{ close: NaN }, { openMs: START + 1 }, { volume: -1 }, { low: 500 }, { symbol: "SOL/USD" }])
    assert.throws(() => build([{ ...input[0]!, ...changed } as HourlyBar]), /INVALID_PRICE_SETUP_BAR/);
  assert.throws(() => build(input, "unregistered" as HourlyPriceSetupId), /INVALID_PRICE_SETUP_INPUT/);
  assert.throws(() => build(input, "channel-breakout-24h", START, START), /INVALID_PRICE_SETUP_INPUT/);
});
