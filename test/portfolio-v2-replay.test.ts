import assert from "node:assert/strict";
import test from "node:test";
import { simulatePortfolioReplay, type PortfolioReplayScenario } from "../src/portfolio-v2/replay.js";
import { simulatePortfolioReplay as simulateV1 } from "../src/portfolio/replay.js";
import { validateRiskGovernorState, RISK_SPEC } from "../src/portfolio-v2/risk.js";
import { PORTFOLIO_HOUR_MS as H, PORTFOLIO_VERSION, type HourlyBar, type Pair,
  type AssetRules, type PortfolioTarget } from "../src/portfolio/types.js";
import type { FundingRow } from "../src/research/hourly-data.js";

const T = Date.UTC(2023, 0, 1), symbols = ["BTC/USD", "ETH/USD"] as const;
const scenario: PortfolioReplayScenario = { id: "base-a", delayHours: 1, feeBps: 5, slippageBps: 0,
  fundingShiftMs: 0, extraFundingBpsPerDay: 0 };
const rules: Pair<AssetRules> = {
  "BTC/USD": { symbol: "BTC/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01, maximumOrderQty: 100, shortable: true },
  "ETH/USD": { symbol: "ETH/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01, maximumOrderQty: 100, shortable: true },
};
function target(hour = 0, btc = 12, eth = 0): PortfolioTarget {
  return { version: PORTFOLIO_VERSION, policy: "multiscale-trend", decisionMs: T + hour * H,
    availableAtMs: T + hour * H, validUntilMs: T + (hour + 48) * H,
    inputSha256: `synthetic:${hour}:${btc}:${eth}`, signals: [], targetUsd: { "BTC/USD": btc, "ETH/USD": eth } };
}
function fixture(hours = 120, btc = 12, eth = 0) {
  const bars: HourlyBar[] = [], funding: FundingRow[] = [];
  for (let h = -1; h <= hours + 1; h++) for (const symbol of symbols) {
    bars.push({ symbol, openMs: T + h * H, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    funding.push({ symbol, timestampMs: T + h * H, rate: 0, absoluteRate: 0 });
  }
  return { bars, funding, targets: Array.from({ length: Math.ceil(hours / 24) }, (_, i) => target(i * 24, btc, eth)),
    rules: structuredClone(rules), scenario: { ...scenario }, startMs: T, endMs: T + hours * H };
}
const near = (actual: number | null, expected: number, tolerance = 1e-8) => {
  assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) <= tolerance, `${actual} != ${expected}`);
};
const bar = (f: ReturnType<typeof fixture>, hour: number, symbol = "BTC/USD") =>
  f.bars.find(b => b.symbol === symbol && b.openMs === T + hour * H)!;
function price(f: ReturnType<typeof fixture>, fromHour: number, value: number, toHour = (f.endMs - T) / H + 1) {
  for (let h = fromHour; h <= toHour; h++) Object.assign(bar(f, h), { open: value, high: value, low: value, close: value });
}
const pre = (r: ReturnType<typeof simulatePortfolioReplay>, hour: number) => r.riskTimeline.find(x => x.atMs === T + hour * H && x.phase === "PRE_TRADE")!;

test("zero-cost unchanged exposure preserves v1 accounting while adding complete causal risk receipts", () => {
  const f = fixture(); f.scenario.feeBps = 0;
  const r = simulatePortfolioReplay(f), old = simulateV1(f);
  assert.deepEqual(r.fills, old.fills); assert.deepEqual(r.equity, old.equity); assert.deepEqual(r.daily, old.daily);
  near(r.netPnlUsd, 0); assert.ok(r.allPathsKnown);
  assert.ok(r.riskTimeline.every(x => x.decision.maximumGrossNotionalUsd === 12));
  assert.equal(r.riskTimeline.filter(x => x.phase === "POST_FILL").length, r.fills.length);
  assert.equal(validateRiskGovernorState(JSON.parse(JSON.stringify(r.finalRiskState)), f.endMs), true);
});

test("first asset fee immediately shrinks risk and cancels the second increase reservation", () => {
  const f = fixture(120, 6, 6), original = structuredClone(f.targets), r = simulatePortfolioReplay(f);
  const p = r.plans.find(p => p.atMs === T + H)!;
  assert.equal(p.orders.length, 2); assert.equal(p.orders[0]!.symbol, "BTC/USD");
  const atFirstHour = r.fills.filter(x => x.atMs === T + H);
  assert.equal(atFirstHour.length, 1); assert.equal(atFirstHour[0]!.symbol, "BTC/USD");
  assert.equal(r.riskCancelledOrders[0]!.orderId, p.orders[1]!.id);
  assert.equal(r.riskCancelledOrders[0]!.reason, "RISK_CAP_REDUCED_AFTER_FILL");
  const post = r.riskTimeline.find(x => x.atMs === T + H && x.phase === "POST_FILL")!;
  assert.ok(post.decision.dailyLossUsd! > 0); assert.ok(post.decision.maximumGrossNotionalUsd < 12);
  assert.equal(r.equity.find(x => x.atMs === T + H)!.reservedOrders, 0);
  assert.deepEqual(f.targets, original);
  const next = r.plans.find(p => p.atMs === T + 2 * H)!, nextRisk = pre(r, 2);
  near(next.desiredUsd["BTC/USD"], 6 * nextRisk.decision.exposureScale);
  near(next.desiredUsd["ETH/USD"], 6 * nextRisk.decision.exposureScale);
  near(next.maximumGrossNotionalUsd, nextRisk.decision.maximumGrossNotionalUsd);
});

test("a gap beyond drawdown budget remains reported and permanently halts new positions", () => {
  const f = fixture(168); price(f, 10, 30); price(f, 11, 150);
  const r = simulatePortfolioReplay(f), breach = pre(r, 10);
  assert.ok(breach.decision.drawdownUsd! > RISK_SPEC.drawdownBudgetUsd); assert.equal(breach.decision.drawdownHalted, true);
  assert.equal(breach.decision.forceFlat, true); assert.equal(breach.decision.maximumGrossNotionalUsd, 0);
  assert.equal(r.plans.find(p => p.atMs === T + 10 * H)!.status, "REDUCE");
  assert.ok(r.maximumDrawdownUsd! > 3); assert.ok(r.maximumLiquidationDrawdownUsd! > 3);
  assert.equal(r.finalRiskState.drawdownHalted, true); assert.equal(r.finalState.positions["BTC/USD"].qty, 0);
  assert.equal(r.fills.filter(f => f.signedQty > 0).length, 1); assert.ok(r.allPathsKnown);
});

test("unfilled risk exits retain inventory and funding, including overshoot until actual recovery", () => {
  const f = fixture(168); price(f, 10, 30); price(f, 15, 110);
  for (let h = 10; h < 15; h++) bar(f, h).volume = 0;
  const r = simulatePortfolioReplay(f);
  assert.ok(r.maximumLiquidationDrawdownUsd! > 3); assert.ok(r.zeroVolumeNoFills >= 5);
  for (let h = 10; h < 15; h++) {
    const e = r.equity.find(e => e.atMs === T + h * H)!;
    assert.ok(e.quantities["BTC/USD"] > 0); assert.equal(e.reservedOrders, 1);
    assert.equal(pre(r, h).decision.maximumGrossNotionalUsd, 0);
  }
  assert.ok(r.fundingReceipts.some(f => f.atMs === T + 15 * H));
  assert.equal(r.fills.find(f => f.signedQty < 0 && f.atMs >= T + 10 * H)!.atMs, T + 15 * H);
  assert.equal(r.finalRiskState.drawdownHalted, true); assert.equal(r.finalState.pending.length, 0);
});

test("unknown funding permanently halts and flattens without fabricating a zero cash settlement", () => {
  const f = fixture(); f.funding = f.funding.filter(f => !(f.symbol === "BTC/USD" && f.timestampMs === T + 3 * H));
  const r = simulatePortfolioReplay(f), missingId = `funding:${scenario.id}:BTC/USD:${T + 3 * H}`;
  assert.equal(r.netPnlUsd, null); assert.equal(r.totalFundingCostUsd, null); assert.equal(r.allPathsKnown, false);
  assert.equal(pre(r, 3).decision.accountingHalted, true); assert.equal(pre(r, 3).liquidationEquityUsd, null);
  assert.equal(r.finalRiskState.accountingHalted, true);
  assert.ok(r.riskTimeline.filter(x => x.atMs >= T + 3 * H).every(x => x.decision.forceFlat));
  assert.ok(!r.finalState.fundingReceipts.some(f => f.id === missingId));
  assert.equal(r.fundingReceipts.find(f => f.id === missingId)!.actualCostUsd, null);
  assert.equal(r.finalState.positions["BTC/USD"].qty, 0);
  assert.ok(!r.fills.some(f => f.atMs >= T + 3 * H && f.signedQty > 0));
});

test("a known stress cost remains explicit when actual funding is unknown", () => {
  const f = fixture(); f.scenario.extraFundingBpsPerDay = 1;
  f.funding = f.funding.filter(f => !(f.symbol === "BTC/USD" && f.timestampMs === T + 3 * H));
  const r = simulatePortfolioReplay(f), missingId = `funding:${scenario.id}:BTC/USD:${T + 3 * H}`;
  const receipt = r.fundingReceipts.find(f => f.id === missingId)!;
  assert.equal(receipt.actualCostUsd, null); assert.ok(receipt.extraCostUsd > 0);
  near(r.finalState.fundingReceipts.find(f => f.id === `${missingId}:known-extra-only`)!.costUsd, receipt.extraCostUsd);
  assert.equal(r.netPnlUsd, null); assert.equal(r.finalRiskState.accountingHalted, true);
});

test("midnight accounts for prior-day funding before resetting and charges new fill risk afterward", () => {
  const f = fixture(144, 6); f.targets = [target(0, 6), target(23, 12), target(48, 12), target(72, 12), target(96, 12), target(120, 12)];
  f.funding.find(f => f.symbol === "BTC/USD" && f.timestampMs === T + 24 * H)!.absoluteRate = .4 / .06;
  const r = simulatePortfolioReplay(f), boundary = pre(r, 24);
  assert.ok(boundary.decision.previousDayLossUsd! > .4); near(boundary.decision.dailyLossUsd, 0);
  const fill = r.fills.find(f => f.atMs === T + 24 * H && f.signedQty > 0); assert.ok(fill);
  const post = r.riskTimeline.find(x => x.atMs === T + 24 * H && x.phase === "POST_FILL")!;
  assert.ok(post.decision.dailyLossUsd! > 0);
  assert.ok(r.daily[0]!.netPnlUsd! < -.4); assert.ok(r.daily[1]!.netPnlUsd! < 0);
  near(r.daily.reduce((n, d) => n + d.netPnlUsd!, 0), r.netPnlUsd!);
});

test("funding-driven cap reduction forces a reduction despite the ordinary same-side band", () => {
  const f = fixture();
  // Cost0.06 would change a12USD target by only5 percent, below the25 percent band.
  f.funding.find(f => f.symbol === "BTC/USD" && f.timestampMs === T + 2 * H)!.absoluteRate = .06 / .12;
  const r = simulatePortfolioReplay(f), plan = r.plans.find(p => p.atMs === T + 2 * H)!;
  assert.ok(pre(r, 2).decision.maximumGrossNotionalUsd < 12);
  assert.equal(plan.status, "REDUCE"); assert.ok(plan.orders.every(o => o.reduceOnly));
});

test("zero-volume entries have no fill cost or POST_FILL risk observation before their receipt", () => {
  const f = fixture(); bar(f, 1).volume = 0;
  const r = simulatePortfolioReplay(f);
  assert.ok(!r.riskTimeline.some(x => x.atMs === T + H && x.phase === "POST_FILL"));
  const after = r.riskTimeline.find(x => x.atMs === T + H && x.phase === "POST_TRADE")!;
  assert.equal(after.decision.maximumGrossNotionalUsd, 12);
  assert.equal(r.equity.find(e => e.atMs === T + H)!.reservedOrders, 1);
  assert.equal(r.attempts[0]!.knownAtMs, T + 2 * H);
});

test("future prices, rates and targets cannot change earlier governor observations or orders", () => {
  const f = fixture(), a = simulatePortfolioReplay(f), future = structuredClone(f), cutoff = T + 36 * H;
  price(future, 36, 20);
  for (const r of future.funding) if (r.timestampMs > cutoff) r.absoluteRate = 100;
  for (const t of future.targets) if (t.decisionMs >= cutoff) t.targetUsd["BTC/USD"] = -12;
  const b = simulatePortfolioReplay(future);
  assert.deepEqual(a.plans.filter(x => x.atMs < cutoff), b.plans.filter(x => x.atMs < cutoff));
  assert.deepEqual(a.fills.filter(x => x.atMs < cutoff), b.fills.filter(x => x.atMs < cutoff));
  assert.deepEqual(a.riskTimeline.filter(x => x.atMs < cutoff), b.riskTimeline.filter(x => x.atMs < cutoff));
});

test("missing exit quotes remain unknown and later executable quotes flatten without clearing the risk halt", () => {
  const f = fixture(); f.bars = f.bars.filter(b => !(b.symbol === "BTC/USD" && b.openMs === T + 4 * H));
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, null); assert.equal(r.finalRiskState.accountingHalted, true);
  assert.ok(r.unknowns.some(u => u.reason === "MISSING_EXECUTION_BAR_WHILE_HELD"));
  assert.equal(r.finalState.positions["BTC/USD"].qty, 0);
  assert.equal(r.fills.find(f => f.signedQty < 0 && f.atMs >= T + 4 * H)!.atMs, T + 5 * H);
});

test("flat needs no funding observations and does not invent an accounting halt", () => {
  const f = fixture(96, 0); f.funding = [];
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, 0); assert.equal(r.fills.length, 0); assert.equal(r.finalRiskState.accountingHalted, false);
  assert.equal(r.finalRiskState.drawdownHalted, false); assert.equal(r.finalRiskState.observations.length, 194);
});

test("signed funding, fees and slippage independently reconcile both sides and timestamp scenarios", () => {
  for (const side of [1, -1]) for (const shift of [0, -3_600_000] as const) {
    const f = fixture(120, side * 12); f.scenario.fundingShiftMs = shift; f.scenario.slippageBps = 3;
    f.scenario.extraFundingBpsPerDay = 1;
    for (const row of f.funding) row.absoluteRate = .002 + (row.timestampMs - T) / H * .000001;
    const r = simulatePortfolioReplay(f); assert.ok(r.allPathsKnown);
    const signedCash = -r.fills.reduce((n, f) => n + f.signedQty * f.price + f.feeUsd, 0)
      - r.fundingReceipts.reduce((n, f) => n + f.knownCostUsd, 0);
    near(r.netPnlUsd, signedCash); near(r.perAsset["BTC/USD"].netPnlUsd, signedCash);
    near(r.daily.reduce((n, d) => n + d.netPnlUsd!, 0), signedCash);
    for (const receipt of r.fundingReceipts) {
      const original = f.funding.find(f => f.symbol === receipt.symbol && f.timestampMs === receipt.atMs - shift)!;
      near(receipt.actualCostUsd, receipt.signedQty * original.absoluteRate!);
      near(receipt.extraCostUsd, Math.abs(receipt.signedQty) * receipt.mark / 24 / 10000);
      assert.equal(receipt.sourceTimestampMs, original.timestampMs);
    }
    near(r.totalFeesUsd, r.fills.reduce((n, f) => n + f.feeUsd, 0));
    near(r.totalFundingCostUsd, r.fundingReceipts.reduce((n, f) => n + f.actualCostUsd! + f.extraCostUsd, 0));
  }
});

test("terminal unresolved inventory marks final governor accounting unknown without a next-period price", () => {
  const f = fixture(96); for (let h = 48; h < 96; h++) bar(f, h).volume = 0;
  Object.assign(bar(f, 96), { open: 9000, high: 9000, low: 9000, close: 9000 });
  const r = simulatePortfolioReplay(f);
  assert.equal(r.netPnlUsd, null); assert.ok(r.finalState.positions["BTC/USD"].qty > 0);
  assert.equal(r.equity.at(-1)!.marks["BTC/USD"], 100); assert.equal(r.finalRiskState.accountingHalted, true);
  assert.equal(r.riskTimeline.at(-1)!.phase, "FINAL_STATUS"); assert.equal(r.riskTimeline.at(-1)!.liquidationEquityUsd, null);
  assert.ok(r.unknowns.some(u => u.reason === "TERMINAL_OPEN_INVENTORY"));
});

test("stress preserves raw target receipts and uses the declared later first execution", () => {
  const f = fixture(), base = simulatePortfolioReplay(f);
  const stress = simulatePortfolioReplay({ ...f, scenario: { ...f.scenario, id: "stress", delayHours: 2, feeBps: 7.5, slippageBps: 3 } });
  assert.equal(base.fills[0]!.atMs, T + H); assert.equal(stress.fills[0]!.atMs, T + 2 * H);
  assert.deepEqual(base.inputReceipts.targets, stress.inputReceipts.targets);
  assert.ok(stress.riskTimeline.filter(r => r.phase === "POST_FILL").every(r => r.decision.maximumGrossNotionalUsd <= 12));
});
