import assert from "node:assert/strict";
import test from "node:test";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { prepareProfitStudyData, prepareProfitStudyForecasts, PROFIT_STUDY_DESIGN as D,
  PROFIT_STUDY_WINDOWS as WINDOWS } from "../src/profit/study.js";
import type { FundingRow, HourlyBar } from "../src/research/hourly-data.js";

const T = WINDOWS[0]!.startMs, END = WINDOWS.at(-1)!.endMs;
function bar(openMs = T, close = 100): HourlyBar {
  return { symbol: "BTC/USD", openMs, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}
function rate(timestampMs = T + S.hourMs, amount = .01): FundingRow {
  return { symbol: "BTC/USD", timestampMs, rate: amount, absoluteRate: amount * 100 };
}

test("study overlap deduplication and hashes use economic fields rather than property or source order", () => {
  const b = bar(), f = rate(), b2 = bar(T + S.hourMs), f2 = rate(T + 2 * S.hourMs);
  const reversedBar = { volume: b.volume, close: b.close, low: b.low, high: b.high,
    open: b.open, openMs: b.openMs, symbol: b.symbol };
  const reversedRate = { absoluteRate: f.absoluteRate!, rate: f.rate, timestampMs: f.timestampMs, symbol: f.symbol };
  const first = { bars: [b, b2], funding: [f, f2] }, overlap = { bars: [reversedBar], funding: [reversedRate] };
  const before = structuredClone([first, overlap]);
  const expected = prepareProfitStudyData([first]);
  assert.deepEqual(prepareProfitStudyData([first, overlap]), expected);
  assert.deepEqual(prepareProfitStudyData([overlap, first]), expected);
  assert.deepEqual(prepareProfitStudyData([{ bars: [...first.bars].reverse(), funding: [...first.funding].reverse() }]), expected);
  assert.equal(expected.bars.length, 2); assert.equal(expected.funding.length, 2);
  assert.deepEqual([first, overlap], before, "preparation must not mutate source records");
});

test("conflicting admitted overlap fails closed for candles and both funding quantities", () => {
  const source = { bars: [bar()], funding: [rate()] };
  assert.throws(() => prepareProfitStudyData([source, { bars: [bar(T, 101)], funding: [] }]), /CONFLICTING_BAR/);
  assert.throws(() => prepareProfitStudyData([source, { bars: [], funding: [rate(T + S.hourMs, .02)] }]), /CONFLICTING_FUNDING/);
  assert.throws(() => prepareProfitStudyData([source, { bars: [], funding: [{ ...rate(), absoluteRate: 2 }] }]), /CONFLICTING_FUNDING/);
  assert.throws(() => prepareProfitStudyData([source, { bars: [], funding: [{ symbol: "BTC/USD", timestampMs: T + S.hourMs, rate: .01 }] }]),
    /CONFLICTING_FUNDING/, "unknown absolute funding cannot replace a known amount");
});

test("reserved and future data are excluded before conflict checks and feature preparation", () => {
  const source = { bars: [bar(D.historyStartMs), bar(T), bar(END - S.hourMs)],
    funding: [rate(T), rate(END), rate(END + S.hourMs)] };
  const excluded = { bars: [bar(D.historyStartMs - S.hourMs), bar(END), bar(D.reservedWindow.startMs),
    bar(D.reservedWindow.startMs, 100_000)], funding: [rate(T - S.hourMs), rate(END + 2 * S.hourMs),
    rate(D.reservedWindow.startMs), rate(D.reservedWindow.startMs, .9)] };
  const expected = prepareProfitStudyData([source]);
  assert.deepEqual(prepareProfitStudyData([source, excluded]), expected);
  assert.ok(expected.bars.every(row => row.openMs < END));
  assert.equal(expected.funding.at(-1)!.timestampMs, END + S.hourMs,
    "one extra normalized interval end is retained for the declared one-hour funding shift");
});

test("study January forecasts and fitted evidence do not change when later daily prices change", () => {
  const start = Date.UTC(2022, 11, 1), cutoff = Date.UTC(2024, 0, 8), stop = Date.UTC(2024, 1, 1);
  const bars: HourlyBar[] = [];
  for (let at = start; at < stop; at += S.hourMs) for (const [i, symbol] of S.symbols.entries()) {
    const px = (i + 1) * 1000 * Math.exp(.00002 * (at - start) / S.hourMs);
    bars.push({ symbol, openMs: at, open: px, high: px + 1, low: px - 1, close: px, volume: 10 });
  }
  const original = prepareProfitStudyForecasts(bars);
  const changed = prepareProfitStudyForecasts(bars.map(row => row.openMs >= cutoff
    ? { ...row, open: row.open * 2, high: row.high * 2, low: row.low * 2, close: row.close * 2 } : row));
  assert.ok(original.fits.length > 0); assert.ok(original.forecasts.length > 0);
  assert.deepEqual(changed.fits.filter(fit => fit.fitAtMs < cutoff), original.fits.filter(fit => fit.fitAtMs < cutoff));
  assert.deepEqual(changed.forecasts.filter(f => f.decisionMs < cutoff), original.forecasts.filter(f => f.decisionMs < cutoff));
  for (const fit of original.fits) {
    assert.ok(fit.maximumLabelAvailableAtMs <= fit.fitAtMs);
    assert.ok(fit.maximumLabelEndMs + S.labelPublicationLagDays * S.dayMs + S.candleFinalizationDelayMs <= fit.fitAtMs);
  }
  for (const forecast of original.forecasts) {
    assert.ok(forecast.fitAtMs <= forecast.decisionMs);
    assert.equal(forecast.availableAtMs % S.dayMs, S.candleFinalizationDelayMs);
    assert.equal(new Date(forecast.decisionMs).getUTCDay(), 1);
    assert.ok(forecast.decisionMs < END);
  }
});
