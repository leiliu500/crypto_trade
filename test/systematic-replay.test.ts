import assert from "node:assert/strict";
import test from "node:test";
import { newLinearLedger, recordLinearFill } from "../src/economics/net-liquidation.js";
import type { FundingRow } from "../src/research/hourly-data.js";
import { prepareSystematicSignals, replaySystematic, replaySystematicBar, systematicFundingCash,
  SYSTEMATIC_REPLAY_ASSUMPTIONS as A, type ReplayPosition } from "../src/systematic/replay.js";
import { SYSTEMATIC_SPEC as S, type SystematicBar, type SystematicSignal } from "../src/systematic/spec.js";

const HOUR = S.barMs, START = Date.UTC(2024, 0, 1), END = START + 24 * HOUR;
function signal(symbol = "BTC/USD", side: 1 | -1 = 1): SystematicSignal {
  return { version: S.version, id: `${symbol}:signal`, symbol, barCloseMs: START - HOUR,
    availableAtMs: START - HOUR + 60_000, side, reason: "SYSTEMATIC_TREND_SIGNAL", close: 10_000,
    emaFast: 10_100, emaSlow: 9900, atr: 100, atrBps: 100, trendStrength: symbol === "BTC/USD" ? 2 : 1,
    stopBps: 200, targetBps: 400, bars: S.minimumBars, inputSha256: "a".repeat(64) };
}
function input() {
  const bars: SystematicBar[] = [], funding: FundingRow[] = [];
  for (let hour = 0; hour < 24; hour++) for (const symbol of ["BTC/USD", "ETH/USD"] as const) {
    bars.push({ symbol, openMs: START + hour * HOUR, open: 10_000, high: 10_010, low: 9990, close: 10_000, volume: 100 });
    funding.push({ symbol, timestampMs: START + (hour + 1) * HOUR, rate: .000001, absoluteRate: .01 });
  }
  for (const symbol of ["BTC/USD", "ETH/USD"] as const)
    funding.push({ symbol, timestampMs: END + HOUR, rate: .000001, absoluteRate: .02 });
  return { bars, funding, startMs: START, endMs: END, scenario: "base" as const,
    fundingAssumption: "source-plus-hour" as const, signals: new Map([[START, [signal(), signal("ETH/USD")]]]) };
}
function position(): ReplayPosition {
  const ledger = newLinearLedger(1); recordLinearFill(ledger, 1, 100, .05, false);
  return { symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: START, phase: "OPEN", ledger,
    signalId: "synthetic", signalCloseMs: START - HOUR, entryRawPx: 100,
    systematic: { version: S.version, signalId: "synthetic", signalBarCloseMs: START - HOUR,
      stopBps: 200, targetBps: 400, trailingBps: 200, trailActivationR: 1,
      maximumHoldMs: S.maximumHoldMs, feeBps: 5, fundingReserveBps: 9 } };
}

test("hourly replay preserves one shared slot, grid sizing, cap, and complete cost reconciliation", () => {
  const result = replaySystematic(input());
  assert.equal(result.completedTrades, 1); assert.equal(result.trades[0]!.symbol, "BTC/USD");
  assert.equal(result.riskBreachCount, 0); assert.ok(result.maximumEntryNotionalUsd <= 1000);
  assert.ok(Math.abs(result.trades[0]!.qty / .0001 - Math.round(result.trades[0]!.qty / .0001)) < 1e-8);
  assert.ok(result.accountingKnown); assert.ok(result.netPnlUsd! < 0, "flat prices lose fees, spread, slippage and funding");
  assert.ok(Math.abs(result.netPnlUsd! - (result.grossPnlUsd - result.feeUsd + result.fundingCashUsd!)) < 1e-9);
  assert.ok(Math.abs(result.dailyNetPnlUsd.reduce((sum, row) => sum + row.netPnlUsd!, 0) - result.netPnlUsd!) < 1e-9);
  assert.equal(result.dailyNetPnlUsd.reduce((sum, row) => sum + row.completedTrades, 0), 1);
  assert.equal(result.fundingRequiredHours, 24); assert.equal(result.missingFundingHours, 0);
  assert.ok(result.trades[0]!.entryPx >= 10_000 * (1 + (A.adverseSlippage.base + .5) / 10_000));
  assert.deepEqual(result.flatBenchmark, { completedTrades: 0, netPnlUsd: 0, maxDrawdownUsd: 0 });
});

test("stress increases explicit cash execution costs without relaxing signal age", () => {
  const base = replaySystematic(input()), stress = replaySystematic({ ...input(), scenario: "stress" });
  assert.equal(stress.completedTrades, 1); assert.ok(stress.netPnlUsd! < base.netPnlUsd!);
  assert.ok(stress.feeUsd > base.feeUsd); assert.ok(stress.trades[0]!.entryPx > base.trades[0]!.entryPx);
  const stale = input(); for (const s of stale.signals.get(START)!) { s.barCloseMs -= HOUR; s.availableAtMs -= HOUR; }
  const expired = replaySystematic(stale); assert.equal(expired.completedTrades, 0);
  assert.equal(expired.blockReasons.SIGNAL_STALE_OR_UNAVAILABLE, 2);
});

test("missing held funding makes all economic validation unknown and zero volume cannot supply a fill", () => {
  const missing = input(); missing.funding = missing.funding.filter(row => row.symbol !== "BTC/USD" || row.timestampMs !== START + HOUR);
  const result = replaySystematic(missing);
  assert.equal(result.accountingKnown, false); assert.equal(result.missingFundingHours, 1);
  assert.equal(result.netPnlUsd, null); assert.equal(result.maxDrawdownUsd, null);
  assert.ok(result.dailyNetPnlUsd.every(row => row.netPnlUsd === null));
  const noVolume = input(); noVolume.bars[0]!.volume = 0;
  const noFill = replaySystematic(noVolume); assert.equal(noFill.completedTrades, 0);
  assert.equal(noFill.blockReasons.ZERO_VOLUME_ENTRY_NO_FILL, 1, "unknown-at-open volume does not allow a peer fallback in the same candle");
});

test("absolute funding charges dollars per unit with direction and interval rather than trade-price multiplication", () => {
  assert.equal(systematicFundingCash(1, 2, .03, HOUR / 2), -.03);
  assert.equal(systematicFundingCash(-1, 2, .03, HOUR), .06);
  assert.throws(() => systematicFundingCash(1, 2, .03, HOUR + 1));
  const base = replaySystematic(input()), shifted = replaySystematic({ ...input(), fundingAssumption: "source-as-end" });
  assert.equal(shifted.fundingRequiredHours, shifted.fundingObservedHours);
  assert.ok(shifted.fundingCashUsd! < base.fundingCashUsd!, "source-as-end shifts the archived normalized timestamps back one hour");
});

test("ambiguous target and stop candles use the losing path and shared cash-aware exit rules", () => {
  const p = position(), original = structuredClone(p);
  const bar: SystematicBar = { symbol: p.symbol, openMs: START, open: 100, high: 106, low: 97, close: 101, volume: 10 };
  const result = replaySystematicBar(p, bar, 0, .01);
  assert.equal(result.exit?.reason, "SYSTEMATIC_STOP"); assert.ok(result.liquidationPnlUsd < -2);
  assert.equal(result.ambiguous, true); assert.deepEqual(p, original, "path trials cannot mutate the admitted position");
});

test("intrabar favorable peak then trailing giveback remains ordered in drawdown marks", () => {
  const p = position();
  const result = replaySystematicBar(p, { symbol: p.symbol, openMs: START, open: 100,
    high: 103.5, low: 99.5, close: 102.5, volume: 10 }, 0, .01);
  assert.equal(result.exit?.reason, "SYSTEMATIC_TRAIL");
  let high = 0, drawdown = 0;
  for (const row of result.liquidationMarks) { high = Math.max(high, row.netPnlUsd); drawdown = Math.max(drawdown, high - row.netPnlUsd); }
  assert.ok(high > 3.3); assert.ok(drawdown >= 1.99, "a favorable intrabar peak cannot disappear from drawdown");
  assert.ok(result.liquidationMarks.every((row, i, all) => !i || row.atMs >= all[i - 1]!.atMs));
});

test("completed-candle warmup is causal, finalization precedes fills, and an extra hour expires signals", () => {
  const bars: SystematicBar[] = [];
  for (let hour = -210; hour < 24; hour++) {
    const px = 10_000 + hour * 2;
    bars.push({ symbol: "BTC/USD", openMs: START + hour * HOUR, open: px, high: px + 100,
      low: px - 100, close: px + 1, volume: 10 });
  }
  const first = prepareSystematicSignals(bars, START, END).get(START)![0]!;
  assert.equal(first.barCloseMs, START - HOUR); assert.equal(first.availableAtMs, START - HOUR + 60_000);
  const changed = structuredClone(bars);
  for (const bar of changed) if (bar.openMs >= START - HOUR) {
    bar.open *= 2; bar.high *= 2; bar.low *= 2; bar.close *= 2;
  }
  assert.deepEqual(prepareSystematicSignals(changed, START, END).get(START)![0], first);
  const later = prepareSystematicSignals(bars, START, END, 2).get(START)![0]!;
  assert.ok(START - later.barCloseMs > S.maximumSignalAgeMs);
  const invalid = input(); invalid.signals.get(START)![0]!.barCloseMs = START + HOUR;
  invalid.signals.get(START)![1]!.side = 2 as 1;
  assert.equal(replaySystematic(invalid).completedTrades, 0);
});
