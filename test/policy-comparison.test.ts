import assert from "node:assert/strict";
import test from "node:test";
import { comparePolicyExits } from "../src/research/policy-comparison.js";
import type { PolicyObservation } from "../src/research/policy-collector.js";
import { EPISODE_VERSION, EXECUTION_SCENARIOS, type EpisodeObservation } from "../src/research/execution-stress.js";
import { POLICY_VERSION, TRADING_POLICIES } from "../src/research/trading-policy.js";

const DAY = 86_400_000, now = 20 * DAY;
function opportunity(at: number, fraction = 1, longerGrossBps = 20): PolicyObservation[] {
  return TRADING_POLICIES.filter((p) => p.family === "BREAKOUT_RETEST").map((p) => {
    const gross = p.horizonMs === 60_000 ? 10 : longerGrossBps, exitPrice = 100 * (1 + gross / 10_000);
    return { id: `${at}-${p.id}`, configurationVersion: "test", policyVersion: POLICY_VERSION,
      sampling: "ENTRY", executionSource: "OBSERVED_PAPER", entryClientOrderId: `entry-${at}`, decisionAtMs: at,
      symbol: "BTC/USD", side: 1, family: p.family, regime: "RETEST_UP", policyId: p.id,
      signalAtMs: at, signalBid: 99.99, signalAsk: 100, spreadBps: 1,
      qty: 1, filledQty: fraction, entryAtMs: fraction ? at + 250 : null, entryPrice: fraction ? 100 : null,
      exitPrice: fraction ? exitPrice : null, exitAtMs: at + 250 + (fraction ? p.horizonMs : 0),
      feeBps: 5, reserveBps: 3, grossBps: fraction * gross,
      netBps: fraction * (gross - 5 * (1 + exitPrice / 100) - 3), status: "COMPLETE",
      reason: fraction ? "POLICY_DEADLINE" : "ENTRY_NOT_FILLED", features: {} };
  });
}

test("all exit policies use identical entry panels, including nonfills and partial fills", () => {
  const report = comparePolicyExits([...opportunity(DAY, .5), ...opportunity(2 * DAY, 0)], now);
  const c = report.cohorts[0]!;
  assert.equal(c.completePairs, 2);
  const short = c.policies[0]!.allPairs, long = c.policies[1]!.allPairs;
  assert.equal(short.filled, 1); assert.equal(short.partialFills, 1); assert.equal(short.unfilled, 1);
  assert.ok(Math.abs(short.meanNetBpsPerAttempt! - (-3.005 / 4)) < 1e-8);
  assert.ok(Math.abs(short.meanNetBpsPerFill! - (-3.005)) < 1e-8);
  assert.ok(Math.abs(long.meanDeltaVsBaselineBps! - 9.995 / 4) < 1e-8);
  assert.equal(short.lower95NetBps, null);
  assert.equal(report.deploymentReady, false);
});

test("missing, duplicate, pending and corrupt outcomes exclude the entire entry, including shorter exits", () => {
  const missing = opportunity(DAY).slice(0, 3), duplicate = opportunity(2 * DAY);
  duplicate.push({ ...duplicate[0]!, id: "duplicate" });
  const pending = opportunity(3 * DAY); pending[3]!.status = "PENDING";
  const corrupt = opportunity(4 * DAY); corrupt[2]!.netBps = 500;
  const c = comparePolicyExits([...missing, ...duplicate, ...pending, ...corrupt, ...opportunity(5 * DAY)], now).cohorts[0]!;
  assert.equal(c.opportunities, 5); assert.equal(c.completePairs, 1);
  assert.deepEqual(c.exclusions, { missingOrDuplicatePolicies: 2, invalidOrPendingOutcomes: 2, entryMismatch: 0 });
  assert.ok(c.policies.every((p) => p.allPairs.attempts === 1));
});

test("different valid entry quantities and frozen structure cannot be paired", () => {
  const quantity = opportunity(DAY); quantity[2]!.qty = 2; quantity[2]!.filledQty = 2;
  const structure = opportunity(2 * DAY); structure[1]!.features = { invalidationPx: 99 };
  const c = comparePolicyExits([...quantity, ...structure], now).cohorts[0]!;
  assert.equal(c.completePairs, 0); assert.equal(c.exclusions.entryMismatch, 2);
  assert.equal(c.policies[0]!.allPairs.meanNetBpsPerAttempt, null);
});

test("non-overlap is shared by all horizons and invalid earlier paths reserve their interval", () => {
  const invalid = opportunity(DAY); invalid[3]!.status = "INVALID";
  const c = comparePolicyExits([...invalid, ...opportunity(DAY + 60_000), ...opportunity(DAY + 3_600_000)], now).cohorts[0]!;
  assert.equal(c.completePairs, 2); assert.equal(c.nonOverlappingPairs, 1);
  assert.ok(c.policies.every((p) => p.nonOverlappingPairs.attempts === 1));
});

function episode(at: number, scenarioIndex = 0, hypothesisId = "breakout-retest"): EpisodeObservation[] {
  return opportunity(at).map(({ executionSource, entryClientOrderId, decisionAtMs, ...o }) => ({ ...o,
    sampling: "EPISODE", policyVersion: EPISODE_VERSION, episodeId: `episode-${at}`, hypothesisId,
    scenario: EXECUTION_SCENARIOS[scenarioIndex]!, context: { healthAllowed: true, healthReasons: [],
      liquidityPass: true, liquidityReasons: [], positionOpen: false, pendingOrder: false,
      cooldownRemainingMs: 0, sizing: "VENUE_NOTIONAL_ONLY" } }));
}

test("observed entries, hypotheses and execution scenarios stay separate; unknown scenarios are excluded", () => {
  const unknown = episode(5 * DAY).map((o) => ({ ...o, scenario: { ...o.scenario, latencyMs: 999 } }));
  const report = comparePolicyExits([...opportunity(DAY), ...episode(DAY), ...episode(2 * DAY, 1),
    ...episode(3 * DAY, 0, "breakout-retest-5m"), ...unknown], now);
  assert.equal(report.cohorts.length, 4); assert.equal(report.excludedObservations, 4);
  assert.ok(report.cohorts.every((c) => c.opportunities === 1));
  const unhealthy = episode(DAY); unhealthy[0]!.context.healthAllowed = false;
  assert.equal(comparePolicyExits(unhealthy, now).cohorts[0]!.completePairs, 0);
});

test("a less negative alternative is reported as a loss and never authorized", () => {
  const rows = Array.from({ length: 8 }, (_, i) => opportunity((i + 1) * DAY, 1, 12)).flat();
  const r = comparePolicyExits(rows, now), p = r.cohorts[0]!.policies[1]!.nonOverlappingPairs;
  assert.ok(p.meanDeltaVsBaselineBps! > 0); assert.ok(p.lower95DeltaVsBaselineBps! > 0);
  assert.ok(p.meanNetBpsPerAttempt! < 0); assert.ok(p.lower95NetBps! < 0);
  assert.equal(r.deploymentReady, false);
});

test("future outcomes cannot leak into an earlier comparison", () => {
  const r = comparePolicyExits([...opportunity(DAY), ...opportunity(3 * DAY)], DAY + 120_000);
  assert.equal(r.excludedObservations, 4); assert.equal(r.cohorts[0]!.completePairs, 0);
});
