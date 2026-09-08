import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionController } from "../src/distribution/controller.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { distributionExit } from "../src/distribution/execution.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC as S, type DistributionEstimate } from "../src/distribution/spec.js";
import { findPolicy, policyExit } from "../src/research/trading-policy.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(Object.keys(costs).map(symbol => [symbol,
  { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true }]));
const book = (atMs: number, symbol = "BTC/USD"): BookState => ({ symbol, bids: [{ px: 100, qty: 1 }],
  asks: [{ px: 100.01, qty: 1 }], exchangeTsMs: atMs, receiveTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: false });
const readyMarket = (b: BookState) => ({ symbol: b.symbol, atMs: b.receiveTsMs, ready: true, reason: "READY", features: Array(12).fill(0) as number[] });

test("controller jointly excludes a panel if a missing path follows already completed shorter exits", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  const controller = new DistributionController(costs, { ...assets });
  const first = controller.onBook(book(0)); assert.ok(first.decision); assert.equal(first.samples.length, 0);
  for (let atMs = 1000; atMs <= 302_000; atMs += 1000) assert.equal(controller.onBook(book(atMs)).samples.length, 0);
  const invalid = controller.onBook(book(308_000));
  assert.equal(invalid.samples.length, 6);
  assert.ok(invalid.samples.some(s => s.outcomes.every(o => o.status === "FILLED")), "some 5m paths have already finished");
  assert.ok(invalid.samples.some(s => s.outcomes.some(o => o.status === "INVALID")), "longer horizons have unknown paths");
  assert.equal(controller.stats(308_000).learning.acceptedSamples, 0);
  assert.equal(controller.stats(308_000).invalidPanels, 1);
});

test("controller learns all actions only after the common panel completes and keeps immutable proposal features", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  const controller = new DistributionController(costs, { ...assets });
  const first = controller.onBook(book(0)).decision!;
  first.features[0] = 1; first.actionId = "long-5m";
  assert.equal(controller.currentDecision("BTC/USD")!.features[0], 0);
  assert.equal(controller.currentDecision("BTC/USD")!.actionId, null);
  let samples = [] as ReturnType<DistributionController["onBook"]>["samples"];
  for (let atMs = 1000; atMs <= 1_802_000; atMs += 1000) {
    const current = controller.onBook(book(atMs));
    if (atMs < 1_802_000) assert.equal(controller.stats(atMs).learning.acceptedSamples, 0);
    samples.push(...current.samples);
  }
  assert.equal(samples.length, 6); assert.ok(samples.every(s => s.features[0] === 0));
  assert.equal(controller.stats(1_802_000).learning.acceptedSamples, 6);
  assert.equal(controller.stats(1_802_000).validation.selections, 0, "caller mutation cannot create selected-policy evidence");
  const exported = controller.exportState(); exported.samples[0]!.features[0] = 1;
  assert.equal(controller.exportState().samples[0]!.features[0], 0);
});

test("prospective action selections share one BTC/ETH portfolio slot and cannot claim ready paper validation", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => ({
    actionId, samples: 60, effectiveSamples: 55, observedDays: 8, meanNetBps: 20, lowerMeanNetBps: 15,
    scoreBps: actionId === "long-5m" ? 15 : 10, tailLossBps: 0, fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const controller = new DistributionController(costs, { ...assets });
  const btc = controller.onBook(book(0)).decision!, eth = controller.onBook(book(0, "ETH/USD")).decision!;
  assert.equal(btc.actionId, "long-5m"); assert.equal(btc.paperReady, false); assert.equal(btc.reason, "PROSPECTIVE_VALIDATION");
  assert.equal(eth.actionId, null); assert.equal(eth.reason, "PORTFOLIO_RESEARCH_SLOT");
  assert.equal(controller.stats(0).selected, 1);
  controller.invalidate(100, "FEED_DISCONNECTED");
  assert.equal(controller.stats(100).invalidSelected, 1);
  assert.equal(controller.stats(100).validation.ready, false);
});

test("checkpoint rejects future, malformed and changed-cost labels before replacing learned state", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  const controller = new DistributionController(costs, { ...assets }); controller.onBook(book(0));
  for (let atMs = 1000; atMs <= 1_802_000; atMs += 1000) controller.onBook(book(atMs));
  const state = controller.exportState(), restored = new DistributionController(costs, { ...assets });
  assert.equal(restored.restoreState(state, 2_000_000), 6);
  assert.throws(() => restored.restoreState(state, 1000), /CHECKPOINT/);
  const malformed = structuredClone(state); malformed.samples[0]!.outcomes[0]!.netBps = NaN;
  assert.throws(() => restored.restoreState(malformed, 2_000_000), /CHECKPOINT/);
  assert.throws(() => new DistributionController({ ...costs, "BTC/USD": { feeBps: 6, reserveBps: 3 } })
    .restoreState(state, 2_000_000), /CHECKPOINT/);
  assert.equal(restored.stats(2_000_000).learning.acceptedSamples, 6);
  assert.equal(restored.currentDecision("BTC/USD"), null);
});

test("live fixed policies match every distribution action's stops, net targets and deadlines", () => {
  const reasons = { STOP_LOSS: "POLICY_STOP", TAKE_PROFIT: "POLICY_TARGET", DEADLINE: "POLICY_DEADLINE" } as const;
  for (const action of DISTRIBUTION_ACTIONS) {
    const policy = findPolicy(action.policyId)!; assert.ok(policy);
    assert.equal(policy.horizonMs, action.horizonMs); assert.equal(policy.stopLossBps, action.stopLossBps);
    assert.equal(policy.takeProfitNetBps, action.takeProfitNetBps);
    for (const [gross, net, elapsed] of [
      [-action.stopLossBps, -action.stopLossBps - 13, 100],
      [action.takeProfitNetBps + 13, action.takeProfitNetBps, 100],
      [0, -13, action.horizonMs], [0, -13, action.horizonMs - 1],
    ]) {
      const expected = distributionExit(action, gross!, net!, elapsed!);
      assert.equal(policyExit(policy, gross!, net!, elapsed!), expected ? reasons[expected as keyof typeof reasons] : null);
    }
  }
});

test("checkpoint selected-policy records cannot bypass portfolio spacing, finite evidence or scenario identity", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => ({
    actionId, samples: 60, effectiveSamples: 55, observedDays: 8, meanNetBps: 25,
    lowerMeanNetBps: actionId === "long-5m" ? 20 : 15, scoreBps: actionId === "long-5m" ? 20 : 15,
    tailLossBps: 0, fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const controller = new DistributionController(costs, { ...assets });
  const btc = controller.onBook(book(0)).decision!;
  const completeEarly = (symbol: string, origin: number): void => {
    controller.onBook(book(origin + 1000, symbol));
    for (const delta of [1250, 1500, 2000]) controller.onBook({ ...book(origin + delta, symbol),
      bids: [{ px: 110, qty: 1 }], asks: [{ px: 110.01, qty: 1 }] });
  };
  completeEarly("BTC/USD", 0);
  const eth = controller.onBook(book(300_000, "ETH/USD")).decision!;
  assert.equal(eth.actionId, "long-5m"); completeEarly("ETH/USD", 300_000);
  const state = controller.exportState(); assert.equal(state.samples.length, 12); assert.equal(state.validationSelections.length, 2);
  assert.equal(new DistributionController(costs, { ...assets }).restoreState(state, 400_000), 12);
  const impossibleSlot = structuredClone(state), overlap = impossibleSlot.validationSelections[1]!;
  overlap.signalAtMs = overlap.decision.atMs = overlap.sample!.signalAtMs = 1000;
  overlap.sampleId = overlap.sample!.id = `${overlap.sample!.symbol}:${overlap.sample!.actionId}:1000`;
  assert.throws(() => new DistributionController(costs).restoreState(impossibleSlot, 400_000), /VALIDATION|CHECKPOINT/);
  for (const field of ["effectiveSamples", "observedDays", "samples"] as const) {
    const malformed = structuredClone(state), decision = malformed.validationSelections[0]!.decision;
    decision.estimates.find(e => e.actionId === decision.actionId)![field] = NaN;
    assert.throws(() => new DistributionController(costs).restoreState(malformed, 400_000), /VALIDATION|CHECKPOINT/);
  }
  const reordered = structuredClone(state), selection = reordered.validationSelections[0]!;
  const row = selection.sample!;
  [row.outcomes[0], row.outcomes[1]] = [row.outcomes[1]!, row.outcomes[0]!];
  selection.netBps = row.outcomes.map(o => o.netBps!);
  assert.throws(() => new DistributionController(costs).restoreState(reordered, 400_000), /VALIDATION|CHECKPOINT/);
});

test("dashboard statistics never advance market clocks or alter subsequent emitted decisions", () => {
  const a = new DistributionController(costs, { ...assets }), b = new DistributionController(costs, { ...assets });
  for (let atMs = 0; atMs <= 1_801_000; atMs += 1000) {
    for (const symbol of ["BTC/USD", "ETH/USD"]) {
      const quote = book(atMs, symbol), left = a.onBook(quote), right = b.onBook(quote);
      assert.deepEqual(left, right);
    }
    if (atMs % 60_000 === 0) {
      a.stats(atMs + 60_000); a.stats(atMs); a.stats(atMs + 1);
    }
  }
  assert.deepEqual(a.exportState(), b.exportState());
});


test("fresh inference continues once per second while the 31-minute training panel is pending", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  const controller = new DistributionController(costs, { ...assets });
  const first = controller.onBook(book(0)); assert.ok(first.decision); assert.ok(first.trainingDecision);
  assert.equal(controller.onBook(book(250)).decision, null);
  const second = controller.onBook(book(1000)); assert.ok(second.decision); assert.equal(second.trainingDecision, null);
  assert.equal(controller.onBook({ ...book(1500), sequence: book(1000).sequence }).decision, null, "a repeated quote cannot trigger inference");
  assert.equal(controller.onBook(book(1999)).decision, null);
  assert.ok(controller.onBook(book(2000)).decision);
  const stats = controller.stats(2000);
  assert.equal(stats.evaluations, 3); assert.equal(stats.proposals, 1); assert.equal(stats.pendingPanels, 1);
  assert.equal(stats.nextEvaluations["BTC/USD"], 3000); assert.equal(stats.nextProposals["BTC/USD"], S.proposalIntervalMs);
  assert.equal(stats.learning.acceptedSamples, 0);
});

test("selected paths finish independently, release the slot causally, and never train overlapping outcomes", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => ({
    actionId, samples: 60, effectiveSamples: 55, observedDays: 8, meanNetBps: 25,
    lowerMeanNetBps: actionId === "long-5m" ? 20 : 15, scoreBps: actionId === "long-5m" ? 20 : 15,
    tailLossBps: 0, fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const controller = new DistributionController(costs, { ...assets });
  const first = controller.onBook(book(0)); first.decision!.features[0] = 1;
  for (let atMs = 1000; atMs < 302_000; atMs += 1000) controller.onBook(book(atMs));
  const complete = controller.onBook(book(302_000));
  assert.equal(complete.samples.length, 0, "15m and 30m training paths still run");
  assert.equal(complete.selections.length, 1); assert.equal(complete.selections[0]!.valid, true);
  assert.equal(complete.selections[0]!.sample.features[0], 0, "caller mutation cannot alter selected features");
  assert.equal(complete.decision!.actionId, null, "completion quote cannot launch a replacement");
  assert.equal(controller.stats(302_000).validation.selections, 1);
  assert.equal(controller.stats(302_000).learning.acceptedSamples, 0);
  assert.equal(controller.onBook(book(301_999, "ETH/USD")).decision!.actionId, null, "interleaved earlier peer receipt cannot reuse a future released slot");
  assert.equal(controller.onBook(book(302_000, "ETH/USD")).decision, null);
  assert.equal(controller.onBook(book(303_000, "ETH/USD")).decision!.actionId, "long-5m");
  controller.onBook(book(303_250, "ETH/USD"));
  const invalid = controller.onBook(book(309_000, "ETH/USD"));
  assert.equal(invalid.selections.length, 1); assert.equal(invalid.selections[0]!.valid, false);
  assert.equal(controller.stats(309_000).validation.selections, 0);
  assert.equal(controller.stats(309_000).invalidSelected, 1);
  const state = controller.exportState();
  assert.equal(state.samples.length, 0); assert.equal(state.validationSelections.length, 0);
});

test("legacy policy evidence clears while valid v1 training remains available", t => {
  t.mock.method(DistributionMarket.prototype, "onBook", readyMarket);
  const source = new DistributionController(costs, { ...assets }); source.onBook(book(0));
  for (let atMs = 1000; atMs <= 1_802_000; atMs += 1000) source.onBook(book(atMs));
  const legacy = JSON.parse(JSON.stringify(source.exportState()));
  delete legacy.selectionPolicyVersion; delete legacy.nextEvaluations;
  legacy.validationSelections = [{ oldCadenceEvidence: true }];
  const restored = new DistributionController(costs, { ...assets });
  assert.equal(restored.restoreState(legacy, 1_803_000), 6);
  assert.equal(restored.stats(1_803_000).validation.selections, 0);
  assert.equal(restored.stats(1_803_000).nextProposals["BTC/USD"], S.proposalIntervalMs);
});
