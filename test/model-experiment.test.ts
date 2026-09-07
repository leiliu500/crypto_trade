import assert from "node:assert/strict";
import test from "node:test";
import { CrossAssetModel, CROSS_ASSET_RESEARCH_VARIANTS, crossAssetPaperCandidate,
  type CrossAssetQuote, type CrossAssetTrainingLabel } from "../src/research/cross-asset-model.js";
import { replayCrossAsset } from "../src/research/cross-asset-replay.js";
import { compareModelExperiments } from "../src/research/model-experiment.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
function* quotes(hours: number, outageMs = -1): Generator<CrossAssetQuote> {
  for (let atMs = 0; atMs <= hours * 3_600_000; atMs += 4000) for (const symbol of ["BTC/USD", "ETH/USD"]) {
    const mid = (symbol === "BTC/USD" ? 100 : 50) * Math.exp(atMs / 60_000 * .1 / 10_000);
    yield { symbol, atMs, bid: mid * .99995, ask: mid * 1.00005, valid: atMs !== outageMs };
  }
}

test("endpoint research learns frozen return targets through intermediate invalid quotes; production still discards them", () => {
  const originMs = (7 * 60 + 15) * 60_000, outageMs = (7 * 60 + 20) * 60_000 + 4000;
  const labels: CrossAssetTrainingLabel[] = [];
  const production = new CrossAssetModel(costs), research = new CrossAssetModel(costs, "endpoint-15m", l => labels.push(l));
  for (const q of quotes(8, outageMs)) { production.observe(q); research.observe(q); }
  assert.equal(production.stats().labelsPerSymbol, 27);
  assert.equal(research.stats().labelsPerSymbol, 28);
  assert.equal(production.stats().invalidLabelPairs, 1); assert.equal(research.stats().invalidLabelPairs, 0);
  const recovered = labels.filter(l => l.startMs === originMs);
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every(l => l.endMs === originMs + 900_000));
  assert.ok(recovered.every(l => Math.abs(l.actualGrossBps - Math.expm1(15 * .1 / 10000) * 10000) < 1e-8));
});

test("research labels expire with a missing endpoint and quote reversal discards the pending origin", () => {
  const endMs = 8 * 3_600_000;
  for (const failure of ["MISSING_ENDPOINT", "REVERSED_TIME"] as const) {
    const model = new CrossAssetModel(costs, "endpoint-15m");
    for (const q of quotes(8)) model.observe(q);
    if (failure === "MISSING_ENDPOINT") {
      model.invalidate(endMs + 900_000 + 90_001);
      assert.equal(model.stats().priceHistoryReady, false);
    } else {
      const q = { symbol: "BTC/USD", bid: 100, ask: 101, valid: true };
      model.observe({ ...q, atMs: endMs + 1000 });
      model.observe({ ...q, atMs: endMs + 500 });
    }
    assert.equal(model.stats().labelsPerSymbol, 28);
    assert.equal(model.stats().invalidLabelPairs, 1);
  }
});

test("research horizons and identities cannot authorize production model orders", () => {
  for (const variant of Object.keys(CROSS_ASSET_RESEARCH_VARIANTS) as Array<keyof typeof CROSS_ASSET_RESEARCH_VARIANTS>) {
    const model = new CrossAssetModel(costs, variant);
    let latest = [] as ReturnType<CrossAssetModel["observe"]>;
    for (const q of quotes(8)) { const f = model.observe(q); if (f.length) latest = f; }
    assert.equal(model.stats().labelsPerSymbol, variant === "endpoint-15m" ? 28 : variant === "endpoint-30m" ? 14 : 7);
    assert.ok(latest.every(f => f.version === CROSS_ASSET_RESEARCH_VARIANTS[variant].version && f.horizonMs === model.horizonMs));
    for (const f of latest) {
      assert.equal(crossAssetPaperCandidate(f, f.symbol, f.atMs, true), null);
      assert.equal(crossAssetPaperCandidate({ ...f, trainingLabels: 100, side: 1, predictedGrossBps: 100,
        conservativeNetBps: 100 - 2 * f.parameterUncertaintyBps - .1 * f.predictiveStdBps - f.costHurdleBps,
        eligible: true, reason: "POSITIVE_RESEARCH_FORECAST" }, f.symbol, f.atMs, true), null);
    }
  }
  assert.throws(() => new CrossAssetModel(costs, "bad" as never), /INVALID_RESEARCH_VARIANT/);
});

test("future quotes cannot rewrite endpoint-model forecasts or completed-label diagnostics", () => {
  const prefixLabels: CrossAssetTrainingLabel[] = [], fullLabels: CrossAssetTrainingLabel[] = [];
  const prefix = new CrossAssetModel(costs, "endpoint-15m", l => prefixLabels.push(l));
  const full = new CrossAssetModel(costs, "endpoint-15m", l => fullLabels.push(l));
  let a = [] as ReturnType<CrossAssetModel["observe"]>, b = a;
  const cutoff = 8 * 3_600_000, outage = 7 * 3_600_000 + 1_204_000;
  for (const q of quotes(8, outage)) { const f = prefix.observe(q); if (f.length) a = f; }
  for (const q of quotes(9, outage)) { const f = full.observe(q); if (f.length && q.atMs <= cutoff) b = f; }
  assert.deepEqual(a, b); assert.deepEqual(prefixLabels, fullLabels.filter(l => l.endMs <= cutoff));
});

test("model experiments require chronological boundaries and enough separation for every holding horizon", async () => {
  await assert.rejects(compareModelExperiments(() => [], costs, 10, 5), /INVALID_EXPERIMENT_BOUNDARIES/);
  await assert.rejects(replayCrossAsset([], costs, { researchVariant: "endpoint-60m", paperEvaluation: true }), /INTERVAL_TOO_SHORT/);
  await assert.rejects(replayCrossAsset([], costs, { researchVariant: "endpoint-15m" }), /REQUIRES_EVALUATION/);
  const report = await compareModelExperiments(() => [], costs, 0, 86_400_000);
  assert.equal(report.experiments.length, 4); assert.equal(report.commonCompleteOpportunities, 0);
  assert.equal(report.deploymentReady, false); assert.equal(report.orderSubmissionChanged, false);
  assert.ok(report.comparison.every(r => r.meanNetBpsPerOriginalAttempt === null));
});

test("model comparisons purge boundary-crossing and missing execution paths jointly across every horizon", async t => {
  t.mock.method(CrossAssetModel.prototype, "observe", function(this: CrossAssetModel, q: CrossAssetQuote) {
    return [{ version: this.version, symbol: "BTC/USD", atMs: q.atMs, horizonMs: this.horizonMs,
      trainingLabels: 40, trainedThroughMs: q.atMs - 100, referenceMid: 100, side: 1,
      predictedGrossBps: 1, parameterUncertaintyBps: 2, predictiveStdBps: 20, costHurdleBps: 14,
      conservativeNetBps: -19, eligible: false, reason: "COST_OR_UNCERTAINTY", factorBeta: 1, expertWeights: { trend: 1 } }];
  });
  function* path(gap = false): Generator<CrossAssetQuote> {
    for (let atMs = 0; atMs <= 3_610_000; atMs += 1000) {
      yield { symbol: "BTC/USD", atMs, bid: 99.995, ask: 100.005, valid: !gap || atMs !== 1_000_000 };
    }
  }
  const crossed = await compareModelExperiments(() => path(), costs, 0, 1_800_000);
  assert.equal(crossed.commonCompleteOpportunities, 1);
  assert.equal(crossed.boundaryPurgedOpportunities, 1);
  assert.ok(crossed.comparison.every(r => r.panelAttempts === 0), "a shorter exit cannot keep a purged longer-horizon opportunity");
  const complete = await compareModelExperiments(() => path(), costs, 0, 3_620_000);
  assert.ok(complete.comparison.filter(r => r.symbol === "BTC/USD" && r.period === "VALIDATION")
    .every(r => r.panelAttempts === 1));
  const missing = await compareModelExperiments(() => path(true), costs, 0, 3_620_000);
  assert.equal(missing.commonCompleteOpportunities, 0);
  assert.ok(missing.experiments.some(e => e.report.outcomes.some(o => o.status === "INVALID")),
    "endpoint label experiments must not treat a missing execution path as a valid trade");
});
