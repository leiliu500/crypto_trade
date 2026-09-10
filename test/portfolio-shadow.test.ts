import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PortfolioShadowController, PORTFOLIO_SHADOW_SPEC, type PortfolioShadowCheckpoint } from "../src/portfolio/shadow.js";
import { applyPortfolioFill, newPortfolioState, planPortfolioAdjustment, reservePortfolioOrders } from "../src/portfolio/kernel.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_VERSION,
  type AssetRules, type Pair, type PortfolioQuote, type PortfolioTarget } from "../src/portfolio/types.js";

const START = Date.UTC(2026, 8, 1), ACTIVE = START + HOUR;
const rules: Pair<AssetRules> = { "BTC/USD": { symbol: "BTC/USD", minOrderSize: .01, minTradeIncrement: .01,
  priceIncrement: .01, maximumOrderQty: 100, shortable: true }, "ETH/USD": { symbol: "ETH/USD", minOrderSize: .01,
  minTradeIncrement: .01, priceIncrement: .01, maximumOrderQty: 100, shortable: true } };
const make = () => new PortfolioShadowController({ rules });
const quotes = (atMs: number, bid = 99.99, ask = 100, depth = 10): Pair<PortfolioQuote> => ({
  "BTC/USD": { symbol: "BTC/USD", atMs, bid, ask, bidQty: depth, askQty: depth },
  "ETH/USD": { symbol: "ETH/USD", atMs, bid, ask, bidQty: depth, askQty: depth } });
function target(day = START, btc = 12, eth = 0): PortfolioTarget {
  return { version: PORTFOLIO_VERSION, policy: btc === 0 && eth === 0 ? "flat" : "multiscale-trend",
    decisionMs: day, availableAtMs: day, validUntilMs: day + 2 * DAY, inputSha256: "a".repeat(64),
    targetUsd: { "BTC/USD": btc, "ETH/USD": eth }, signals: ["BTC/USD", "ETH/USD"].map(symbol => ({
      symbol: symbol as "BTC/USD" | "ETH/USD", close: 100, dailyVolatility: .01, trendScores: [1, 1, 1],
      score: symbol === "BTC/USD" ? Math.sign(btc) : Math.sign(eth), relativeRiskWeight: .5 })) };
}
function enter(controller = make()): PortfolioShadowController {
  controller.setTarget(target(), START); controller.onQuotes(quotes(ACTIVE), ACTIVE);
  controller.onQuotes(quotes(ACTIVE + 250), ACTIVE + 250);
  assert.ok(controller.snapshot().actual["BTC/USD"].qty > 0); return controller;
}
function seal(checkpoint: PortfolioShadowCheckpoint): PortfolioShadowCheckpoint {
  const { contentSha256: _, ...body } = checkpoint;
  return { ...body, contentSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

test("target activation waits exactly one hour and virtual fills need a later quote after 250ms", () => {
  const c = make(); c.setTarget(target(), START);
  assert.deepEqual(c.onQuotes(quotes(ACTIVE - 1), ACTIVE - 1), []);
  assert.equal(c.onQuotes(quotes(ACTIVE), ACTIVE)[0]?.type, "PLAN");
  assert.equal(c.snapshot().pending.length, 1); assert.equal(c.snapshot().counters.fills, 0);
  c.onQuotes(quotes(ACTIVE + 249), ACTIVE + 249); assert.equal(c.snapshot().counters.fills, 0);
  const fills = c.onQuotes(quotes(ACTIVE + 250), ACTIVE + 250).filter(e => e.type === "VIRTUAL_FILL");
  assert.equal(fills.length, 1); assert.equal(c.snapshot().pending.length, 0);
  assert.equal(fills[0]!.fill!.price, 100); assert.equal(fills[0]!.fill!.feeUsd, .006);
  assert.equal(c.snapshot().realOrdersAllowed, false); assert.equal(c.snapshot().execution, "SHADOW_VIRTUAL_FILLS");
});

test("elapsed time and duplicate callbacks cannot create quote fills or repeated fees", () => {
  const c = make(); c.setTarget(target(), START); const original = quotes(ACTIVE);
  c.onQuotes(original, ACTIVE); c.onQuotes(original, ACTIVE + 250); c.onQuotes(original, ACTIVE + 1000);
  assert.equal(c.snapshot().counters.fills, 0);
  const fresh = quotes(ACTIVE + 1001); c.onQuotes(fresh, ACTIVE + 1001);
  const before = c.checkpoint().state;
  c.onQuotes(fresh, ACTIVE + 1002); assert.deepEqual(c.checkpoint().state, before);
  assert.equal(c.snapshot().totalFeesUsd, .006);
});

test("each order needs its own later quote, not merely an updated peer", () => {
  const c = make(); c.setTarget(target(), START); c.onQuotes(quotes(ACTIVE), ACTIVE);
  const mixed = quotes(ACTIVE + 250); mixed["BTC/USD"].atMs = ACTIVE;
  c.onQuotes(mixed, ACTIVE + 250); assert.equal(c.snapshot().counters.fills, 0);
  c.onQuotes(quotes(ACTIVE + 251), ACTIVE + 251); assert.equal(c.snapshot().counters.fills, 1);
});

test("virtual IOC partially fills available lot-rounded depth then cancels its remainder", () => {
  const c = make(); c.setTarget(target(), START); c.onQuotes(quotes(ACTIVE), ACTIVE);
  const events = c.onQuotes(quotes(ACTIVE + 250, 99.99, 100, .057), ACTIVE + 250);
  assert.deepEqual(events.map(e => e.type), ["VIRTUAL_FILL", "VIRTUAL_CANCEL"]);
  assert.equal(c.snapshot().actual["BTC/USD"].qty, .05); assert.equal(c.snapshot().totalFeesUsd, .0025);
  assert.equal(c.snapshot().pending.length, 0); assert.equal(c.snapshot().counters.plans, 1);
  c.onQuotes(quotes(ACTIVE + 1000), ACTIVE + 1000); assert.equal(c.snapshot().counters.plans, 1);
  c.onQuotes(quotes(ACTIVE + HOUR), ACTIVE + HOUR); assert.equal(c.snapshot().counters.plans, 2);
});

test("unchanged targets hold virtual inventory without repaying entry fees each hour", () => {
  const c = enter(), before = c.checkpoint().state;
  c.setTarget(target(), ACTIVE + HOUR); assert.equal(c.snapshot().counters.targets, 1);
  const events = c.onQuotes(quotes(ACTIVE + HOUR), ACTIVE + HOUR);
  assert.equal(events[0]?.plan?.status, "HOLD"); assert.equal(c.snapshot().pending.length, 0);
  assert.deepEqual(c.checkpoint().state, before); assert.equal(c.snapshot().totalTurnoverUsd, 12);
});

test("stale exit quotes cancel virtual orders without losing target or inventory, then retry next hour", () => {
  const c = enter(), flat = target(START + DAY, 0), exitAt = ACTIVE + DAY;
  c.setTarget(flat, START + DAY); assert.equal(c.onQuotes(quotes(exitAt), exitAt)[0]?.plan?.status, "REDUCE");
  c.onQuotes(quotes(exitAt), exitAt + 6000);
  assert.equal(c.snapshot().pending.length, 0); assert.equal(c.snapshot().actual["BTC/USD"].qty, .12);
  assert.deepEqual(c.snapshot().target, flat); assert.equal(c.snapshot().quoteReady, false);
  assert.equal(c.onQuotes(quotes(exitAt + HOUR), exitAt + HOUR)[0]?.plan?.status, "REDUCE");
  c.onQuotes(quotes(exitAt + HOUR + 250), exitAt + HOUR + 250);
  assert.equal(c.snapshot().actual["BTC/USD"].qty, 0); assert.equal(c.snapshot().counters.fills, 2);
});

test("zero-fill exits retain inventory and reductions finish before opposite-side increases", () => {
  const c = enter(), exitAt = ACTIVE + DAY;
  c.setTarget(target(START + DAY, -12), START + DAY);
  assert.equal(c.onQuotes(quotes(exitAt), exitAt)[0]?.plan?.status, "REDUCE");
  c.onQuotes(quotes(exitAt + 250, 99.98, 100), exitAt + 250);
  assert.equal(c.snapshot().actual["BTC/USD"].qty, .12); assert.equal(c.snapshot().pending.length, 0);
  c.onQuotes(quotes(exitAt + HOUR), exitAt + HOUR);
  c.onQuotes(quotes(exitAt + HOUR + 250), exitAt + HOUR + 250);
  assert.equal(c.snapshot().actual["BTC/USD"].qty, 0); assert.equal(c.snapshot().pending.length, 0);
  const increased = c.onQuotes(quotes(exitAt + 2 * HOUR), exitAt + 2 * HOUR);
  assert.equal(increased[0]?.plan?.status, "INCREASE"); assert.ok(increased[0]!.plan!.orders[0]!.signedQty < 0);
});

test("orders expire at five seconds before a delayed quote can claim a fill", () => {
  const c = make(); c.setTarget(target(), START); c.onQuotes(quotes(ACTIVE), ACTIVE);
  const events = c.onQuotes(quotes(ACTIVE + 5000), ACTIVE + 5000);
  assert.equal(events[0]?.reason, "VIRTUAL_IOC_EXPIRED"); assert.equal(c.snapshot().counters.fills, 0);
  assert.equal(c.snapshot().pending.length, 0);
});

test("better short execution prices cannot increase marked inventory beyond the shared cap", () => {
  const c = make(); c.setTarget(target(START, -12), START); c.onQuotes(quotes(ACTIVE), ACTIVE);
  const events = c.onQuotes(quotes(ACTIVE + 250, 109.99, 110), ACTIVE + 250);
  assert.equal(events.find(e => e.fill)?.fill?.signedQty, -.1);
  assert.ok(Math.abs(c.snapshot().actual["BTC/USD"].qty) * 110 <= 12);
  assert.equal(c.snapshot().pending.length, 0);
});

test("restart cancels pending virtual orders, preserves inventory and phase, and requires fresh quotes", () => {
  const pending = make(); pending.setTarget(target(), START); pending.onQuotes(quotes(ACTIVE), ACTIVE);
  const restored = make(), events = restored.restore(pending.checkpoint(), ACTIVE + 100);
  assert.equal(events[0]?.reason, "SHADOW_RESTART_PENDING_CANCELED"); assert.equal(restored.snapshot().pending.length, 0);
  restored.onQuotes(quotes(ACTIVE + 250), ACTIVE + 250); assert.equal(restored.snapshot().counters.fills, 0);
  assert.equal(restored.snapshot().counters.plans, 1);
  const filled = enter(), second = make(); second.restore(filled.checkpoint(), ACTIVE + 500);
  assert.deepEqual(second.snapshot().actual, filled.snapshot().actual);
  assert.equal(second.snapshot().quoteReady, false); assert.equal(second.snapshot().executionOnlyEquityUsd, null);
  second.onQuotes(quotes(ACTIVE + 400), ACTIVE + 600); assert.equal(second.snapshot().quoteReady, false);
  second.onQuotes(quotes(ACTIVE + HOUR), ACTIVE + HOUR); assert.equal(second.snapshot().lastPlan?.status, "HOLD");
  assert.equal(second.snapshot().totalFeesUsd, filled.snapshot().totalFeesUsd);
});

test("funding is never inferred zero or treated as fully costed profit; explicit receipts are idempotent", () => {
  const c = enter(); assert.equal(c.snapshot().fundingEvidence, "FUNDING_UNOBSERVED");
  assert.equal(c.snapshot().fullyCostedNetPnlUsd, null); assert.notEqual(c.snapshot().executionOnlyEquityUsd, null);
  const before = c.snapshot().executionOnlyEquityUsd, receipt = { id: "observed-hour", atMs: ACTIVE + 250, costUsd: .01 };
  c.onFunding(receipt, ACTIVE + 250); c.onFunding(receipt, ACTIVE + 250);
  assert.equal(c.snapshot().totalObservedFundingCostUsd, .01); assert.equal(c.snapshot().executionOnlyEquityUsd, before);
  assert.equal(c.snapshot().fullyCostedNetPnlUsd, null); assert.match(c.snapshot().fundingEvidence, /COVERAGE_UNVERIFIED/);
  assert.throws(() => c.onFunding({ ...receipt, costUsd: .02 }, ACTIVE + 250), /CONFLICTING/);
  assert.throws(() => c.onFunding({ ...receipt, id: "future", atMs: ACTIVE + 1000 }, ACTIVE + 250), /FUTURE_FUNDING/);
});

test("snapshot read time exposes silent stale feeds and expired targets without changing execution state", () => {
  const c = enter(), before = c.checkpoint(), lastEvent = ACTIVE + 250;
  const fresh = c.snapshot(lastEvent); assert.equal(fresh.quoteReady, true); assert.equal(fresh.dataReady, true);
  const stale = c.snapshot(lastEvent + 5001);
  assert.equal(stale.quoteReady, false); assert.equal(stale.quoteReason, "STALE_PUBLIC_QUOTES");
  assert.equal(stale.executionOnlyEquityUsd, null); assert.equal(stale.generatedAtMs, lastEvent + 5001);
  assert.equal(stale.lastEventAtMs, lastEvent);
  const expired = c.snapshot(START + 2 * DAY);
  assert.equal(expired.dataReady, false); assert.equal(expired.dataReason, "TARGET_EXPIRED_REDUCE_TO_FLAT");
  assert.deepEqual(c.checkpoint(), before); assert.equal(c.snapshot().generatedAtMs, lastEvent);
  assert.throws(() => c.snapshot(lastEvent - 1), /REVERSED_CLOCK/);
});

test("shadow reservations and virtual fill accounting match direct shared-kernel execution", () => {
  const c = make(), t = target(), q = quotes(ACTIVE); c.setTarget(t, START); c.onQuotes(q, ACTIVE);
  let state = newPortfolioState(); const plan = planPortfolioAdjustment({ state, target: t, quotes: q, rules, atMs: ACTIVE, feeBps: 5 });
  state = reservePortfolioOrders(state, plan); assert.deepEqual(c.checkpoint().state, state);
  const events = c.onQuotes(quotes(ACTIVE + 250), ACTIVE + 250), fill = events.find(e => e.fill)?.fill;
  assert.ok(fill); state = applyPortfolioFill(state, fill); assert.deepEqual(c.checkpoint().state, state);
});

test("expired desired target remains auditable while fresh-quote reductions flatten virtual inventory", () => {
  const c = enter(), at = START + 2 * DAY;
  assert.equal(c.onQuotes(quotes(at), at)[0]?.plan?.status, "REDUCE");
  assert.equal(c.snapshot().dataReason, "TARGET_EXPIRED_REDUCE_TO_FLAT"); assert.equal(c.snapshot().target!.targetUsd["BTC/USD"], 12);
  c.onQuotes(quotes(at + 250), at + 250); assert.equal(c.snapshot().actual["BTC/USD"].qty, 0);
});

test("history invalidation persists through restart and duplicate targets, flattens, and needs a newer target to resume", () => {
  const c = enter(), at = ACTIVE + HOUR;
  c.invalidateTarget("HISTORY_GAP", ACTIVE + 500); c.setTarget(target(), ACTIVE + 500);
  assert.equal(c.snapshot().dataReady, false); assert.equal(c.snapshot().targetInvalidation!.reason, "HISTORY_GAP");
  const restored = make(); restored.restore(c.checkpoint(), ACTIVE + 600);
  assert.equal(restored.snapshot().targetInvalidation!.reason, "HISTORY_GAP");
  assert.equal(restored.onQuotes(quotes(at), at)[0]?.plan?.status, "REDUCE");
  restored.onQuotes(quotes(at + 250), at + 250); assert.equal(restored.snapshot().actual["BTC/USD"].qty, 0);
  restored.onQuotes(quotes(at + HOUR), at + HOUR); assert.equal(restored.snapshot().pending.length, 0);
  restored.setTarget(target(START + DAY), START + DAY);
  assert.equal(restored.snapshot().targetInvalidation, null);
  assert.equal(restored.onQuotes(quotes(ACTIVE + DAY), ACTIVE + DAY)[0]?.plan?.status, "INCREASE");
  restored.invalidateTarget("HISTORY_CORRECTION", ACTIVE + DAY + 1);
  assert.equal(restored.snapshot().pending.length, 0);
  restored.onQuotes(quotes(ACTIVE + DAY + 250), ACTIVE + DAY + 250);
  assert.equal(restored.snapshot().actual["BTC/USD"].qty, 0);
});

test("checkpoint integrity, config, ledger and future receipts reject atomically", () => {
  const good = enter().checkpoint(), empty = make();
  for (const corrupt of [((cp: PortfolioShadowCheckpoint) => { cp.state.cashUsd += 1; return seal(cp); }),
    ((cp: PortfolioShadowCheckpoint) => { cp.target!.availableAtMs = cp.lastNowMs + 1; return seal(cp); }),
    ((cp: PortfolioShadowCheckpoint) => { cp.state.fillReceipts[0]!.atMs = cp.lastNowMs + 1; return seal(cp); }),
    ((cp: PortfolioShadowCheckpoint) => { cp.lastPhaseHourMs = cp.lastNowMs + HOUR; return seal(cp); }),
    ((cp: PortfolioShadowCheckpoint) => { cp.target!.targetUsd["BTC/USD"] = 99; return cp; })]) {
    const before = empty.checkpoint(); assert.throws(() => empty.restore(corrupt(structuredClone(good)), ACTIVE + 500), /CHECKPOINT|TARGET/);
    assert.deepEqual(empty.checkpoint(), before);
  }
  assert.throws(() => new PortfolioShadowController({ rules, feeBps: 6 }).restore(good, ACTIVE + 500), /CHECKPOINT_CONFIG/);
  assert.throws(() => empty.restore(good, ACTIVE), /CHECKPOINT/);
});

test("conflicting targets and reversed clocks reject; disconnect and malformed quotes cannot fill", () => {
  const c = make(); c.setTarget(target(), START);
  assert.throws(() => c.setTarget(target(START, 11), START), /CONFLICTING_TARGET/);
  assert.throws(() => c.setTarget(target(START - DAY), START), /REVERSED_TARGET/);
  assert.throws(() => make().setTarget(target(), START - 1), /INVALID_TARGET/);
  c.onQuotes(quotes(ACTIVE), ACTIVE); c.invalidateQuotes("DISCONNECT");
  assert.equal(c.snapshot().pending.length, 0);
  c.onQuotes(quotes(ACTIVE + 250), ACTIVE + 250); assert.equal(c.snapshot().counters.fills, 0);
  assert.throws(() => c.onQuotes(quotes(ACTIVE), ACTIVE), /REVERSED_CLOCK/);
  const invalid = quotes(ACTIVE + HOUR); invalid["BTC/USD"].ask = NaN;
  c.onQuotes(invalid, ACTIVE + HOUR); assert.equal(c.snapshot().quoteReady, false);
  assert.equal(c.snapshot().counters.fills, 0); assert.equal(PORTFOLIO_SHADOW_SPEC.shadowOnly, true);
});
