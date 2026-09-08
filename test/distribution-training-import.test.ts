import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DistributionController, type DistributionCosts } from "../src/distribution/controller.js";
import { mergeDistributionTraining, readDistributionTrainingArtifact } from "../src/distribution/training-import.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_ENTRY_PROFILES } from "../src/distribution/spec.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { loadConfig } from "../src/config.js";
import { policyReserveBps } from "../src/research/policy-planner.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, { symbol,
  minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 100, shortable: true }]));
const cutoffMs = 4_000_000_000;
function state(signals: number[], withValidation = false, sourceCosts: DistributionCosts = costs) {
  const value = new DistributionController(sourceCosts, { ...assets }).exportState();
  value.samples = signals.flatMap(atMs => DISTRIBUTION_ACTIONS.map(action => ({
    id: `BTC/USD:${action.id}:${atMs}`, symbol: "BTC/USD", actionId: action.id,
    signalAtMs: atMs, completedAtMs: atMs + 1000, features: Array(12).fill(0) as number[],
    outcomes: DISTRIBUTION_SCENARIOS.map(s => ({ scenario: s.id, status: "UNFILLED" as const,
      netBps: 0, grossBps: 0, filledFraction: 0, entryAtMs: null, exitAtMs: atMs + 1000, reason: "IOC_UNFILLED" })),
  })));
  if (withValidation) {
    const sample = value.samples.at(-6)!;
    value.validationSelections.push({ sample: structuredClone(sample), sampleId: sample.id, signalAtMs: sample.signalAtMs,
      completedAtMs: sample.completedAtMs, netBps: [0, 0, 0], decision: {
        version: S.version, selectionPolicyVersion: S.selectionPolicyVersion,
        symbol: sample.symbol, atMs: sample.signalAtMs, quoteSequence: "1",
        referenceBid: 100, referenceAsk: 100.01, requestedQty: .1, feeBps: 5, reserveBps: 3,
        features: [...sample.features], actionId: sample.actionId, reason: "PROSPECTIVE_VALIDATION", paperReady: false,
        estimates: DISTRIBUTION_ACTIONS.map(action => ({ actionId: action.id, samples: 100, effectiveSamples: 80, observedDays: 8,
          meanNetBps: 25, lowerMeanNetBps: 20, tailLossBps: 0, scoreBps: 20,
          fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE" })),
        validation: { selections: 0, observedDays: 0, lowerNetBps: null, ready: false },
      } });
  }
  return value;
}
function artifact(signals: number[], sourceCosts: DistributionCosts = costs) {
  const value = state(signals, false, sourceCosts);
  return { ...value, trainingBackfill: {
    version: `${S.version}:training-backfill-v1`, cutoffMs, trainingOnly: true,
    prospectiveSelectionsCreated: 0, brokerOrdersSubmitted: 0, profitabilityEstablished: false, deploymentReady: false,
    spec: S, costs: sourceCosts, assets,
    instrumentRulesSha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
    inputFiles: [{ path: "/test/synthetic-fixture.jsonl", bytes: 100, sha256: "0".repeat(64) }],
    quality: { firstMs: 0, lastMs: Math.max(1000, ...signals.map(t => t + 1000)) },
    retainedSamples: value.samples.length, retainedPanels: signals.length,
  } };
}

test("startup import preserves later live panels, skips overlaps, and resets validation only after new labels", () => {
  const live = state([2 * S.proposalIntervalMs, 4 * S.proposalIntervalMs], true);
  const prepared = artifact([0, 2 * S.proposalIntervalMs, 4 * S.proposalIntervalMs - 1000]);
  const result = mergeDistributionTraining(live, prepared, costs, assets, cutoffMs);
  assert.equal(result.report.addedSamples, 6);
  assert.equal(result.report.duplicatePanels, 1);
  assert.equal(result.report.skippedOverlapPanels, 1);
  assert.equal(result.report.retainedSamples, 18);
  assert.equal(result.report.prospectiveValidationReset, true);
  assert.deepEqual(result.state.validationSelections, []);
  assert.equal(live.validationSelections.length, 1, "merge must not mutate live state before installation");
  assert.deepEqual(result.state.samples.filter(s => s.signalAtMs > 0).map(s => s.id).sort(), live.samples.map(s => s.id).sort());
  assert.equal(new DistributionController(costs, { ...assets }).restoreState(result.state, cutoffMs), 18);
});

test("repeated startup import is idempotent and preserves subsequently accumulated prospective evidence", () => {
  const live = state([0, cutoffMs - 2000], true);
  const result = mergeDistributionTraining(live, artifact([0]), costs, assets, cutoffMs);
  assert.equal(result.report.addedSamples, 0);
  assert.equal(result.report.prospectiveValidationReset, false);
  assert.equal(result.report.validation.selections, 1);
  assert.deepEqual(result.state, live);
});

test("trial restart preserves three-date selected evidence on repeated historical import and resets it only for new labels", () => {
  // Synthetic evidence verifies continuity; these zero-return nonfills do not
  // establish profits, and no broker or order submission is involved.
  const profile = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL;
  const live = state([0, cutoffMs - 2000], true);
  live.selectionPolicyVersion = profile.selectionPolicyVersion;
  const decision = live.validationSelections[0]!.decision;
  decision.selectionPolicyVersion = profile.selectionPolicyVersion;
  decision.entryMode = profile.entryMode;
  decision.reason = "PAPER_TRIAL_NET_RETURN";
  decision.paperReady = true;
  for (const estimate of decision.estimates) estimate.observedDays = 3;
  assert.equal(decision.validation.ready, false);
  const original = structuredClone(live);

  const repeated = mergeDistributionTraining(live, artifact([0]), costs, assets, cutoffMs, profile);
  assert.equal(repeated.report.addedSamples, 0);
  assert.equal(repeated.report.duplicatePanels, 1);
  assert.equal(repeated.report.prospectiveValidationReset, false);
  assert.equal(repeated.report.validation.selections, 1);
  assert.equal(repeated.report.validation.ready, false);
  assert.deepEqual(repeated.state, original);
  const restarted = new DistributionController(costs, { ...assets }, profile);
  assert.equal(restarted.restoreState(repeated.state, cutoffMs), 12);
  assert.equal(restarted.stats(cutoffMs).validation.selections, 1);
  assert.deepEqual(restarted.exportState().validationSelections, original.validationSelections);

  const added = mergeDistributionTraining(live, artifact([0, S.proposalIntervalMs]), costs, assets, cutoffMs, profile);
  assert.equal(added.report.addedSamples, 6);
  assert.equal(added.report.prospectiveValidationReset, true);
  assert.equal(added.report.validation.selections, 0);
  assert.deepEqual(added.state.validationSelections, []);
  assert.equal(restarted.restoreState(added.state, cutoffMs), 18);
  assert.equal(restarted.exportState().selectionPolicyVersion, profile.selectionPolicyVersion);
  assert.equal(restarted.stats(cutoffMs).validation.selections, 0);
  assert.deepEqual(live, original, "preflight must not mutate the current trial checkpoint");
});

test("original training artifacts remain compatible after cadence changes without accepting changed model assumptions", () => {
  const prepared = artifact([0]);
  const { evaluationIntervalMs: _cadence, selectionPolicyVersion: _policy, ...legacySpec } = S;
  const legacy = { ...prepared, trainingBackfill: { ...prepared.trainingBackfill, spec: legacySpec } };
  const merged = mergeDistributionTraining(state([]), legacy, costs, assets, cutoffMs);
  assert.equal(merged.report.addedSamples, 6);
  assert.equal(merged.report.validation.ready, false);
  const previous = { ...prepared, trainingBackfill: { ...prepared.trainingBackfill,
    spec: { ...S, selectionPolicyVersion: "btc-eth-selected-policy-v2" } } };
  assert.equal(mergeDistributionTraining(state([]), previous, costs, assets, cutoffMs).report.addedSamples, 6);
  for (const spec of [{ ...legacySpec, proposalIntervalMs: 1000 }, { ...legacySpec, minimumDays: 1 },
    { ...legacySpec, featureDimension: 1 }, { ...S, evaluationIntervalMs: 500 },
    { ...previous.trainingBackfill.spec, minimumSamples: 1 }]) {
    assert.throws(() => mergeDistributionTraining(state([]), { ...legacy,
      trainingBackfill: { ...legacy.trainingBackfill, spec } }, costs, assets, cutoffMs), /PROVENANCE/);
  }
});

test("pre-recovery policy evidence clears on restart while complete historical training is preserved", () => {
  for (const [profile, previousVersion] of [
    [DISTRIBUTION_ENTRY_PROFILES.VALIDATED, "btc-eth-selected-policy-v2"],
    [DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL, "btc-eth-selected-policy-paper-trial-3d-v1"],
  ] as const) {
    const previous = state([0], true);
    previous.selectionPolicyVersion = previousVersion;
    previous.validationSelections[0]!.decision.selectionPolicyVersion = previousVersion;
    const restored = new DistributionController(costs, { ...assets }, profile);
    assert.equal(restored.restoreState(previous, cutoffMs), 6);
    assert.deepEqual(restored.exportState().samples, previous.samples);
    assert.equal(restored.stats(cutoffMs).validation.selections, 0);
    assert.equal(restored.exportState().selectionPolicyVersion, profile.selectionPolicyVersion);
  }
});

test("conflicting duplicates, partial panels, future metadata and changed execution rules reject the whole import", () => {
  const live = state([0], true), original = structuredClone(live);
  const conflict = artifact([0]); conflict.samples[0]!.features[0] = .1;
  // Keep full panel coherence, then test its conflict with the original live panel.
  for (const row of conflict.samples) row.features[0] = .1;
  assert.throws(() => mergeDistributionTraining(live, conflict, costs, assets, cutoffMs), /DUPLICATE_PANEL_CONFLICT/);
  const incomplete = artifact([S.proposalIntervalMs]); incomplete.samples.pop();
  assert.throws(() => mergeDistributionTraining(live, incomplete, costs, assets, cutoffMs), /CHECKPOINT_PANEL/);
  const future = artifact([S.proposalIntervalMs]); future.trainingBackfill.cutoffMs++;
  assert.throws(() => mergeDistributionTraining(live, future, costs, assets, cutoffMs), /PROVENANCE/);
  const changedRules = { ...assets, "BTC/USD": { ...assets["BTC/USD"]!, priceIncrement: .1 } };
  assert.throws(() => mergeDistributionTraining(live, artifact([S.proposalIntervalMs]), costs, changedRules, cutoffMs), /PROVENANCE/);
  const selected = artifact([S.proposalIntervalMs]); selected.validationSelections = state([S.proposalIntervalMs], true).validationSelections;
  assert.throws(() => mergeDistributionTraining(live, selected, costs, assets, cutoffMs), /PROVENANCE/);
  assert.deepEqual(live, original);
});

test("bounded historical import cannot displace newer live panels or reset evidence for discarded old additions", () => {
  const live = state(Array.from({ length: S.maximumSamples }, (_, i) => cutoffMs - 2000 - (S.maximumSamples - 1 - i) * S.proposalIntervalMs), true);
  const result = mergeDistributionTraining(live, artifact([0]), costs, assets, cutoffMs);
  assert.equal(result.report.addedSamples, 0);
  assert.equal(result.report.capacityDiscardedHistoricalPanels, 1);
  assert.equal(result.report.retainedSamples, S.maximumSamples * 6);
  assert.equal(result.report.validation.selections, 1);
  assert.deepEqual(result.state.samples.map(s => s.id), live.samples.map(s => s.id));
});

test("training artifact loader rejects hard links and symlinks to mutable checkpoint destinations", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "prepared.json"), hardlink = join(directory, "checkpoint.json"), alias = join(directory, "alias.json");
  const bytes = `${JSON.stringify(artifact([0]))}\n`;
  await writeFile(source, bytes); await link(source, hardlink); await symlink(source, alias);
  await assert.rejects(readDistributionTrainingArtifact(source, [hardlink]), /MUTABLE_PATH_ALIAS/);
  await assert.rejects(readDistributionTrainingArtifact(alias, [source]), /MUTABLE_PATH_ALIAS/);
  const read = await readDistributionTrainingArtifact(source, [join(directory, "independent.json")]);
  assert.equal(read.file.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("engine startup installs only verified training and an invalid later import preserves its state", () => {
  const cfg = loadConfig({ TRADING_MODE: "paper", DISTRIBUTIONAL_ENGINE_ENABLED: "true" });
  const actualCosts = Object.fromEntries(S.symbols.map(symbol => [symbol, { feeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps,
    reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]!) }]));
  const engine = new TradingEngine(cfg, { now: () => cutoffMs });
  const imported = engine.importDistributionalTraining(artifact([0], actualCosts), assets);
  assert.equal(imported.addedSamples, 6);
  const before = engine.exportDistributionalState();
  assert.throws(() => engine.importDistributionalTraining({ ...artifact([S.proposalIntervalMs], actualCosts), trainingBackfill: null }, assets), /PROVENANCE/);
  assert.deepEqual(engine.exportDistributionalState(), before);
  const internals = engine as unknown as { started: boolean }; internals.started = true;
  assert.throws(() => engine.importDistributionalTraining(artifact([0], actualCosts), assets), /before starting/);
  internals.started = false;
});
