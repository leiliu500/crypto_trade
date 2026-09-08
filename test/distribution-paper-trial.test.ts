import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import type { TradingEngine } from "../src/engine/trading-engine.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionCheckpoint } from "../src/distribution/checkpoint.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { buildDistributionPlan, executableDistributionDecision } from "../src/distribution/planner.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_ENTRY_PROFILES,
  distributionEntryProfile, type DistributionEntryProfile, type DistributionSample, type DistributionDecision } from "../src/distribution/spec.js";
import { policyReserveBps } from "../src/research/policy-planner.js";

const DAY = 86_400_000, ORIGIN = Date.UTC(2026, 7, 1);
const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", DISTRIBUTIONAL_ENGINE_ENABLED: "true",
  DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "true", CONTINUOUS_RECORDING_ENABLED: "false" });
const costs = Object.fromEntries(S.symbols.map(symbol => [symbol, { feeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps,
  reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]!) }]));
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001, maximumOrderQty: 100, shortable: true,
}]));
const TRIAL = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL, VALIDATED = DISTRIBUTION_ENTRY_PROFILES.VALIDATED;
const book = (atMs: number, mid = 100, symbol = "BTC/USD"): BookState => ({ symbol,
  bids: [{ px: mid - .005, qty: 100 }], asks: [{ px: mid + .005, qty: 100 }],
  receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs), sourceReset: true, valid: true });
// Synthetic fixed labels exercise authorization; they are not historical-profit evidence.
function sample(atMs: number, actionId = "long-5m", netBps = 60): DistributionSample {
  return { id: `BTC/USD:${actionId}:${atMs}`, symbol: "BTC/USD", actionId, signalAtMs: atMs,
    completedAtMs: atMs + 2000, features: Array<number>(12).fill(0), outcomes: DISTRIBUTION_SCENARIOS.map(s => ({
      scenario: s.id, status: "FILLED", netBps, grossBps: netBps + 20, filledFraction: 1,
      entryAtMs: atMs + s.latencyMs, exitAtMs: atMs + 2000, reason: "FIXTURE_OBSERVED_OUTCOME",
    })) };
}
function trainingState(days = 3, perDay = 16, profitable = true) {
  const state = new DistributionController(costs, { ...assets }).exportState();
  for (let day = 0; day < days; day++) for (let index = 0; index < perDay; index++) {
    const atMs = ORIGIN + day * DAY + index * S.proposalIntervalMs;
    state.samples.push(...DISTRIBUTION_ACTIONS.map(a => sample(atMs, a.id, profitable && a.id === "long-5m" ? 60 : -30)));
  }
  return state;
}
function start(t: TestContext, profile: Readonly<DistributionEntryProfile> = TRIAL, state = trainingState()) {
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => ({ symbol: b.symbol, atMs: b.receiveTsMs,
    ready: true, reason: "READY", features: Array<number>(12).fill(0) }));
  const controller = new DistributionController(costs, { ...assets }, profile);
  const nowMs = Math.max(...state.samples.map(s => s.completedAtMs)) + 1000;
  controller.restoreState(state, nowMs - 1000);
  const quote = book(nowMs), result = controller.onBook(quote);
  assert.ok(result.decision);
  return { controller, nowMs, quote, decision: result.decision, state };
}
function planInput(quote: BookState, decision: DistributionDecision) {
  const mid = (quote.bids[0]!.px + quote.asks[0]!.px) / 2;
  // Only the fields consumed by the distribution planner/cost estimator are needed.
  const features = { symbol: quote.symbol, receiveTsMs: quote.receiveTsMs, mid, spreadBps: 1,
    sigmaHBps: 1, velocityZ: 0, stale: false } as DeterministicFeatures;
  return { config: cfg.symbolConfigs[quote.symbol]!, book: quote, features, asset: assets[quote.symbol]!, decision,
    paperAllowed: true, equity: 100_000, equityHighWater: 100_000, nowMs: quote.receiveTsMs };
}
function finishSelection(controller: DistributionController, atMs: number) {
  for (const delta of [250, 750]) controller.onBook(book(atMs + delta));
  for (const delta of [1000, 1250, 1750]) controller.onBook(book(atMs + delta, 101));
}
function fakeEngine(controller: DistributionController, cutoffMs: number) {
  return { exportDistributionalState: () => controller.exportState(),
    restoreDistributionalState: (state: unknown) => controller.restoreState(state, cutoffMs),
    invalidateDistributionalValidation: () => controller.invalidateValidation(),
  } as unknown as TradingEngine;
}

test("three-date trial uses the actual conditional model and can plan paper entry before validation is ready", t => {
  const jointState = trainingState();
  jointState.samples.push(...jointState.samples.map(s => ({ ...structuredClone(s), symbol: "ETH/USD",
    id: `ETH/USD:${s.actionId}:${s.signalAtMs}` })));
  const { controller, quote, decision } = start(t, TRIAL, jointState);
  const chosen = decision.estimates.find(e => e.actionId === decision.actionId)!;
  assert.equal(chosen.observedDays, 3); assert.equal(chosen.samples, 48);
  assert.ok(chosen.effectiveSamples >= 32); assert.ok(chosen.scoreBps! > S.minimumScoreBps);
  assert.equal(decision.entryMode, "PAPER_TRIAL"); assert.equal(decision.reason, "PAPER_TRIAL_NET_RETURN");
  assert.equal(decision.paperReady, true);
  assert.deepEqual(decision.validation, { selections: 0, observedDays: 0, lowerNetBps: null, ready: false });
  assert.equal(controller.stats(quote.receiveTsMs).minimumTrainingDays, 3);
  assert.equal(controller.stats(quote.receiveTsMs).minimumValidationDays, 7);
  assert.equal(controller.stats(quote.receiveTsMs).evaluationIntervalMs, 1000);
  const input = planInput(quote, decision);
  const allowed = buildDistributionPlan({ ...input, profile: TRIAL });
  assert.ok(allowed.plan, allowed.reason); assert.equal(allowed.reason, "DISTRIBUTION_PAPER_TRIAL");
  assert.equal(allowed.plan.distributionDecision!.validation.ready, false);
  assert.ok(allowed.plan.qty * allowed.plan.limitPx <= S.maximumNotional);
  assert.equal(buildDistributionPlan(input).plan, null, "the default policy cannot accept a trial decision");
  assert.equal(buildDistributionPlan({ ...input, profile: TRIAL, paperAllowed: false }).plan, null);
  const peer = controller.onBook(book(quote.receiveTsMs + 1, 100, "ETH/USD")).decision!;
  assert.ok(peer.estimates.some(e => e.eligible), "the peer also has qualifying positive model evidence");
  assert.equal(peer.actionId, null, "trial preserves the shared BTC/ETH selected slot");
  assert.equal(peer.reason, "PORTFOLIO_RESEARCH_SLOT");
});

test("default policy retains seven training dates and selected validation requirements", t => {
  const early = start(t, VALIDATED);
  assert.equal(early.decision.actionId, null); assert.equal(early.decision.reason, "INSUFFICIENT_DAYS");
  assert.equal(early.decision.paperReady, false);
  const mature = start(t, VALIDATED, trainingState(7));
  assert.equal(mature.decision.actionId, "long-5m"); assert.equal(mature.decision.reason, "PROSPECTIVE_VALIDATION");
  assert.equal(mature.decision.paperReady, false); assert.equal(mature.decision.validation.ready, false);
});

test("trial retains the positive stressed score, local sample and qualifying-date gates", t => {
  const losing = start(t, TRIAL, trainingState(3, 16, false));
  assert.equal(losing.decision.actionId, null); assert.equal(losing.decision.reason, "SCORE_BELOW_MINIMUM");
  const twoDates = start(t, TRIAL, trainingState(2, 24));
  assert.equal(twoDates.decision.actionId, null); assert.equal(twoDates.decision.reason, "INSUFFICIENT_DAYS");
  const tooFew = trainingState(); tooFew.samples.splice(-6);
  const sparse = start(t, TRIAL, tooFew);
  assert.equal(sparse.decision.actionId, null); assert.equal(sparse.decision.reason, "INSUFFICIENT_SAMPLES");
});

test("trial retains 32 effective samples and rejects unsupported minimum-date overrides", () => {
  const model = new ConditionalDistributionModel();
  for (let day = 0; day < 30; day++) assert.ok(model.observe(sample(ORIGIN + day * DAY)));
  for (let day = 43; day <= 45; day++) for (let index = 0; index < 6; index++) {
    assert.ok(model.observe(sample(ORIGIN + day * DAY + index * S.proposalIntervalMs)));
  }
  const nowMs = ORIGIN + 45 * DAY + 5 * S.proposalIntervalMs + 3000;
  const estimate = model.estimate("BTC/USD", "long-5m", Array<number>(12).fill(0), nowMs, 3);
  assert.equal(estimate.samples, 48); assert.equal(estimate.observedDays, 3); assert.ok(estimate.effectiveSamples < 32);
  assert.equal(estimate.reason, "INSUFFICIENT_EFFECTIVE_SAMPLES"); assert.equal(estimate.eligible, false);
  assert.equal(model.estimate("BTC/USD", "long-5m", Array<number>(12).fill(0), nowMs, 1).reason, "INVALID_ESTIMATE_INPUT");
});

test("trial permission cannot be forged through a decision or a modified entry profile", t => {
  const { quote, decision } = start(t);
  assert.ok(executableDistributionDecision(decision, quote, quote.receiveTsMs, TRIAL));
  const corruptions: Array<(d: DistributionDecision) => void> = [
    d => { d.selectionPolicyVersion = S.selectionPolicyVersion; }, d => { d.entryMode = "VALIDATED"; },
    d => { delete d.entryMode; }, d => { d.reason = "VALIDATED_NET_RETURN"; },
    d => { d.validation.ready = true; }, d => { d.validation.observedDays = 7; },
    d => { d.requestedQty = 1; }, d => { d.paperReady = false; },
    d => { d.estimates.find(e => e.actionId === d.actionId)!.observedDays = 2; },
    d => { d.estimates.find(e => e.actionId === d.actionId)!.effectiveSamples = 31; },
    d => { d.estimates.find(e => e.actionId === d.actionId)!.scoreBps = -1; },
  ];
  for (const mutate of corruptions) {
    const bad = structuredClone(decision); mutate(bad);
    assert.equal(executableDistributionDecision(bad, quote, quote.receiveTsMs, TRIAL), null, mutate.toString());
  }
  assert.equal(executableDistributionDecision(decision, quote, quote.receiveTsMs + 1001, TRIAL), null);
  assert.equal(executableDistributionDecision(decision, quote, quote.receiveTsMs, { ...TRIAL, minimumTrainingDays: 1 }), null);
  assert.throws(() => new DistributionController(costs, assets, { ...VALIDATED, requiresProspectiveValidation: false }), /ENTRY_PROFILE/);
  assert.equal(distributionEntryProfile(), VALIDATED); assert.equal(distributionEntryProfile(true), TRIAL);
  assert.equal(S.minimumDays, 7, "historical training specification is unchanged");
});

test("trial checkpoint restores truthful selected outcomes and clears them when switching policy", t => {
  const { controller, nowMs, state } = start(t); finishSelection(controller, nowMs);
  const saved = controller.exportState();
  assert.equal(saved.validationSelections.length, 1); assert.deepEqual(saved.samples, state.samples);
  assert.equal(saved.validationSelections[0]!.decision.validation.ready, false);
  assert.equal(saved.validationSelections[0]!.decision.paperReady, true);
  const trial = new DistributionController(costs, assets, TRIAL);
  assert.equal(trial.restoreState(saved, nowMs + 2000), state.samples.length);
  assert.equal(trial.stats(nowMs + 2000).validation.selections, 1);
  assert.equal(trial.stats(nowMs + 2000).validation.ready, false);
  const standard = new DistributionController(costs, assets, VALIDATED);
  assert.equal(standard.restoreState(saved, nowMs + 2000), state.samples.length);
  assert.equal(standard.stats(nowMs + 2000).validation.selections, 0);
  assert.deepEqual(standard.exportState().samples, state.samples);
  const malformed = structuredClone(saved); malformed.validationSelections[0]!.decision.validation.ready = true;
  assert.throws(() => trial.restoreState(malformed, nowMs + 2000), /VALIDATION/);
});

test("trial checkpoint journal resolves only a completed outcome from the active trial policy", async t => {
  const { controller, nowMs, decision } = start(t); finishSelection(controller, nowMs);
  const directory = mkdtempSync(join(tmpdir(), "distribution-paper-trial-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json"), errors: unknown[] = [];
  const checkpoint = new DistributionCheckpoint(path, fakeEngine(controller, nowMs + 2000), error => errors.push(error));
  checkpoint.markPending(decision); checkpoint.save(); await checkpoint.flush();
  const restored = new DistributionController(costs, assets, TRIAL);
  await new DistributionCheckpoint(path, fakeEngine(restored, nowMs + 2000), error => errors.push(error)).restore();
  assert.equal(restored.stats(nowMs + 2000).validation.selections, 1);
  writeFileSync(`${path}.pending`, JSON.stringify({ symbol: decision.symbol, actionId: decision.actionId, atMs: decision.atMs,
    selectionPolicyVersion: VALIDATED.selectionPolicyVersion }));
  await new DistributionCheckpoint(path, fakeEngine(restored, nowMs + 2000), error => errors.push(error)).restore();
  assert.equal(restored.stats(nowMs + 2000).validation.selections, 0);
  assert.deepEqual(errors, []);
});
