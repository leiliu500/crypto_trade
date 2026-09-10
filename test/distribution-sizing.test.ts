import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { buildDistributionPlan } from "../src/distribution/planner.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_ENTRY_PROFILES } from "../src/distribution/spec.js";
import { policyReserveBps } from "../src/research/policy-planner.js";
import { createDistributionSizingPolicy, distributionSizingId, distributionSizingStateFile,
  sizeDistributionContext } from "../src/distribution/sizing.js";
import { mergeDistributionTraining } from "../src/distribution/training-import.js";

const cfg = loadConfig({ TRADING_MODE: "paper", DISTRIBUTIONAL_ENGINE_ENABLED: "true" });
const policy = cfg.distributionalSizingPolicy!;
const rules: Record<string, AssetRules> = Object.fromEntries(["BTC/USD", "ETH/USD"].map((symbol, i) => [symbol, {
  symbol, minOrderSize: i ? .001 : .0001, minTradeIncrement: i ? .001 : .0001,
  priceIncrement: i ? .1 : 1, maximumOrderQty: i ? 21000 : 1200, shortable: true,
}]));
const costs = Object.fromEntries(Object.entries(cfg.symbolConfigs).map(([s, c]) => [s,
  { feeBps: c.cost.takerFeeBps, reserveBps: policyReserveBps(c) }]));
function quote(symbol = "BTC/USD", atMs = 1_800_000_000_000): BookState {
  const bid = symbol === "BTC/USD" ? 78_249 : 2476.3, ask = symbol === "BTC/USD" ? 78_250 : 2476.4;
  return { symbol, receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs), valid: true,
    sourceReset: false, bids: [{ px: bid, qty: 100 }], asks: [{ px: ask, qty: 100 }] };
}
function context(book: BookState, equity = 100_000, highWater = equity) {
  const mid = (book.bids[0]!.px + book.asks[0]!.px) / 2;
  const features = { symbol: book.symbol, receiveTsMs: book.receiveTsMs, mid,
    spreadBps: (book.asks[0]!.px - book.bids[0]!.px) / mid * 10_000, sigmaHBps: 1, velocityZ: 0,
    stale: false } as DeterministicFeatures;
  return { equity, equityHighWater: highWater, features };
}
const maximumStop = Math.max(...DISTRIBUTION_ACTIONS.map(a => a.stopLossBps));

test("default paper cap is $1,000 and 1% of equity; both real venue lot sizes can exceed $12", () => {
  assert.equal(policy.maximumNotional, 1000);
  assert.equal(policy.maximumEquityFraction, .01);
  for (const symbol of Object.keys(rules)) {
    const book = quote(symbol), rule = rules[symbol]!;
    const size = sizeDistributionContext(policy, book, rule, context(book), maximumStop);
    assert.equal(size.reason, "RISK_BOUNDED_SIZE_READY");
    assert.ok(size.qty * book.asks[0]!.px > 990);
    assert.ok(size.qty * book.asks[0]!.px <= 1000);
    assert.ok(Math.abs(size.qty / rule.minTradeIncrement - Math.round(size.qty / rule.minTradeIncrement)) < 1e-8);
    const smaller = sizeDistributionContext(policy, book, rule, context(book, 5000), maximumStop);
    assert.equal(smaller.maximumNotional, 50);
    assert.ok(smaller.qty * book.asks[0]!.px <= 50);
    assert.ok(smaller.qty < size.qty);
  }
});

test("liquidity and modeled loss reduce quantities and never force a minimum lot", () => {
  const book = quote(), rule = rules[book.symbol]!;
  book.bids[0]!.qty = .1;
  const liquid = sizeDistributionContext(policy, book, rule, context(book), maximumStop);
  assert.equal(liquid.qty, .001);
  assert.equal(liquid.bindingLimit, "liquidity");
  book.bids[0]!.qty = .005;
  assert.equal(sizeDistributionContext(policy, book, rule, context(book), maximumStop).reason, "LIQUIDITY_BELOW_MINIMUM_ORDER");
  book.bids[0]!.qty = 100;
  const conservative = structuredClone(policy);
  conservative.symbols[book.symbol]!.risk.baseRiskFraction = .00001;
  const sized = sizeDistributionContext(conservative, book, rule, context(book), maximumStop);
  assert.ok(sized.qty > 0 && sized.qty * book.asks[0]!.px < 200);
  // Independent stop + configured costs + jump reserve, expressed in dollars.
  const lossPerUnit = book.asks[0]!.px * (60 + 10 + 3 + context(book).features.spreadBps + 5) / 10_000;
  assert.ok(sized.qty * lossPerUnit <= 1);
  assert.equal(sizeDistributionContext(policy, book, rule, context(book, 100), maximumStop).reason, "NOTIONAL_BELOW_MINIMUM_ORDER");
  assert.equal(sizeDistributionContext(policy, book, rule, context(book, 95_000, 100_000), maximumStop).qty, 0);
  for (const value of [NaN, Infinity, -1, 0])
    assert.equal(sizeDistributionContext(policy, book, rule, context(book, value), maximumStop).qty, 0);
});

test("configuration fingerprints separate training banks and include risk, fee and symbol limits", () => {
  const old = loadConfig({ DISTRIBUTIONAL_SIZING_MODE: "LEGACY_FIXED" });
  assert.equal(old.distributionalSizingPolicy, undefined);
  assert.notEqual(cfg.distributionalStateFile, old.distributionalStateFile);
  assert.equal(cfg.distributionalHistoryFile, old.distributionalHistoryFile);
  for (const change of [
    (p: typeof policy) => { p.maximumEquityFraction = .005; },
    (p: typeof policy) => { p.symbols["BTC/USD"]!.maximumNotional = 500; },
    (p: typeof policy) => { p.symbols["ETH/USD"]!.risk.baseRiskFraction = .0005; },
    (p: typeof policy) => { p.symbols["ETH/USD"]!.cost.takerFeeBps = 6; },
  ]) {
    const changed = structuredClone(policy); change(changed);
    assert.notEqual(distributionSizingStateFile("bank", policy), distributionSizingStateFile("bank", changed));
  }
  assert.throws(() => createDistributionSizingPolicy(cfg.symbolConfigs, 0, .01), /SIZING_POLICY/);
  assert.throws(() => createDistributionSizingPolicy(cfg.symbolConfigs, 1000, 1.1), /SIZING_POLICY/);
  assert.throws(() => loadConfig({ DISTRIBUTIONAL_SIZING_MODE: "unknown" }), /SIZING_MODE/);
});

test("real BTC and ETH decimal lots preserve exact decision quantity through planning and account rechecks", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", (book: BookState) => ({ symbol: book.symbol,
    atMs: book.receiveTsMs, ready: true, reason: "READY", features: Array<number>(12).fill(0) }));
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string) => ({
    actionId, samples: 100, effectiveSamples: 80, observedDays: 3, meanNetBps: 40, lowerMeanNetBps: 31,
    tailLossBps: 10, scoreBps: 30, fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const profile = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL;
  for (const symbol of Object.keys(rules)) {
    const controller = new DistributionController(costs, rules, profile, { sizingPolicy: policy });
    const book = quote(symbol), ctx = context(book);
    const decision = controller.onBook(book, rules[symbol], ctx).decision!;
    assert.ok(decision.actionId);
    const input = { config: cfg.symbolConfigs[symbol]!, book, asset: rules[symbol]!, decision,
      ...ctx, paperAllowed: true, nowMs: book.receiveTsMs, profile, sizingPolicy: policy };
    const result = buildDistributionPlan(input);
    assert.ok(result.plan, result.reason);
    assert.equal(result.plan.qty, decision.requestedQty);
    assert.equal(result.plan.risk.qty, decision.requestedQty);
    assert.ok(result.plan.qty * result.plan.limitPx > 990);
    assert.equal(buildDistributionPlan({ ...input, equity: 1000, equityHighWater: 1000 }).plan, null);
    assert.equal(buildDistributionPlan({ ...input, decision: { ...decision, sizingPolicyId: "wrong" } }).plan, null);
    assert.equal(buildDistributionPlan({ ...input, decision: { ...decision, requestedQty: decision.requestedQty / 2 } }).plan, null);
  }
});

test("efficient collection retains size provenance, roundtrips its bank and rejects legacy or changed sizing", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", (book: BookState) => ({ symbol: book.symbol,
    atMs: book.receiveTsMs, ready: true, reason: "READY", features: Array<number>(12).fill(0) }));
  const options = { efficientTraining: true, sizingPolicy: policy };
  const profile = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT;
  const controller = new DistributionController(costs, rules, profile, options);
  const old = new DistributionController(costs, rules, profile, { efficientTraining: true }).exportState();
  assert.throws(() => controller.restoreState(old, quote().receiveTsMs), /SIZING_POLICY/);
  const origin = quote().receiveTsMs;
  const first = quote();
  const start = controller.onBook(first, rules[first.symbol], context(first));
  assert.ok(start.trainingDecision!.requestedQty * first.asks[0]!.px > 990);
  assert.equal(start.trainingDecision!.sizingPolicyId, distributionSizingId(policy));
  for (const elapsed of [250, 750, 1000, 1250, 1750, 2000]) {
    const book = quote("BTC/USD", origin + elapsed);
    if (elapsed >= 1000) { book.bids[0]!.px *= 1.02; book.asks[0]!.px *= 1.02; }
    controller.onBook(book, rules[book.symbol], context(book));
  }
  const state = controller.exportState();
  assert.ok(state.samples.length > 0);
  assert.ok(state.samples.every(sample => sample.sizingPolicyId === distributionSizingId(policy)));
  const restored = new DistributionController(costs, rules, profile, options);
  assert.equal(restored.restoreState(state, origin + 2500), state.samples.length);
  const damaged = structuredClone(state);
  delete damaged.samples[0]!.sizingPolicyId;
  assert.throws(() => restored.restoreState(damaged, origin + 2500), /LABEL_SIZING/);
  const changed = structuredClone(state); changed.sizingPolicy!.maximumEquityFraction = .02;
  assert.throws(() => restored.restoreState(changed, origin + 2500), /SIZING_POLICY/);
  assert.throws(() => mergeDistributionTraining(state, old, costs, rules, origin + 2500, profile), /FIXED_SIZE_BACKFILL/);
});
