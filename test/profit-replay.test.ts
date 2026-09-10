import assert from "node:assert/strict";
import test from "node:test";
import type { FundingRow } from "../src/research/hourly-data.js";
import type { ProfitBar, ProfitForecast, ProfitSymbol } from "../src/profit/model.js";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { replayProfit, PROFIT_REPLAY_ASSUMPTIONS as A } from "../src/profit/replay.js";

const HOUR = S.hourMs, DAY = S.dayMs, START = Date.UTC(2024, 0, 1), END = START + 14 * DAY;
function forecast(symbol: ProfitSymbol, week: number, lower = symbol === "BTC/USD" ? 200 : 100): ProfitForecast {
  const decisionMs = START + week * S.weekMs + S.candleFinalizationDelayMs;
  return { version: S.version, id: `${symbol}:${week}`, modelId: "SYNTHETIC_TEST_MODEL", symbol,
    decisionMs, availableAtMs: decisionMs, expiresAtMs: decisionMs + S.maximumSignalAgeMs,
    horizonEndMs: decisionMs + S.weekMs, fitAtMs: START + 60_000, close: 10_000,
    sigmaDay: .02, sigmaHorizon: .02 * Math.sqrt(7), features: [1, 1, 1],
    meanGrossBps: lower + 10, lowerGrossBps: lower, upperGrossBps: lower + 20,
    nWeeks: 52, inputSha256: "a".repeat(64), modelInputSha256: "b".repeat(64), specSha256: "c".repeat(64),
    maximumLabelEndMs: START - DAY, maximumLabelAvailableAtMs: START,
    intervalInterpretation: "MOVING_WEEK_BLOCK_BOOTSTRAP_CONDITIONAL_MEAN_NOT_PREDICTIVE_INTERVAL", winProbability: null };
}
function input() {
  const bars: ProfitBar[] = [], funding: FundingRow[] = [], forecasts: ProfitForecast[] = [];
  for (let atMs = START; atMs < END; atMs += HOUR) for (const symbol of S.symbols) {
    bars.push({ symbol, openMs: atMs, open: 10_000, high: 10_010, low: 9990, close: 10_000, volume: 100 });
    funding.push({ symbol, timestampMs: atMs + HOUR, rate: .000001, absoluteRate: .01 });
  }
  for (const symbol of S.symbols) funding.push({ symbol, timestampMs: END + HOUR, rate: .000001, absoluteRate: .01 });
  for (const week of [0, 1]) for (const symbol of S.symbols) forecasts.push(forecast(symbol, week));
  return { bars, funding, forecasts, startMs: START, endMs: END,
    scenario: "base" as const, fundingAssumption: "source-plus-hour" as const };
}
const entries = (r: ReturnType<typeof replayProfit>) => r.orders.filter(o => !o.reduceOnly);

test("weekly inventory holds through unchanged forecasts; all cash reconciles and flat prices lose real costs", () => {
  const r = replayProfit(input());
  assert.equal(r.accountingKnown, true); assert.equal(r.completedTrades, 1); assert.equal(entries(r).length, 1);
  assert.equal(entries(r)[0]!.symbol, "BTC/USD"); assert.equal(entries(r)[0]!.atMs, START + HOUR);
  assert.equal(r.trades[0]!.exitMs, END - 48 * HOUR); assert.equal(r.trades[0]!.reason, "WINDOW_FLATTEN");
  assert.equal(r.trades[0]!.forecastId, "BTC/USD:0", "episode retains its original model decision ID");
  assert.ok(r.netPnlUsd! < 0); assert.ok(Math.abs(r.netPnlUsd! - (r.grossPnlUsd - r.feeUsd + r.fundingCashUsd!)) < 1e-9);
  assert.ok(Math.abs(r.dailyNetPnlUsd.reduce((sum, d) => sum + d.netPnlUsd!, 0) - r.netPnlUsd!) < 1e-9);
  assert.ok(Math.abs(r.trades.reduce((sum, t) => sum + t.netPnlUsd!, 0) - r.netPnlUsd!) < 1e-9);
  const actualEntry = entries(r)[0]!;
  const independentlyComputedFees = r.orders.reduce((sum, o) => sum + o.qty * o.price * .0005, 0);
  const independentlyComputedGross = r.orders.filter(o => o.reduceOnly)
    .reduce((sum, o) => sum + actualEntry.side * o.qty * (o.price - actualEntry.price), 0);
  assert.ok(Math.abs(r.feeUsd - independentlyComputedFees) < 1e-9);
  assert.ok(Math.abs(r.grossPnlUsd - independentlyComputedGross) < 1e-9);
  assert.ok(r.maximumEntryNotionalUsd <= 1000); assert.equal(r.riskBreachCount, 0);
  assert.equal(r.hurdleBps, 37); assert.ok(entries(r)[0]!.qty * entries(r)[0]!.price > 990,
    "risk math has no unrelated 20-bps micro-volatility rescaling");
  assert.deepEqual(r.flatBenchmark, { completedTrades: 0, netPnlUsd: 0, maxDrawdownUsd: 0 });
});

test("stress delays execution by another hour and charges higher fees and adverse prices", () => {
  const base = replayProfit(input()), stress = replayProfit({ ...input(), scenario: "stress" });
  assert.equal(entries(stress)[0]!.atMs, START + 2 * HOUR);
  assert.ok(entries(stress)[0]!.price > entries(base)[0]!.price);
  assert.ok(stress.feeUsd > base.feeUsd); assert.ok(stress.netPnlUsd! < base.netPnlUsd!);
  assert.equal(stress.hurdleBps, 45);
});

test("weekly challenger must clear hysteresis; a switch reduces before filling the new symbol next hour", () => {
  const weak = input(); weak.forecasts = weak.forecasts.map(f => f.id === "ETH/USD:1" ? forecast("ETH/USD", 1, 201) : f);
  assert.equal(entries(replayProfit(weak)).length, 1);
  const strong = input(); strong.forecasts = strong.forecasts.map(f => f.id === "ETH/USD:1" ? forecast("ETH/USD", 1, 300) : f);
  const r = replayProfit(strong), e = entries(r), close = r.orders.find(o => o.reason === "WEEKLY_SWITCH")!;
  assert.equal(e.length, 2); assert.equal(e[1]!.symbol, "ETH/USD");
  assert.equal(close.atMs, START + 7 * DAY + HOUR); assert.equal(e[1]!.atMs, close.atMs + HOUR);
  assert.ok(Math.abs(r.trades.reduce((sum, t) => sum + t.netPnlUsd!, 0) - r.netPnlUsd!) < 1e-9);
});

test("stop locks same-week reentry, preserves favorable-then-stop drawdown, and permits a new weekly forecast", () => {
  const data = input();
  const b = data.bars.find(b => b.symbol === "BTC/USD" && b.openMs === START + 2 * HOUR)!;
  b.high = 10_700; b.low = 9000;
  const r = replayProfit(data), e = entries(r);
  assert.equal(e.length, 2); assert.equal(e[1]!.atMs, START + 7 * DAY + HOUR);
  assert.equal(r.trades[0]!.reason, "HARD_STOP_4_DAILY_SIGMA");
  assert.ok(r.maxDrawdownUsd! > 140, "a favorable mark followed by a stop must contribute the whole giveback");
  assert.ok(r.trades[0]!.exitPx < e[0]!.price * .92, "stop fill includes adverse execution beyond threshold");
});

test("cap and risk reductions reconcile one episode without adding when prices decline later", () => {
  const data = input();
  for (const b of data.bars) if (b.symbol === "BTC/USD" && b.openMs >= START + 2 * HOUR) {
    b.open = b.close = b.openMs < START + DAY ? 12_000 : 10_000;
    b.high = b.open + 10; b.low = b.open - 10;
  }
  const r = replayProfit(data), e = entries(r), trims = r.orders.filter(o => o.reason === "CAP_OR_RISK_REDUCTION");
  assert.equal(e.length, 1); assert.ok(trims.length > 0); assert.equal(r.completedTrades, 1);
  assert.ok(r.trades[0]!.reductions > 1);
  assert.ok(Math.abs(r.orders.filter(o => o.reduceOnly).reduce((sum, o) => sum + o.qty, 0) - e[0]!.qty) < 1e-10);
  assert.ok(Math.abs(r.trades[0]!.netPnlUsd! - r.netPnlUsd!) < 1e-9);
});

test("a cap reduction that flattens below the minimum lot consumes the current weekly target", () => {
  const data = input();
  const b = data.bars.find(b => b.symbol === "BTC/USD" && b.openMs === START + 2 * HOUR)!;
  b.open = b.close = 20_000_000; b.high = 20_000_001; b.low = 19_999_999;
  const r = replayProfit(data), e = entries(r);
  assert.equal(r.trades[0]!.reason, "CAP_OR_RISK_REDUCTION");
  assert.equal(e.length, 1);
  assert.equal(r.blockReasons.RISK_REDUCTION_WAIT_FOR_NEXT_WEEKLY_FORECAST, 1);
  assert.ok(r.riskHaltReasons.includes("ROLLING_LOSS"), "the large gap also preserves the account risk halt");
});

test("missing held funding makes accounting unknown and blocks later entries", () => {
  const data = input(); data.funding = data.funding.filter(f => f.symbol !== "BTC/USD" || f.timestampMs !== START + 2 * HOUR);
  data.forecasts = data.forecasts.map(f => f.id === "ETH/USD:1" ? forecast("ETH/USD", 1, 300) : f);
  const r = replayProfit(data);
  assert.equal(r.missingFundingHours, 1); assert.equal(r.accountingKnown, false); assert.equal(r.netPnlUsd, null);
  assert.equal(r.maxDrawdownUsd, null); assert.equal(r.trades[0]!.fundingCashUsd, null);
  assert.equal(entries(r).length, 1); assert.ok(r.dailyNetPnlUsd.every(d => d.netPnlUsd === null));
  assert.ok(r.riskHaltReasons.includes("ACCOUNT_UNKNOWN"));
});

test("funding uses signed absolute dollars per unit and exposes timestamp interpretation sensitivity", () => {
  const data = input();
  data.funding.find(f => f.symbol === "BTC/USD" && f.timestampMs === START + 2 * HOUR)!.absoluteRate = 1;
  const plus = replayProfit(data), end = replayProfit({ ...data, fundingAssumption: "source-as-end" });
  assert.ok(plus.fundingCashUsd! < end.fundingCashUsd!);
  const qty = entries(plus)[0]!.qty;
  assert.ok(Math.abs(plus.fundingCashUsd! - end.fundingCashUsd! + qty * .99) < 1e-9);
});

test("funding uses normalized interval ends and prorates only the held part of an intrabar stop", () => {
  const data = input();
  const b = data.bars.find(b => b.symbol === "BTC/USD" && b.openMs === START + 2 * HOUR)!;
  b.low = 9000;
  const r = replayProfit(data), first = r.trades[0]!;
  assert.equal(first.exitMs, START + 2 * HOUR + 2 * HOUR / 3);
  assert.ok(Math.abs(first.fundingCashUsd! + first.entryQty * .01 * (1 + 2 / 3)) < 1e-9);
  const missing = input();
  // The [01:00,02:00) entry hour consumes the archived row ending at 02:00.
  missing.funding = missing.funding.filter(f => f.symbol !== "BTC/USD" || f.timestampMs !== START + 2 * HOUR);
  assert.equal(replayProfit(missing).missingFundingHours, 1);
});

test("positive absolute funding credits short inventory and reduction fills preserve signed price cash", () => {
  const data = input();
  data.forecasts = data.forecasts.map(f => ({ ...f, meanGrossBps: -200, lowerGrossBps: -300,
    upperGrossBps: f.symbol === "BTC/USD" ? -200 : -100 }));
  const r = replayProfit(data), e = entries(r);
  assert.equal(e.length, 1); assert.equal(e[0]!.side, -1); assert.ok(r.fundingCashUsd! > 0);
  assert.ok(r.orders.filter(o => o.reduceOnly).every(o => o.side === 1));
  const gross = r.orders.filter(o => o.reduceOnly)
    .reduce((sum, o) => sum - o.qty * (o.price - e[0]!.price), 0);
  assert.ok(Math.abs(gross - r.grossPnlUsd) < 1e-9);
  assert.ok(Math.abs(r.netPnlUsd! - (gross - r.feeUsd + r.fundingCashUsd!)) < 1e-9);
});

test("recorded funding losses activate the account rolling-loss halt and prevent subsequent entries", () => {
  const data = input();
  data.funding.find(f => f.symbol === "BTC/USD" && f.timestampMs === START + 2 * HOUR)!.absoluteRate = 10_000;
  data.forecasts = data.forecasts.map(f => f.id === "ETH/USD:1" ? forecast("ETH/USD", 1, 300) : f);
  const r = replayProfit(data);
  assert.equal(r.accountingKnown, true); assert.ok(r.riskHaltReasons.includes("ROLLING_LOSS"));
  assert.equal(entries(r).length, 1); assert.ok(r.netPnlUsd! < -750);
  assert.ok(Object.keys(r.blockReasons).some(reason => reason.startsWith("RISK_HALT:")));
});

test("higher daily volatility reduces size from the declared dollar loss budget", () => {
  const data = input();
  data.forecasts = data.forecasts.map(f => ({ ...f, sigmaDay: .1, sigmaHorizon: .1 * Math.sqrt(7) }));
  const r = replayProfit(data), entry = entries(r)[0]!;
  const modeledLoss = entry.qty * entry.price * (4 * .1 + r.hurdleBps / 10_000);
  assert.ok(modeledLoss <= 100); assert.ok(modeledLoss > 99);
  assert.ok(entry.qty * entry.price < 250); assert.equal(r.riskBreachCount, 0);
});

test("a new position reserves remaining rolling-loss dollars before entry", () => {
  const data = input();
  const b = data.bars.find(b => b.symbol === "BTC/USD" && b.openMs === START + 7 * DAY - HOUR)!;
  b.open = b.close = 3000; b.high = 3010; b.low = 2990;
  const r = replayProfit(data), e = entries(r);
  assert.equal(e.length, 2); assert.equal(r.trades[0]!.reason, "HARD_STOP_4_DAILY_SIGMA");
  assert.ok(e[1]!.qty < e[0]!.qty * .6, "loss headroom reduces the next stop-risk allocation");
  const accountEquity = A.initialEquityUsd + r.trades[0]!.netPnlUsd!;
  const close = r.orders.find(o => o.reason === "HARD_STOP_4_DAILY_SIGMA")!;
  const heldHoursInsideRollingWindow = (close.atMs - (e[1]!.atMs - DAY)) / HOUR;
  const rollingNet = close.grossPnlUsd - close.feeUsd - e[0]!.qty * .01 * heldHoursInsideRollingWindow;
  const remainingLossCapacity = accountEquity * S.rollingLossFraction + rollingNet;
  const modeledLoss = e[1]!.qty * e[1]!.price * (4 * .02 + r.hurdleBps / 10_000);
  assert.ok(modeledLoss <= remainingLossCapacity + 1e-8,
    "remaining capacity counts only cash flows in the previous 24 hours");
  assert.equal(r.riskBreachCount, 0);
});

test("zero volume never fills or falls back to the peer, retries expire, and unfilled flatten stays unresolved", () => {
  const delayed = input(); delayed.bars.find(b => b.symbol === "BTC/USD" && b.openMs === START + HOUR)!.volume = 0;
  const r = replayProfit(delayed); assert.equal(entries(r)[0]!.symbol, "BTC/USD");
  assert.equal(entries(r)[0]!.atMs, START + 2 * HOUR);
  const expired = input();
  for (const b of expired.bars) if (b.symbol === "BTC/USD") b.volume = 0;
  const e = replayProfit(expired); assert.equal(entries(e).length, 0); assert.equal(e.blockReasons.FORECAST_EXPIRED, 2);
  const unresolved = input();
  for (const b of unresolved.bars) if (b.symbol === "BTC/USD" && b.openMs >= END - 48 * HOUR) b.volume = 0;
  const u = replayProfit(unresolved); assert.ok(u.unresolvedPosition); assert.equal(u.completedTrades, 0);
  assert.equal(u.netPnlUsd, null); assert.equal(u.accountingKnown, false);
});

test("risk-managed long benchmarks are explicit policy overrides, with no fabricated model confidence", () => {
  const data = input(); data.forecasts = data.forecasts.map(f => ({ ...f, lowerGrossBps: -20, upperGrossBps: 20, meanGrossBps: 0 }));
  assert.equal(entries(replayProfit(data)).length, 0);
  const btc = replayProfit({ ...data, policy: "risk-managed-long-btc" });
  const eth = replayProfit({ ...data, policy: "risk-managed-long-eth" });
  assert.equal(btc.benchmarkOnly, true); assert.equal(entries(btc)[0]!.symbol, "BTC/USD");
  assert.equal(entries(eth)[0]!.symbol, "ETH/USD"); assert.equal(entries(btc)[0]!.reason, "BENCHMARK_LONG_ENTRY");
  assert.equal(data.forecasts[0]!.lowerGrossBps, -20, "benchmark does not alter the model forecast");
});

test("invalid or not-yet-matured forecasts cannot authorize entries", () => {
  const data = input(); data.forecasts = data.forecasts.map(f => ({ ...f, maximumLabelAvailableAtMs: f.fitAtMs + HOUR }));
  const r = replayProfit(data); assert.equal(entries(r).length, 0);
  assert.equal(r.blockReasons.FORECAST_INVALID_OR_UNMATURED, 4);
  const duplicate = input(); duplicate.forecasts.push(duplicate.forecasts[0]!);
  assert.throws(() => replayProfit(duplicate), /DUPLICATE_PROFIT_FORECAST/);
});
