import assert from "node:assert/strict";
import test from "node:test";
import type { FundingRow, HourlyBar } from "../src/research/hourly-data.js";
import { channelDailyBars, channelSignals, replayChannel } from "../src/channel/replay.js";
import { CHANNEL_SPEC as S } from "../src/channel/spec.js";
const T = Date.UTC(2024, 0, 1), H = S.hourMs, D = S.dayMs;
function history(days = 6) {
  const bars: HourlyBar[] = [], funding: FundingRow[] = [];
  for (const symbol of S.symbols) for (let t = T - 60 * D; t < T + days * D; t += H) {
    const p = t < T - D ? 100 : 110;
    bars.push({ symbol, openMs: t, open: p, high: p + 1, low: p - 1, close: p, volume: 1000 });
    if (t >= T) funding.push({ symbol, timestampMs: t + H, rate: .00001, absoluteRate: .01 });
  }
  return { bars, funding, startMs: T, endMs: T + days * D, scenario: "base" as const };
}
test("channels exclude the signal day and require complete daily warmup", () => {
  const { bars } = history(), daily = channelDailyBars(bars), signals = channelSignals(daily);
  const s = signals.find(x => x.symbol === "BTC/USD" && x.endMs === T)!;
  assert.equal(s.entrySide, 1); assert.equal(s.close, 110); assert.ok(s.atr > 2);
  assert.equal(signals.some(x => x.endMs < T), true);
  const missing = bars.filter(b => !(b.symbol === "BTC/USD" && b.openMs === T - 3 * D));
  assert.equal(channelSignals(channelDailyBars(missing)).some(x => x.symbol === "BTC/USD" && x.endMs === T), false);
});
test("both assets can hold concurrently with causal delayed fills, risk sizing and a reconciled funded ledger", () => {
  const result = replayChannel(history());
  const entries = result.orders.filter(o => !o.reduceOnly);
  assert.equal(entries.length, 2); assert.equal(entries.every(o => o.atMs === T + H), true);
  assert.deepEqual(entries.map(o => o.symbol), ["BTC/USD", "ETH/USD"]);
  for (const e of entries) assert.ok(e.qty * e.price <= 1000 + 1e-8);
  assert.ok(result.maximumEntryRiskUsd <= 100 + 1e-8);
  assert.equal(result.closedEpisodes, 2); assert.equal(result.accountingKnown, true);
  assert.ok(result.fundingCashUsd! < 0);
  assert.ok(Math.abs(result.netPnlUsd! - (result.grossPnlUsd - result.feeUsd + result.fundingCashUsd!)) < 1e-7);
  assert.ok(Math.abs(result.dailyNetPnlUsd.reduce((n, d) => n + d.netPnlUsd, 0) - result.netPnlUsd!) < 1e-7);
  const stress = replayChannel({ ...history(), scenario: "stress" });
  assert.equal(stress.orders.filter(o => !o.reduceOnly).every(o => o.atMs === T + 2 * H), true);
  assert.ok(stress.feeUsd > 0);
});
test("opening stop gaps fill adversely at the available open and cannot reenter on the old signal", () => {
  const input = history();
  for (const b of input.bars) if (b.symbol === "BTC/USD" && b.openMs === T + 2 * H)
    Object.assign(b, { open: 80, high: 81, low: 79, close: 80 });
  const result = replayChannel(input), exit = result.orders.find(o => o.symbol === "BTC/USD" && o.reason === "PROTECTIVE_OPEN_GAP")!;
  assert.ok(exit.price < 80); assert.equal(exit.atMs, T + 2 * H);
  assert.equal(result.orders.filter(o => o.symbol === "BTC/USD" && !o.reduceOnly && o.atMs < T + D).length, 1);
});
test("ambiguous intrahour stops pay adverse funding and forgo favorable funding", () => {
  const input = history();
  for (const b of input.bars) if (b.openMs === T + 2 * H) Object.assign(b, { low: 90 });
  for (const r of input.funding) r.absoluteRate = r.symbol === "BTC/USD" ? .5 : -.5;
  const result = replayChannel(input);
  const btc = result.episodes.find(e => e.symbol === "BTC/USD")!, eth = result.episodes.find(e => e.symbol === "ETH/USD")!;
  assert.equal(btc.reason, "PROTECTIVE_INTRAHOUR_TOUCH"); assert.equal(eth.reason, "PROTECTIVE_INTRAHOUR_TOUCH");
  assert.ok(Math.abs(btc.fundingCashUsd + btc.entryQty) < 1e-7);
  assert.ok(Math.abs(eth.fundingCashUsd - eth.entryQty * .5) < 1e-7);
});
test("held funding gaps and unresolved terminal exposure make full results unknown", () => {
  const input = history();
  input.funding = input.funding.filter(f => !(f.symbol === "BTC/USD" && f.timestampMs === T + 3 * H));
  const missing = replayChannel(input);
  assert.equal(missing.accountingKnown, false); assert.equal(missing.netPnlUsd, null); assert.equal(missing.missingFunding.length, 1);
  const unavailable = history();
  for (const b of unavailable.bars) if (b.openMs >= unavailable.endMs - D) b.volume = 0;
  const unresolved = replayChannel(unavailable);
  assert.equal(unresolved.accountingKnown, false); assert.equal(unresolved.unresolved.length, 2);
});
test("trailing protection ratchets with completed data and preserves winners across daily updates", () => {
  const input = history();
  for (const b of input.bars) if (b.openMs >= T) {
    const p = 110 + Math.floor((b.openMs - T) / D) * 2;
    Object.assign(b, { open: p, high: p + .2, low: p - .2, close: p });
  }
  const result = replayChannel(input);
  assert.equal(result.orders.filter(o => !o.reduceOnly).length, 2);
  assert.equal(result.episodes.every(e => e.reason === "TERMINAL_FLATTEN"), true);
  assert.equal(result.orders.some(o => o.reason.includes("ORIGINAL_STOP")), false);
});
test("duplicate market observations are rejected instead of inflated into daily candles", () => {
  const input = history(); input.bars.push(input.bars[0]!);
  assert.throws(() => replayChannel(input), /DUPLICATE_CHANNEL_BAR/);
});

test("a large funding loss triggers the account session stop with no hidden smaller loss screen", () => {
  const input = history();
  for (const f of input.funding) if (f.timestampMs === T + 2 * H) f.absoluteRate = 100;
  const result = replayChannel(input);
  assert.ok(result.orders.some(o => o.reason === "ACCOUNT_RISK_FLATTEN"));
  assert.ok(result.haltReasons.SESSION_OR_ROLLING_LOSS_ENVELOPE! > 0);
  assert.equal(result.accountingKnown, true);
  assert.ok(result.netPnlUsd! < -750);
});
