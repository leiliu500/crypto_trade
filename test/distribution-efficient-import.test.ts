import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DistributionController } from "../src/distribution/controller.js";
import { EfficientDistributionTrainer, EFFICIENT_TRAINING_SPEC } from "../src/distribution/efficient-trainer.js";
import { mergeDistributionTraining } from "../src/distribution/training-import.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, distributionEntryProfile,
  type DistributionSample } from "../src/distribution/spec.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, { symbol,
  minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 100, shortable: true }]));
const cutoffMs = 4_000_000_000, profile = distributionEntryProfile(true, true);
const order = (a: DistributionSample, b: DistributionSample) => a.signalAtMs - b.signalAtMs
  || a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId);
function sample(atMs: number, actionId = "long-5m", symbol = "BTC/USD"): DistributionSample {
  return { id: `${symbol}:${actionId}:${atMs}`, symbol, actionId, signalAtMs: atMs, completedAtMs: atMs + 1000,
    features: Array(12).fill(0) as number[], outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({
      scenario: scenario.id, status: "UNFILLED", netBps: 0, grossBps: 0, filledFraction: 0,
      entryAtMs: null, exitAtMs: atMs + 1000, reason: "IOC_UNFILLED" })) };
}
const panel = (atMs: number) => DISTRIBUTION_ACTIONS.map(action => sample(atMs, action.id));
function historical(signals: number[]) {
  const state = new DistributionController(costs, structuredClone(assets)).exportState();
  state.samples = signals.flatMap(panel);
  return { ...state, trainingBackfill: { version: `${S.version}:training-backfill-v1`, cutoffMs,
    trainingOnly: true, prospectiveSelectionsCreated: 0, brokerOrdersSubmitted: 0,
    profitabilityEstablished: false, deploymentReady: false, spec: S, costs, assets,
    instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
    inputFiles: [{ path: "/synthetic-historical-fixture.jsonl", bytes: 1, sha256: "0".repeat(64) }],
    quality: { firstMs: 0, lastMs: Math.max(1000, ...signals.map(time => time + 1000)) },
    retainedSamples: state.samples.length, retainedPanels: signals.length } };
}
function live(samples: DistributionSample[], validation = false, pendingTraining = false) {
  const state = new DistributionController(costs, structuredClone(assets), profile, { efficientTraining: true }).exportState();
  state.samples = structuredClone(samples).sort(order);
  state.efficientTraining = new EfficientDistributionTrainer(costs, structuredClone(assets), state.samples, cutoffMs).exportSchedulerState();
  state.efficientTraining.observedThrough = { "BTC/USD": cutoffMs - 500, "ETH/USD": cutoffMs - 600 };
  state.efficientTraining.invalidatedThrough = { "BTC/USD": cutoffMs - 1500, "ETH/USD": cutoffMs - 1600 };
  if (pendingTraining) {
    state.efficientTraining.pendingOrigins = [{ symbol: "BTC/USD", actionId: "long-5m", signalAtMs: cutoffMs - 100 }];
    state.efficientTraining.nextOrigins["BTC/USD:300000"] = cutoffMs - 100 + 360_000;
  }
  if (validation) {
    const selected = sample(cutoffMs - 5000, "short-15m");
    state.validationSelections = [{ sample: selected, sampleId: selected.id, signalAtMs: selected.signalAtMs,
      completedAtMs: selected.completedAtMs, netBps: [0, 0, 0], decision: {
        version: S.version, selectionPolicyVersion: profile.selectionPolicyVersion, entryMode: "PAPER_TRIAL",
        symbol: selected.symbol, atMs: selected.signalAtMs, quoteSequence: "1", referenceBid: 100,
        referenceAsk: 100.01, requestedQty: .1, feeBps: 5, reserveBps: 3, features: [...selected.features],
        actionId: selected.actionId, reason: "PAPER_TRIAL_NET_RETURN", paperReady: true,
        estimates: DISTRIBUTION_ACTIONS.map(action => ({ actionId: action.id, samples: 100, effectiveSamples: 80,
          observedDays: 3, meanNetBps: 25, lowerMeanNetBps: 20, tailLossBps: 0, scoreBps: 20,
          fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE" })),
        validation: { selections: 0, observedDays: 0, lowerNetBps: null, ready: false },
      } }];
  }
  return state;
}
const merge = (state: ReturnType<typeof live>, artifact: ReturnType<typeof historical>) => {
  const result = mergeDistributionTraining(state, artifact, costs, assets, cutoffMs, profile);
  assert.ok("efficientTraining" in result.state);
  return { ...result, state: result.state };
};

test("legacy artifact reimport preserves an uneven efficient bank, selection evidence and scheduler byte-for-byte", () => {
  const state = live([...panel(0), sample(10 * S.proposalIntervalMs),
    sample(10 * S.proposalIntervalMs + 360_000, "short-5m"), sample(12 * S.proposalIntervalMs, "long-15m", "ETH/USD")], true, true);
  const before = structuredClone(state), result = merge(state, historical([0]));
  assert.equal(result.report.addedSamples, 0); assert.equal(result.report.duplicatePanels, 1);
  assert.equal(result.report.prospectiveValidationReset, false); assert.equal(result.report.validation.selections, 1);
  assert.deepEqual(result.state, before); assert.deepEqual(state, before);
  assert.equal(result.state.trainingPolicyVersion, EFFICIENT_TRAINING_SPEC.version);
});

test("older historical panels fill an efficient bank without altering later labels or existing horizon clocks", () => {
  const later = [...panel(4 * S.proposalIntervalMs), sample(6 * S.proposalIntervalMs), sample(7 * S.proposalIntervalMs, "short-5m")];
  const state = live(later, true, true), before = structuredClone(state), result = merge(state, historical([0]));
  assert.equal(result.report.addedSamples, 6); assert.equal(result.report.addedPanels, 1);
  assert.equal(result.report.prospectiveValidationReset, true); assert.equal(result.report.validation.selections, 0);
  assert.deepEqual(result.state.validationSelections, []); assert.deepEqual(result.state.pendingSelections, []);
  assert.deepEqual(result.state.efficientTraining, before.efficientTraining);
  assert.equal(result.state.trainingPolicyVersion, before.trainingPolicyVersion);
  assert.equal(result.state.selectionPolicyVersion, before.selectionPolicyVersion);
  for (const sample of later) assert.deepEqual(result.state.samples.find(row => row.id === sample.id), sample);
  assert.equal(new DistributionController(costs, structuredClone(assets), profile,
    { efficientTraining: true }).restoreState(result.state, cutoffMs), later.length + 6);
  assert.deepEqual(state, before);
});

test("merge handles duplicate and overlapping actions independently without calling partial additions full panels", () => {
  const origin = S.proposalIntervalMs;
  const state = live([sample(origin), sample(origin + 1000, "short-5m")]);
  const result = merge(state, historical([origin]));
  assert.equal(result.report.addedSamples, 4); assert.equal(result.report.addedPanels, 0);
  assert.ok("addedActionLabels" in result.report);
  assert.equal(result.report.addedActionLabels, 4); assert.equal(result.report.duplicateActionLabels, 1);
  assert.equal(result.report.skippedOverlapActionLabels, 1); assert.equal(result.report.partiallyAddedHistoricalPanels, 1);
  assert.equal(result.report.duplicatePanels, 0); assert.equal(result.report.skippedOverlapPanels, 0);
  assert.equal(result.state.samples.length, 6);
  assert.deepEqual(result.state.samples.find(row => row.actionId === "short-5m"), state.samples[1]);
});

test("efficient import rejects duplicate id conflicts, partial or future artifacts, and efficient data disguised as legacy provenance", () => {
  const state = live([sample(0)]), before = structuredClone(state);
  const conflict = historical([0]); for (const row of conflict.samples) row.features[0] = .5;
  assert.throws(() => merge(state, conflict), /DUPLICATE_ACTION_CONFLICT/);
  const partial = historical([S.proposalIntervalMs]); partial.samples.pop();
  assert.throws(() => merge(state, partial), /CHECKPOINT_PANEL/);
  const future = historical([S.proposalIntervalMs]); future.trainingBackfill.cutoffMs++;
  assert.throws(() => merge(state, future), /PROVENANCE/);
  const disguised = historical([S.proposalIntervalMs]); disguised.trainingPolicyVersion = EFFICIENT_TRAINING_SPEC.version;
  assert.throws(() => merge(state, disguised), /PROVENANCE/);
  assert.deepEqual(state, before);
});

test("bounded efficient import retains every newer live label and reports capacity-discarded actions separately", () => {
  const recent = Array.from({ length: S.maximumSamples }, (_, index) => sample(10 * S.proposalIntervalMs + index * 360_000));
  const state = live(recent), result = merge(state, historical([0]));
  assert.equal(result.report.addedSamples, 5); assert.equal(result.report.addedPanels, 0);
  assert.ok("capacityDiscardedHistoricalActionLabels" in result.report);
  assert.equal(result.report.capacityDiscardedHistoricalActionLabels, 1);
  assert.equal(result.report.capacityDiscardedHistoricalPanels, 0);
  assert.deepEqual(result.state.samples.filter(row => row.actionId === "long-5m"), recent);
  assert.equal(result.state.samples.length, S.maximumSamples + 5);
});

test("new historical completions advance only necessary scheduler floors and remain restartable", () => {
  const state = live(panel(0)), before = structuredClone(state), origin = S.proposalIntervalMs;
  const result = merge(state, historical([origin]));
  assert.equal(result.report.addedSamples, 6);
  for (const horizon of EFFICIENT_TRAINING_SPEC.horizons) assert.equal(
    result.state.efficientTraining!.nextOrigins[`BTC/USD:${horizon.horizonMs}`], origin + horizon.intervalMs);
  assert.deepEqual(result.state.efficientTraining!.observedThrough, before.efficientTraining!.observedThrough);
  assert.deepEqual(result.state.efficientTraining!.invalidatedThrough, before.efficientTraining!.invalidatedThrough);
  assert.equal(new DistributionController(costs, structuredClone(assets), profile,
    { efficientTraining: true }).restoreState(result.state, cutoffMs), 12);
  assert.deepEqual(state, before);
});
