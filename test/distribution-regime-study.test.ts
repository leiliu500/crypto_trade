import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRegimeProbePolicies, runRegimeAuditStudy, REGIME_STUDY_MODELS,
  type NativeActionEvidence, type PreparedRegimeProbe } from "../src/distribution/regime-study.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS,
  type DistributionOutcome, type DistributionSample } from "../src/distribution/spec.js";
import type { PredictiveAuditData } from "../src/distribution/predictive-audit-data.js";

const blocked = (): NativeActionEvidence => ({ means: [-5,-5,-5], eligible: false, supportReady: false, reason: "INSUFFICIENT_SAMPLES", scoreBps: -10 });
const ready = (mean = 10, score = 5): NativeActionEvidence => ({ means: [mean,mean,mean], eligible: true, supportReady: true,
  reason: "POSITIVE_DISTRIBUTIONAL_SCORE", scoreBps: score });
function outcomes(atMs: number, netBps: number | null = 4): DistributionOutcome[] {
  return SCENARIOS.map(s => ({ scenario: s.id, status: netBps === null ? "INVALID" : "FILLED", netBps,
    grossBps: netBps === null ? null : netBps + 13, filledFraction: 1, entryAtMs: atMs + 750,
    exitAtMs: atMs + 1_000, reason: netBps === null ? "DISCONNECT" : "DEADLINE" }));
}
function probe(symbol: string, atMs: number, eventIndex: number, outcomeIndex: number): PreparedRegimeProbe {
  return { symbol, atMs, eventIndex, features: Array(12).fill(.1),
    actions: [{ actionId: "long-5m", models: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, blocked()])) as PreparedRegimeProbe["actions"][number]["models"] }],
    outcomes: [{ actionId: "long-5m", eventIndex: outcomeIndex, outcomes: outcomes(atMs) }] };
}
function selected(result: ReturnType<typeof evaluateRegimeProbePolicies>, policy = "regime") {
  return result.selections.filter(s => s.policy === policy);
}

test("regime policy uses its own support and exact eligibility without the conditional geometry gate", () => {
  const p = probe("BTC/USD", 10_000, 1, 2); p.actions[0]!.models.regime = ready();
  const result = evaluateRegimeProbePolicies([p]);
  assert.equal(selected(result).length, 1); assert.equal(selected(result, "conditional").length, 0);
  assert.equal(selected(result, "long-15m").length, 0);
});

test("global portfolio slot waits for outcome receipt even when its future exit timestamp would permit entry", () => {
  const first = probe("BTC/USD", 10_000, 1, 30), unavailable = probe("ETH/USD", 20_000, 20, 35), later = probe("ETH/USD", 30_000, 40, 45);
  for (const p of [first,unavailable,later]) p.actions[0]!.models.regime = ready();
  const result = evaluateRegimeProbePolicies([first,unavailable,later]);
  assert.deepEqual(selected(result).map(r => r.eventIndex), [1,40]);
});

test("unknown selected path stays unknown and releases the hypothetical slot only on its terminal receipt", () => {
  const first = probe("BTC/USD", 10_000, 1, 30), blockedDuringUnknown = probe("ETH/USD", 20_000, 20, 35), after = probe("BTC/USD", 30_000, 40, 50);
  for (const p of [first,blockedDuringUnknown,after]) p.actions[0]!.models.regime = ready();
  first.outcomes[0]!.outcomes = outcomes(first.atMs, null); after.outcomes[0]!.outcomes = outcomes(after.atMs, 7);
  const result = evaluateRegimeProbePolicies([first,blockedDuringUnknown,after]);
  assert.deepEqual(selected(result).map(r => r.eventIndex), [1,40]);
  const row = result.aggregates.find(r => r.policy === "regime" && r.scenario === "base-250ms")!;
  assert.equal(row.selections, 2); assert.equal(row.unknown, 1); assert.equal(row.filled, 1);
  assert.equal(row.knownNetBpsSum, 7); assert.equal(row.fullPathKnownNetBpsSum, null);
});

test("positive-mean diagnostic remains separate from the unchanged robustness-score policy", () => {
  const p = probe("BTC/USD", 10_000, 1, 2);
  p.actions[0]!.models.regime = { ...ready(), eligible: false, scoreBps: -1, reason: "SCORE_BELOW_MINIMUM" };
  const result = evaluateRegimeProbePolicies([p]);
  assert.equal(selected(result).length, 0); assert.equal(selected(result, "regime-mean-diagnostic").length, 1);
});

test("native policy ranks by robustness score while the mean diagnostic ranks by mean", () => {
  const p = probe("BTC/USD", 10_000, 1, 2); p.actions[0]!.models.regime = ready(20,3);
  p.actions.push({ actionId: "short-15m", models: { ...structuredClone(p.actions[0]!.models), regime: ready(10,5) } });
  p.outcomes.push({ actionId: "short-15m", eventIndex: 3, outcomes: outcomes(p.atMs, -8) });
  const result = evaluateRegimeProbePolicies([p]);
  assert.equal(selected(result)[0]!.actionId, "short-15m"); assert.equal(selected(result, "regime-mean-diagnostic")[0]!.actionId, "long-5m");
  p.outcomes.reverse(); for (const row of p.outcomes) for (const o of row.outcomes) { o.netBps = 999; o.grossBps = 1012; }
  assert.deepEqual(evaluateRegimeProbePolicies([p]).selections, result.selections);
});

test("missing, duplicate, preceding, and malformed unknown outcomes cannot silently become flat outcomes", () => {
  const p = probe("BTC/USD", 10_000, 1, 2); p.actions[0]!.models.regime = ready();
  assert.throws(() => evaluateRegimeProbePolicies([{ ...p, outcomes: [] }]), /MISSING_SELECTED_OUTCOME/);
  assert.throws(() => evaluateRegimeProbePolicies([{ ...p, outcomes: [{ ...p.outcomes[0]!, eventIndex: 1 }] }]), /DUPLICATE_EVENT_INDEX/);
  assert.throws(() => evaluateRegimeProbePolicies([{ ...p, outcomes: [{ ...p.outcomes[0]!, eventIndex: 0 }] }]), /OUTCOME_BEFORE_FORECAST/);
  p.outcomes[0]!.outcomes = outcomes(p.atMs, null); p.outcomes[0]!.outcomes[0]!.netBps = 0;
  assert.throws(() => evaluateRegimeProbePolicies([p]), /UNKNOWN_RETURN/);
});

function syntheticDataset(): PredictiveAuditData {
  const cutoffMs = Date.parse("2026-09-08T00:00:00Z"), samples: DistributionSample[] = [];
  for (let day = 1; day <= 3; day++) for (let i = 0; i < 32; i++) {
    const signalAtMs = cutoffMs - day * 86_400_000 + i * 60_000, gross = i % 2 ? 30 : -30;
    const features = Array(12).fill(0); features[0] = i % 2 ? .5 : -.5;
    samples.push({ id: `BTC/USD:long-5m:${signalAtMs}`, symbol: "BTC/USD", actionId: "long-5m", signalAtMs,
      completedAtMs: signalAtMs + 1_000, features, outcomes: outcomes(signalAtMs, gross - 13) });
  }
  samples.sort((a,b) => a.signalAtMs-b.signalAtMs);
  const atMs = cutoffMs + 60_000, features = Array(12).fill(0); features[0] = .5;
  const model = new ConditionalDistributionModel(); for (const s of samples) assert.ok(model.observe(s));
  const predictions = ACTIONS.map(a => ({ actionId: a.id, forecast: model.predictScenarios("BTC/USD",a.id,features,atMs).map(p => ({
    scenario: p.scenario, current: p.meanNetBps, efficient: p.meanNetBps, unconditionalCurrent: null, unconditionalEfficient: null,
    currentEligible: false, efficientEligible: false, currentSamples: p.samples, efficientSamples: p.samples,
    currentEffectiveSamples: p.effectiveSamples, efficientEffectiveSamples: p.effectiveSamples })) }));
  const file = { path: "fixture", sha256: "0".repeat(64) };
  return { source: { mode: "DEVELOPMENT", startMs: cutoffMs, endMs: cutoffMs + 4_000_000, untouched: false,
    costs: { "BTC/USD": {feeBps:5,reserveBps:3}, "ETH/USD": {feeBps:5,reserveBps:3} },
    assets: Object.fromEntries(["BTC/USD","ETH/USD"].map(symbol => [symbol,{symbol,minOrderSize:.001,minTradeIncrement:.001,priceIncrement:.1,maximumOrderQty:100,shortable:true}])),
    sourceHashes: {}, report: file, audit: {...file,records:8,finalHash:file.sha256}, seed: {...file,samples:samples.length},
    protocol: {...file,createdAtMs:cutoffMs+5_000_000}, rawInputs: [], rawInputsRehashed:false },
    freezes: [{cutoffMs,samples,sha256:file.sha256}], probes: [{symbol:"BTC/USD",atMs,features,eventIndex:1,predictions,
      outcomes:ACTIONS.map((a,i)=>({actionId:a.id,eventIndex:i+2,outcomes:outcomes(atMs,a.id==="long-5m"?17:-13)}))}] };
}

test("regime study reports native-support changes, paired errors, and oracle counts on frozen synthetic labels", () => {
  const data = syntheticDataset(), result = runRegimeAuditStudy(data);
  const c = result.opportunities.find(r => r.symbol === "BTC/USD" && r.model === "conditional")!;
  const r = result.opportunities.find(r => r.symbol === "BTC/USD" && r.model === "regime")!;
  assert.equal(c.eligible,0); assert.equal(r.eligible,1); assert.equal(r.knownRobustWinners,1);
  assert.equal(r.eligibleKnownRobustPrecision,1); assert.equal(r.knownRobustRecall,1);
  assert.equal(result.policy.selections.filter(s=>s.policy==="regime").length,1);
  const metric = result.predictions.find(r=>r.symbol==="BTC/USD"&&r.scenario==="base-250ms")!;
  assert.equal(metric.actionPaths,6); assert.equal(metric.commonActionPaths,1); assert.equal(metric.commonAssetOrigins,1);
  assert.equal(metric.grossPrediction.regime.count,1);
  assert.equal(result.profitabilityEstablished,false); assert.equal(result.deploymentReady,false);
});

test("regime study rejects labels completed at the freeze cutoff", () => {
  const data = syntheticDataset(); data.freezes[0]!.samples[0]!.completedAtMs = data.freezes[0]!.cutoffMs;
  assert.throws(()=>runRegimeAuditStudy(data),/FUTURE_TRAINING/);
});
