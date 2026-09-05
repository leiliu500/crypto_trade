import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConditionalEdge } from "../src/research/conditional-edge.js";
import type { PolicyObservation } from "../src/research/policy-collector.js";
import { POLICY_VERSION } from "../src/research/trading-policy.js";

const START = Date.UTC(2026, 8, 1);
function observation(i: number, grossBps = -2): PolicyObservation {
  const at = START + i * 240_000, exitPrice = 100 * (1 + grossBps / 10_000);
  return { id: `row-${i}`, sampling: "ENTRY", configurationVersion: "test", policyVersion: POLICY_VERSION,
    symbol: "BTC/USD", policyId: "breakout-1m", family: "EARLY_BREAKOUT", side: 1, regime: "BREAKOUT_UP",
    signalAtMs: at, entryAtMs: at + 250, exitAtMs: at + 60_500, entryPrice: 100, exitPrice,
    qty: .1, filledQty: .1, signalBid: 99.99, signalAsk: 100, spreadBps: 1, feeBps: 5, reserveBps: 3,
    grossBps, netBps: grossBps - 5 * (1 + exitPrice / 100) - 3, status: "COMPLETE", reason: "POLICY_DEADLINE",
    features: { trendFastBps: 1, trendMediumBps: 2, trendSlowBps: 10, slowTrendEfficiency: .2,
      ofi: .5, tfi: .3, velocityZ: 2 } };
}
const report = (rows: PolicyObservation[]) => analyzeConditionalEdge(rows, START + 86_400_000);

test("constant fee-losing entries do not manufacture positive edge or authorize order changes", () => {
  const r = report(Array.from({ length: 40 }, (_, i) => observation(i)));
  const c = r.cohorts[0]!;
  assert.equal(c.evaluatedAttempts, 16);
  assert.equal(c.preferredAttempts, 0);
  assert.ok(c.baselineMeanNetBps! < -14);
  assert.equal(c.conditionalMeanNetBpsPerOpportunity, 0);
  assert.equal(c.preferredMeanNetBps, null);
  assert.ok(c.forecasts.every((f) => f.meanUncertaintyBps > 0 && Number.isFinite(f.conservativeScoreBps)));
  assert.equal(r.orderSubmissionChanged, false);
  assert.equal(r.deploymentReady, false);
});

test("future labels cannot change an earlier prediction or its feature normalization", () => {
  const rows = Array.from({ length: 40 }, (_, i) => observation(i, i % 2 ? 20 : -10));
  const before = report(rows.slice(0, 30)).cohorts[0]!.forecasts;
  const after = report([...rows.slice(0, 30), ...rows.slice(30).map((r, i) => ({ ...observation(i + 30, 100),
    features: { ...r.features, trendSlowBps: 1e6 } }))]).cohorts[0]!.forecasts;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.every((f) => f.trainingLastExitMs < f.signalAtMs));
});

test("positive constant outcomes remain finite with collinear features", () => {
  const c = report(Array.from({ length: 40 }, (_, i) => observation(i, 25))).cohorts[0]!;
  assert.equal(c.preferredAttempts, 16);
  assert.equal(c.positivePreferredOutcomes, 16);
  assert.ok(c.forecasts.every((f) => Math.abs(f.predictedNetBps - observation(0, 25).netBps!) < 1e-9));
});

test("invalid and duplicate labels are excluded, nonfills remain zero attempts, scopes never pool", () => {
  const rows = Array.from({ length: 30 }, (_, i) => observation(i));
  const nonfill: PolicyObservation = { ...observation(30), entryAtMs: null, entryPrice: null, exitPrice: null,
    exitAtMs: observation(30).signalAtMs + 250, filledQty: 0, netBps: 0, grossBps: 0, reason: "ENTRY_NOT_FILLED" };
  const r = report([...rows, nonfill, { ...observation(31), netBps: 999 },
    { ...observation(32), status: "PENDING" }, { ...observation(33), symbol: "ETH/USD" },
    observation(34), observation(34)]);
  assert.equal(r.excluded, 2);
  const c = r.cohorts.find((c) => c.key.includes("BTC/USD"))!;
  assert.equal(c.invalid, 1);
  assert.equal(c.pending, 1);
  assert.equal(c.validAttempts, 31);
  assert.equal(c.forecasts.at(-1)!.actualNetBps, 0);
  assert.equal(r.cohorts.find((c) => c.key.includes("ETH/USD"))!.evaluatedAttempts, 0);
});

test("overlapping quotes cannot inflate training counts", () => {
  const rows = Array.from({ length: 40 }, (_, i) => {
    const r = observation(i); const at = START + i * 1_000;
    return { ...r, signalAtMs: at, entryAtMs: at + 250, exitAtMs: at + 60_500 };
  });
  const c = report(rows).cohorts[0]!;
  assert.equal(c.nonOverlappingSamples, 1);
  assert.equal(c.evaluatedAttempts, 0);
});

test("ridge learns conditional persistence rather than assigning the unconditional mean", () => {
  const rows = Array.from({ length: 120 }, (_, i) => {
    const aligned = i % 2 ? 1 : -1;
    const row = observation(i, 13 + aligned * 25);
    return { ...row, features: { ...row.features, trendSlowBps: aligned * 20 } };
  });
  const c = report(rows).cohorts[0]!;
  assert.ok(c.preferredAttempts > 20);
  assert.equal(c.positivePreferredOutcomes, c.preferredAttempts);
  assert.ok(c.preferredMeanNetBps! > 20);
  assert.ok(c.forecasts.some((f) => !f.preferred && f.predictedNetBps < 0));
});

test("a feature outside the training domain is flagged even for a historically profitable cohort", () => {
  const rows = Array.from({ length: 25 }, (_, i) => observation(i, 25));
  rows[24]!.features.trendSlowBps = 1000;
  const f = report(rows).cohorts[0]!.forecasts[0]!;
  assert.equal(f.outOfDomain, true);
  assert.equal(f.preferred, false);
});
