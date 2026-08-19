import assert from "node:assert/strict";
import test from "node:test";
import { DynamicLiquidityPolicy, type DynamicLiquidityConfig, type LiquidityInput } from "../src/strategy/dynamic-liquidity.js";

const config = (): DynamicLiquidityConfig => ({
  maximumSamples: 10, minimumSamples: 3, tradeQuantile: .5, tradeMadMultiple: 3, stressMadMultiple: 6,
  absoluteTradeCapBps: 10, absoluteStressCapBps: 20, maximumSpreadZ: 5, minimumDepthZ: -5,
  maximumImpactBps: 5,
});
const input = (spreadBps: number): LiquidityInput => ({
  spreadBps, spreadZ: 0, depthZ: 0, impactBps: 1,
  providerAgeMs: 10, stale: false,
});

test("dynamic liquidity fails closed during warmup and accepts the learned normal spread", () => {
  const policy = new DynamicLiquidityPolicy(config());
  policy.observe(1);
  policy.observe(1);
  assert.deepEqual(policy.evaluate(input(1)).reasons, ["SPREAD_WARMUP"]);
  policy.observe(1);
  const decision = policy.evaluate(input(1));
  assert.equal(decision.pass, true);
  assert.equal(decision.tradeThresholdBps, 1);
});

test("the current spread outlier cannot relax its own causal threshold", () => {
  const policy = new DynamicLiquidityPolicy(config());
  for (const spread of [1, 1, 1]) policy.observe(spread);
  const outlier = policy.evaluate(input(10));
  assert.equal(outlier.pass, false);
  assert.equal(outlier.stress, true);
  assert.equal(outlier.tradeThresholdBps, 1);
  policy.observe(10);
  assert.equal(policy.evaluate(input(1)).tradeThresholdBps, 1);
});

test("dynamic liquidity histories are isolated per symbol runtime", () => {
  const btc = new DynamicLiquidityPolicy(config());
  const doge = new DynamicLiquidityPolicy(config());
  for (const spread of [1, 1, 1]) btc.observe(spread);
  for (const spread of [8, 8, 8]) doge.observe(spread);
  assert.equal(btc.evaluate(input(1)).tradeThresholdBps, 1);
  assert.equal(doge.evaluate(input(8)).tradeThresholdBps, 8);
});

test("provider age uses the feature engine's dynamic stale decision instead of a second fixed limit", () => {
  const policy = new DynamicLiquidityPolicy(config());
  for (const spread of [1, 1, 1]) policy.observe(spread);
  assert.equal(policy.evaluate({ ...input(1), providerAgeMs: 2_500, stale: false }).pass, true);
  assert.ok(policy.evaluate({ ...input(1), providerAgeMs: 2_500, stale: true }).reasons.includes("FEATURES_STALE"));
});

test("liquidity observations do not depend on a directional candidate", () => {
  const policy = new DynamicLiquidityPolicy({ ...config(), maximumSamples: 500 });
  for (let index = 0; index < 500; index += 1) policy.observe(20 + index % 3);
  assert.equal(policy.observationCount(), 500);
});
