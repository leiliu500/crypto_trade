import assert from "node:assert/strict";
import test from "node:test";
import { buildPortfolioTargets } from "../src/portfolio/signals.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SPEC,
  PORTFOLIO_SYMBOLS, PORTFOLIO_VERSION, type HourlyBar, type PortfolioPolicy, type PortfolioTarget } from "../src/portfolio/types.js";

const START = Date.UTC(2022, 0, 1), FIRST = START + 361 * DAY;
const near = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance,
  `Expected ${actual} near ${expected}`);
function bars(days = 363, price: (day: number, asset: number) => number = day => 100 * Math.exp(day * .001)): HourlyBar[] {
  return PORTFOLIO_SYMBOLS.flatMap((symbol, asset) => Array.from({ length: days * 24 }, (_, i) => {
    const close = price(Math.floor(i / 24), asset);
    return { symbol, openMs: START + i * HOUR, open: close, high: close, low: close, close, volume: 0 };
  }));
}
function only(input: readonly HourlyBar[], at = FIRST, policy: PortfolioPolicy = "multiscale-trend"): PortfolioTarget {
  const output = buildPortfolioTargets(input, at, at + DAY, policy);
  assert.equal(output.length, 1); return output[0]!;
}

test("every policy needs 361 consecutive paired complete UTC daily closes", () => {
  const full = bars(361), short = bars(360);
  for (const policy of ["multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat"] as const) {
    assert.deepEqual(buildPortfolioTargets(short, FIRST, FIRST + DAY, policy), []);
    assert.deepEqual(buildPortfolioTargets(full.filter(b => b.symbol === "BTC/USD"), FIRST, FIRST + DAY, policy), []);
    const target = only(full, FIRST, policy);
    assert.equal(target.decisionMs, FIRST); assert.equal(target.availableAtMs, FIRST);
    assert.equal(target.validUntilMs, FIRST + 2 * DAY); assert.equal(target.version, PORTFOLIO_VERSION);
  }
});

test("a day finalizes only after all 24 hours and targets obey inclusive start/exclusive end", () => {
  const full = bars(362);
  for (const hour of [0, 12, 23]) {
    const incomplete = full.filter(b => !(b.symbol === "ETH/USD" && b.openMs === START + 360 * DAY + hour * HOUR));
    assert.deepEqual(buildPortfolioTargets(incomplete, FIRST, FIRST + DAY), []);
  }
  assert.deepEqual(buildPortfolioTargets(full, START, FIRST), []);
  assert.deepEqual(buildPortfolioTargets(full, FIRST, FIRST + DAY).map(t => t.decisionMs), [FIRST]);
  assert.deepEqual(buildPortfolioTargets(full, FIRST, FIRST + 2 * DAY).map(t => t.decisionMs), [FIRST, FIRST + DAY]);
});

test("multiscale arithmetic uses RMS of exactly the latest 60 returns and does not force full exposure", () => {
  const drift = .00001, oscillation = .01;
  const price = (day: number, asset: number) => 100 * Math.exp((asset + 1) * (day * drift + (day % 2) * oscillation));
  const target = only(bars(361, price)), volatility = Math.sqrt(drift ** 2 + oscillation ** 2);
  const scores = [30, 90, 360].map(h => drift * Math.sqrt(h) / volatility);
  near(target.signals[0]!.dailyVolatility, volatility);
  near(target.signals[1]!.dailyVolatility, 2 * volatility);
  near(target.signals[0]!.relativeRiskWeight, 2 / 3); near(target.signals[1]!.relativeRiskWeight, 1 / 3);
  for (const signal of target.signals) {
    signal.trendScores.forEach((score, i) => near(score, scores[i]!));
    near(signal.score, scores.reduce((a, b) => a + b) / 3);
  }
  near(target.targetUsd["BTC/USD"], 8 * target.signals[0]!.score);
  near(target.targetUsd["ETH/USD"], 4 * target.signals[1]!.score);
  assert.ok(Math.abs(target.targetUsd["BTC/USD"]) + Math.abs(target.targetUsd["ETH/USD"]) < 1);
});

test("60-return RMS includes the current return but excludes a shock 61 days ago", () => {
  const withShock = (day: number) => 100 * Math.exp(day >= 300 ? .2 : 0);
  const at = START + 362 * DAY, target = only(bars(362, withShock), at);
  near(target.signals[0]!.dailyVolatility, .0001);
  const currentShock = only(bars(361, day => 100 * Math.exp(day === 360 ? .2 : 0)));
  near(currentShock.signals[0]!.dailyVolatility, .2 / Math.sqrt(60));
});

test("direction reversals and per-horizon clipping preserve the shared gross risk budget", () => {
  const input = bars(361, (day, asset) => 100 * Math.exp((asset === 0 ? 1 : -1) * day * .005));
  const target = only(input);
  assert.deepEqual(target.signals[0]!.trendScores, [1, 1, 1]);
  assert.deepEqual(target.signals[1]!.trendScores, [-1, -1, -1]);
  near(target.targetUsd["BTC/USD"], 6); near(target.targetUsd["ETH/USD"], -6);
  const reversed = only(bars(361, (day, asset) => 100 * Math.exp((asset === 0 ? -1 : 1) * day * .005)));
  near(reversed.targetUsd["BTC/USD"], -6); near(reversed.targetUsd["ETH/USD"], 6);
  for (const t of [target, reversed]) assert.ok(Object.values(t.targetUsd).reduce((sum, usd) => sum + Math.abs(usd), 0) <= 12 + 1e-12);
});

test("flat prices use the volatility floor; baselines share features and use their fixed target definitions", () => {
  const input = bars(361, () => 100), trend = only(input);
  for (const signal of trend.signals) {
    assert.equal(signal.dailyVolatility, .0001); assert.equal(signal.score, 0); assert.equal(signal.relativeRiskWeight, .5);
  }
  assert.deepEqual(trend.targetUsd, { "BTC/USD": 0, "ETH/USD": 0 });
  assert.deepEqual(only(input, FIRST, "sign-trend-90d").targetUsd, trend.targetUsd);
  assert.deepEqual(only(input, FIRST, "constant-btc").targetUsd, { "BTC/USD": 12, "ETH/USD": 0 });
  assert.deepEqual(only(input, FIRST, "constant-eth").targetUsd, { "BTC/USD": 0, "ETH/USD": 12 });
  assert.deepEqual(only(bars(361), FIRST, "flat").targetUsd, { "BTC/USD": 0, "ETH/USD": 0 });
  for (const policy of ["sign-trend-90d", "constant-btc", "constant-eth", "flat"] as const)
    assert.equal(only(input, FIRST, policy).inputSha256, trend.inputSha256);
});

test("sign-90d baseline uses current-to-90d direction and the same relative volatility allocation", () => {
  const input = bars(361, (day, asset) => 100 * Math.exp(day * (asset === 0 ? .001 : -.002)));
  const target = only(input, FIRST, "sign-trend-90d");
  near(target.targetUsd["BTC/USD"], 8); near(target.targetUsd["ETH/USD"], -4);
  assert.deepEqual(target.signals.map(s => s.score), [1, -1]);
});

test("one missing own or peer hour resets paired support for the complete 361-day lookback", () => {
  for (const symbol of PORTFOLIO_SYMBOLS) {
    const missingDay = 365, resumedAt = START + (missingDay + 1 + 361) * DAY;
    const input = bars(728).filter(b => !(b.symbol === symbol && b.openMs === START + missingDay * DAY + 7 * HOUR));
    const targets = buildPortfolioTargets(input, FIRST, START + 729 * DAY);
    assert.deepEqual(targets.filter(t => t.decisionMs < resumedAt).map(t => t.decisionMs),
      [361, 362, 363, 364, 365].map(day => START + day * DAY));
    assert.equal(targets.find(t => t.decisionMs >= resumedAt)?.decisionMs, resumedAt);
  }
});

test("future bars, old prices, and input ordering cannot alter an earlier target or its causal hash", () => {
  const input = bars(365), at = START + 364 * DAY, before = only(input, at);
  const changed = input.map(bar => bar.openMs >= at || bar.openMs < START + 3 * DAY
    ? { ...bar, open: 777, high: 777, low: 777, close: 777, volume: 999 } : { ...bar });
  assert.deepEqual(only(changed.reverse(), at), before);
  assert.deepEqual(only(input.filter(b => b.openMs + HOUR <= at), at), before);
  const changedRelevant = input.map(bar => bar.symbol === "BTC/USD" && bar.openMs === at - HOUR
    ? { ...bar, open: 110, high: 110, low: 110, close: 110 } : bar);
  assert.notEqual(only(changedRelevant, at).inputSha256, before.inputSha256);
});

test("inputs are not mutated, returned targets are independent, and scores are explicitly not expected returns", () => {
  const input = bars(362), originalFirst = structuredClone(input[0]);
  const targets = buildPortfolioTargets(input, FIRST, FIRST + 2 * DAY);
  assert.deepEqual(input[0], originalFirst);
  targets[0]!.targetUsd["BTC/USD"] = 999; targets[0]!.signals[0]!.trendScores[0] = 999;
  assert.ok(targets[1]!.targetUsd["BTC/USD"] <= 12);
  assert.ok(targets[1]!.signals[0]!.trendScores.every(value => Math.abs(value) <= 1));
  assert.match(PORTFOLIO_SPEC.targetInterpretation, /NOT_EXPECTED_RETURN/);
  assert.equal("meanNetBps" in targets[1]!, false); assert.equal("probability" in targets[1]!, false);
});

test("invalid bars, duplicates, unsupported policies and non-UTC-day bounds fail closed", () => {
  const original = bars(1)[0]!;
  for (const patch of [{ close: NaN }, { volume: -1 }, { openMs: START + 1 }, { low: original.close + 1 },
    { symbol: "SOL/USD" }, { open: 0 }, { openMs: Number.MAX_SAFE_INTEGER }, { high: Infinity }]) {
    assert.throws(() => buildPortfolioTargets([{ ...original, ...patch } as HourlyBar], FIRST, FIRST + DAY), /INVALID_BAR/);
  }
  assert.throws(() => buildPortfolioTargets([original, { ...original }], FIRST, FIRST + DAY), /DUPLICATE_BAR/);
  for (const [start, end] of [[FIRST + HOUR, FIRST + DAY], [FIRST, FIRST], [FIRST + DAY, FIRST], [NaN, FIRST], [-DAY, FIRST]])
    assert.throws(() => buildPortfolioTargets([], start!, end!), /INVALID_WINDOW/);
  assert.throws(() => buildPortfolioTargets([], FIRST, FIRST + DAY, "unknown" as PortfolioPolicy), /INVALID_POLICY/);
  assert.throws(() => buildPortfolioTargets(null as unknown as HourlyBar[], FIRST, FIRST + DAY), /INVALID_INPUT/);
});
