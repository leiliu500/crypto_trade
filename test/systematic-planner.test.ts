import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { BookState, Features } from "../src/core/market.js";
import type { SystematicSignal } from "../src/systematic/spec.js";
import { SYSTEMATIC_SPEC as S } from "../src/systematic/spec.js";
import { buildSystematicPlan } from "../src/systematic/planner.js";

function fixture(side: 1 | -1 = 1) {
  const nowMs = 1_800_000_000_000, symbol = "BTC/USD";
  const book: BookState = { symbol, receiveTsMs: nowMs, exchangeTsMs: nowMs, sequence: 1n, valid: true,
    sourceReset: false, bids: [{ px: 80_000, qty: .0001 }, { px: 79_999, qty: 10 }],
    asks: [{ px: 80_001, qty: .0001 }, { px: 80_002, qty: 10 }, { px: 80_100, qty: 100 }] };
  const signal: SystematicSignal = { version: S.version, id: "signal", symbol, barCloseMs: nowMs - 3_600_000,
    availableAtMs: nowMs - 3_000_000, side, reason: "TREND_SIGNAL", close: 80_000,
    emaFast: 80_000, emaSlow: 79_000, atr: 800, atrBps: 100, trendStrength: side,
    stopBps: 200, targetBps: 400, bars: 192, inputSha256: "hash" };
  return { config: loadConfig({ TRADING_MODE: "paper" }).symbolConfigs[symbol]!, book,
    features: { symbol, mid: 80_000.5, sigmaHBps: 1, receiveTsMs: nowMs, stale: false } as Features,
    asset: { symbol, minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: 1,
      maximumOrderQty: 1000, shortable: true }, signal, equity: 100_000, equityHighWater: 100_000, nowMs };
}

test("side-specific executable depth fixes top-level lot starvation without expanding participation or collar", () => {
  for (const side of [1, -1] as const) {
    const x = fixture(side), result = buildSystematicPlan(x), p = result.plan!;
    assert.ok(p, result.decision.reason);
    assert.equal(result.decision.availableDepthQty, 10.0001);
    assert.ok(p.qty > .0001);
    assert.ok(p.qty <= result.decision.availableDepthQty * .01);
    assert.ok(p.qty * Math.max(x.book.asks[0]!.px, p.limitPx) <= 1000);
    assert.ok(side * (p.limitPx - (side === 1 ? 80_001 : 80_000)) <= 80_001 * .0003);
    assert.ok(p.risk.modeledMaximumLoss <= p.risk.riskBudget);
    assert.equal(p.expectedValue, 0);
    assert.equal(p.conservativeNetEdgeBps, undefined);
    assert.equal(p.edgeSource, "UNRESOLVED");
    assert.equal(result.decision.paperReady, false, "executable size must not imply economic approval");
  }
});

test("depth on the wrong side or beyond the collar never supplies entry liquidity", () => {
  const x = fixture(); x.book.asks = [{ px: 80_001, qty: .0001 }, { px: 80_100, qty: 10_000 }];
  const result = buildSystematicPlan(x);
  assert.equal(result.plan, null);
  assert.equal(result.decision.reason, "EXECUTABLE_DEPTH_BELOW_MINIMUM_ORDER");
});

test("a single executable bid level can fill a short within its lower price collar", () => {
  const x = fixture(-1); x.book.bids = [{ px: 80_000, qty: 10 }];
  const result = buildSystematicPlan(x);
  assert.ok(result.plan, result.decision.reason);
  assert.equal(result.plan.expectedCost.entryVwap, 80_000);
  assert.ok(result.plan.limitPx < 80_000);
});

test("cost feasibility is separate from direction and rejects quiet uneconomic geometry", () => {
  const x = fixture(); x.signal.atrBps = 10; x.signal.stopBps = 20; x.signal.targetBps = 40;
  const result = buildSystematicPlan(x);
  assert.equal(result.plan, null);
  assert.equal(result.decision.reason, "COST_TOO_LARGE_FOR_STOP");
  assert.ok(result.decision.estimatedCostBps! >= 25);
});

test("stale inputs, unsafe risk and venue restrictions cannot force a minimum-lot trade", () => {
  for (const mutate of [
    (x: ReturnType<typeof fixture>) => { x.nowMs += S.maximumQuoteAgeMs + 1; },
    (x: ReturnType<typeof fixture>) => { x.signal.barCloseMs -= S.maximumSignalAgeMs; },
    (x: ReturnType<typeof fixture>) => { x.signal.availableAtMs = x.nowMs + 1; },
    (x: ReturnType<typeof fixture>) => { x.signal.barCloseMs = NaN; },
    (x: ReturnType<typeof fixture>) => { x.signal.side = 2 as 1; },
    (x: ReturnType<typeof fixture>) => { x.equity = 1; },
    (x: ReturnType<typeof fixture>) => { x.equity = 94_000; },
    (x: ReturnType<typeof fixture>) => { x.book.valid = false; },
    (x: ReturnType<typeof fixture>) => { x.book.exchangeTsMs -= S.maximumQuoteAgeMs + 1; },
    (x: ReturnType<typeof fixture>) => { x.book.asks = [...x.book.asks].reverse(); },
    (x: ReturnType<typeof fixture>) => { x.signal.side = -1; x.asset.shortable = false; },
    (x: ReturnType<typeof fixture>) => { x.features.mid = NaN; },
    (x: ReturnType<typeof fixture>) => { x.signal.side = null; },
  ]) {
    const x = fixture(); mutate(x); assert.equal(buildSystematicPlan(x).plan, null);
  }
});

test("higher volatility and lower equity shrink quantity without increasing the fixed cap", () => {
  const base = fixture(), p = buildSystematicPlan(base).plan!;
  const smaller = { ...base, equity: 5000, equityHighWater: 5000 };
  const q = buildSystematicPlan(smaller).plan!;
  assert.ok(q.qty < p.qty && q.qty * q.limitPx <= 50);
  const volatile = fixture(); volatile.signal.atrBps *= 3; volatile.signal.stopBps *= 3; volatile.signal.targetBps *= 3;
  assert.ok(buildSystematicPlan(volatile).plan!.qty < p.qty);
});
