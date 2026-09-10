import assert from "node:assert/strict";
import test from "node:test";
import { simulatePortfolioReplay, type PortfolioReplayScenario } from "../src/portfolio/replay.js";
import { PORTFOLIO_HOUR_MS as H, PORTFOLIO_VERSION, type HourlyBar, type Pair,
  type AssetRules, type PortfolioTarget } from "../src/portfolio/types.js";
import type { FundingRow } from "../src/research/hourly-data.js";
const T = Date.UTC(2023, 0, 1), symbols = ["BTC/USD", "ETH/USD"] as const;
const scenario: PortfolioReplayScenario = { id: "base-a", delayHours: 1, feeBps: 5, slippageBps: 1.5,
  fundingShiftMs: 0, extraFundingBpsPerDay: 0 };
const rules: Pair<AssetRules> = {
  "BTC/USD": { symbol: "BTC/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01,
    maximumOrderQty: 100, shortable: true },
  "ETH/USD": { symbol: "ETH/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01,
    maximumOrderQty: 100, shortable: true },
};
function target(hour = 0, btc = 12, eth = 0): PortfolioTarget {
  return { version: PORTFOLIO_VERSION, policy: "multiscale-trend", decisionMs: T + hour * H,
    availableAtMs: T + hour * H, validUntilMs: T + (hour + 48) * H,
    inputSha256: `synthetic:${hour}:${btc}:${eth}`, signals: [], targetUsd: { "BTC/USD": btc, "ETH/USD": eth } };
}
function fixture(hours = 96, btc = 12, eth = 0) {
  const bars: HourlyBar[] = [], funding: FundingRow[] = [];
  for (let h = -1; h <= hours + 1; h++) for (const symbol of symbols) {
    bars.push({ symbol, openMs: T + h * H, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    funding.push({ symbol, timestampMs: T + h * H, rate: 0, absoluteRate: 0 });
  }
  const targets = Array.from({ length: Math.ceil(hours / 24) }, (_, i) => target(i * 24, btc, eth));
  return { bars, funding, targets, rules: structuredClone(rules), scenario: { ...scenario }, startMs: T, endMs: T + hours * H };
}
const near = (actual: number | null, expected: number, tolerance = 1e-8) => {
  assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} != ${expected}`);
};
const bar = (f: ReturnType<typeof fixture>, hour: number, symbol = "BTC/USD") =>
  f.bars.find(b => b.symbol === symbol && b.openMs === T + hour * H)!;

test("flat is genuinely zero with a full idle calendar and no unnecessary funding requirements", () => {
  const f = fixture(96, 0); f.funding = [];
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, 0); assert.equal(r.maximumDrawdownUsd, 0); assert.equal(r.fills.length, 0);
  assert.equal(r.equity.length, 97); assert.equal(r.daily.length, 4);
  assert.ok(r.daily.every(d => d.netPnlUsd === 0)); assert.deepEqual(r.unknowns, []);
});

test("constant target persists without clock expiry and reconciles one entry plus terminal liquidation", () => {
  const f = fixture(), r = simulatePortfolioReplay(f);
  assert.equal(r.fills.length, 2); assert.equal(r.fills[0]!.atMs, T + H);
  assert.equal(r.fills[1]!.atMs, T + 48 * H);
  assert.ok(r.attempts.filter(a => a.status === "FILLED").every(a => a.knownAtMs === a.atMs));
  assert.equal(r.fills[0]!.signedQty, -r.fills[1]!.signedQty);
  assert.equal(r.finalState.positions["BTC/USD"].qty, 0); assert.ok(r.allPathsKnown);
  const qty = r.fills[0]!.signedQty;
  near(r.totalFeesUsd, qty * (100.02 + 99.98) * .0005);
  near(r.totalSlippageUsd, qty * .04);
  near(r.netPnlUsd, -r.totalFeesUsd - r.totalSlippageUsd);
  near(r.daily.reduce((sum, d) => sum + d.netPnlUsd!, 0), r.netPnlUsd!);
  near(r.perAsset["BTC/USD"].netPnlUsd, r.netPnlUsd!);
  assert.ok(r.maximumGrossExposureUsd <= 12);
});

test("same-side increase trades only the delta and reversal waits for a confirmed reduction phase", () => {
  const f = fixture(120, 6); f.targets = [target(0, 6), target(24, 9), target(48, -9), target(72, -9)];
  const r = simulatePortfolioReplay(f);
  const first = r.fills[0]!, increase = r.fills.find(x => x.atMs === T + 25 * H)!;
  assert.ok(increase.signedQty > 0 && increase.signedQty < first.signedQty);
  assert.ok(increase.feeUsd < (2 * first.signedQty + increase.signedQty) * 100 * .0005);
  const reduce = r.fills.find(x => x.atMs === T + 49 * H)!;
  const reverse = r.fills.find(x => x.atMs === T + 50 * H)!;
  assert.equal(reduce.signedQty, -(first.signedQty + increase.signedQty));
  assert.ok(reverse.signedQty < 0); assert.equal(r.plans.find(p => p.atMs === reduce.atMs)!.status, "REDUCE");
  near(r.perAsset["BTC/USD"].netPnlUsd, r.netPnlUsd!);
});

test("signed absolute funding settles old inventory before boundary fills; stress is charged once", () => {
  for (const side of [1, -1]) {
    const f = fixture(96, side * 12); f.scenario.extraFundingBpsPerDay = 1;
    for (const rate of f.funding) { rate.rate = 123; rate.absoluteRate = .1; }
    const r = simulatePortfolioReplay(f), qty = r.fills[0]!.signedQty;
    assert.equal(r.fundingReceipts.length, 47);
    assert.equal(r.fundingReceipts[0]!.atMs, T + 2 * H);
    assert.equal(r.fundingReceipts.at(-1)!.atMs, T + 48 * H);
    const actual = qty * .1 * 47, extra = Math.abs(qty) * 100 / 24 / 10000 * 47;
    near(r.totalFundingCostUsd, actual + extra);
    near(r.netPnlUsd, -r.totalFeesUsd - r.totalSlippageUsd - actual - extra);
    near(r.perAsset["BTC/USD"].actualFundingCostUsd, actual);
    near(r.cashFundingDebitUsd - r.cashFundingCreditUsd, actual);
  }
});

test("funding shifts change only accounting and retain required boundary rows", () => {
  const f = fixture(); for (const rate of f.funding) rate.absoluteRate = (rate.timestampMs - T) / H / 1000;
  const a = simulatePortfolioReplay(f), b = simulatePortfolioReplay({ ...f, scenario: { ...scenario, id: "base-b", fundingShiftMs: -3600000 } });
  assert.deepEqual(a.fills, b.fills); assert.equal(b.unknowns.length, 0);
  const qty = a.fills[0]!.signedQty;
  near(b.totalFundingCostUsd! - a.totalFundingCostUsd!, qty * .001 * 47);
});

test("missing required funding and exposed bars remain unknown after recovery", () => {
  const f = fixture(); f.funding = f.funding.filter(r => !(r.symbol === "BTC/USD" && r.timestampMs === T + 10 * H));
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, null); assert.equal(r.maximumDrawdownUsd, null);
  assert.equal(r.perAsset["BTC/USD"].netPnlUsd, null); assert.equal(r.perAsset["ETH/USD"].netPnlUsd, 0);
  assert.ok(r.unknowns.some(u => u.reason === "MISSING_FUNDING_RATE"));
  const missingRate = r.fundingReceipts.find(x => x.atMs === T + 10 * H)!;
  assert.equal(missingRate.actualCostUsd, null); assert.equal(missingRate.absoluteRate, null);
  assert.equal(missingRate.knownCostUsd, 0); assert.equal(r.totalFundingCostUsd, null);
  assert.equal(r.fills.length, 2); assert.equal(r.finalState.positions["BTC/USD"].qty, 0);
  const g = fixture(); g.bars = g.bars.filter(b => !(b.symbol === "BTC/USD" && b.openMs === T + 10 * H));
  const missing = simulatePortfolioReplay(g); assert.equal(missing.netPnlUsd, null);
  assert.ok(missing.unknowns.some(u => u.reason === "MISSING_HELD_INTERVAL_BAR"));
});

test("zero-volume entry plans are unchanged and reservation resolves only at candle close", () => {
  const f = fixture(); bar(f, 1).volume = 0;
  const r = simulatePortfolioReplay(f), control = simulatePortfolioReplay(fixture());
  assert.deepEqual(r.plans.find(p => p.atMs === T + H), control.plans.find(p => p.atMs === T + H));
  assert.equal(r.attempts[0]!.knownAtMs, T + 2 * H);
  assert.equal(r.equity.find(e => e.atMs === T + H)!.reservedOrders, 1);
  assert.equal(r.fills[0]!.atMs, T + 2 * H); assert.equal(r.zeroVolumeNoFills, 1);
});

test("zero-volume risk exits retry hourly and keep inventory, funding and reservation", () => {
  const f = fixture(); for (let h = 48; h < 54; h++) bar(f, h).volume = 0;
  const r = simulatePortfolioReplay(f);
  assert.equal(r.fills.length, 2); assert.equal(r.fills[1]!.atMs, T + 54 * H);
  assert.equal(r.zeroVolumeNoFills, 6); assert.equal(r.fundingReceipts.length, 53);
  assert.equal(r.perAsset["BTC/USD"].staleMarkHours, 6);
  for (let h = 48; h < 54; h++) {
    const row = r.equity.find(e => e.atMs === T + h * H)!;
    assert.equal(row.reservedOrders, 1); assert.ok(row.quantities["BTC/USD"] > 0);
  }
  assert.equal(r.allPathsKnown, true);
});

test("terminal inventory stays unknown and terminal mark never reads the next period", () => {
  const f = fixture(); for (let h = 48; h < 96; h++) bar(f, h).volume = 0;
  Object.assign(bar(f, 95), { close: 105, high: 105 });
  Object.assign(bar(f, 96), { open: 999, high: 999, low: 999, close: 999 });
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, null); assert.ok(r.unknowns.some(u => u.reason === "TERMINAL_OPEN_INVENTORY"));
  assert.equal(r.equity.at(-1)!.marks["BTC/USD"], 105);
  assert.equal(r.finalState.pending.length, 0);
});

test("future price and target mutations cannot change earlier plans or fills", () => {
  const f = fixture(120, 6, 6), control = simulatePortfolioReplay(f), later = structuredClone(f);
  for (const b of later.bars) if (b.openMs >= T + 40 * H) Object.assign(b, { open: 150, high: 150, low: 150, close: 150, volume: 0 });
  later.targets = later.targets.map(t => t.decisionMs >= T + 48 * H ? { ...t, targetUsd: { "BTC/USD": -12, "ETH/USD": 0 } } : t);
  const changed = simulatePortfolioReplay(later), earlier = (x: { atMs: number }) => x.atMs < T + 40 * H;
  assert.deepEqual(changed.fills.filter(earlier), control.fills.filter(earlier));
  assert.deepEqual(changed.plans.filter(earlier), control.plans.filter(earlier));
});

test("hourly mark-to-market and daily price gains reconcile independently of cash realization", () => {
  const f = fixture(96, 6);
  for (const b of f.bars) if (b.symbol === "BTC/USD" && b.openMs >= T + 2 * H)
    Object.assign(b, { open: 110, high: 110, low: 110, close: 110 });
  const r = simulatePortfolioReplay(f), entry = r.fills[0]!, exit = r.fills.at(-1)!;
  assert.equal(r.fills.length, 2);
  near(r.equity.find(e => e.atMs === T + 2 * H)!.equityUsd,
    100_000 + entry.signedQty * (110 - entry.price) - entry.feeUsd);
  const expectedNet = entry.signedQty * (exit.price - entry.price) - entry.feeUsd - exit.feeUsd;
  near(r.netPnlUsd, expectedNet);
  near(r.daily.reduce((sum, d) => sum + d.netPnlUsd!, 0), expectedNet);
  const entryLoss = entry.signedQty * (entry.price - 100) + entry.feeUsd;
  const exitLoss = entry.signedQty * (110 - exit.price) + exit.feeUsd;
  near(r.maximumDrawdownUsd, Math.max(entryLoss, exitLoss));
});

test("execution stress adds delay without changing target eligibility and allocations share one cap", () => {
  const f = fixture(96, 6, 6);
  f.scenario = { ...scenario, id: "stress-a", delayHours: 2, feeBps: 7.5, slippageBps: 3, extraFundingBpsPerDay: 1 };
  const r = simulatePortfolioReplay(f);
  assert.ok(r.fills.filter(x => x.signedQty > 0).every(x => x.atMs === T + 2 * H));
  assert.equal(new Set(r.fills.map(f => f.symbol)).size, 2);
  assert.ok(r.equity.every(e => e.grossExposureUsd <= 12));
  near(r.perAsset["BTC/USD"].netPnlUsd! + r.perAsset["ETH/USD"].netPnlUsd!, r.netPnlUsd!);
});

test("exposure reports retain pre-adjustment appreciation above the cap even when risk is reduced", () => {
  const f = fixture();
  for (const b of f.bars) if (b.symbol === "BTC/USD" && b.openMs >= T + 2 * H)
    Object.assign(b, { open: 120, high: 120, low: 120, close: 120 });
  const r = simulatePortfolioReplay(f), point = r.equity.find(e => e.atMs === T + 2 * H)!;
  assert.ok(point.preTradeGrossExposureUsd > 12); assert.ok(point.grossExposureUsd <= 12);
  near(r.maximumGrossExposureUsd, point.preTradeGrossExposureUsd);
});
