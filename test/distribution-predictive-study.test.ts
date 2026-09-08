import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProbePolicies, PREDICTIVE_MODELS, type PreparedProbe } from "../src/distribution/predictive-study.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS } from "../src/distribution/spec.js";

function probe(symbol: string, atMs: number, eventIndex: number, outcomeIndex: number, net = 7): PreparedProbe {
  return { symbol, atMs, eventIndex, features: Array<number>(12).fill(.1),
    actions: ACTIONS.map(action => ({ actionId: action.id, supportReady: true,
      means: Object.fromEntries(PREDICTIVE_MODELS.map(model => [model,
        SCENARIOS.map(() => action.id === "long-5m" ? 5 : -5)])) as PreparedProbe["actions"][number]["means"] })),
    outcomes: ACTIONS.map((action, index) => ({ actionId: action.id, eventIndex: outcomeIndex + index,
      outcomes: SCENARIOS.map(scenario => ({ scenario: scenario.id, status: "FILLED", filledFraction: 1,
        entryAtMs: atMs + 750, exitAtMs: atMs + 1000, grossBps: net + 13, netBps: net, reason: "DEADLINE" })) })) };
}
const base = (result: ReturnType<typeof evaluateProbePolicies>, policy = "cost-aware-ridge") =>
  result.aggregates.find(r => r.policy === policy && r.scenario === "base-250ms")!;

test("probe policy uses one global slot and waits for the observed outcome record", () => {
  const btc = probe("BTC/USD", 1_000, 1, 10);
  // The eventual BTC exit timestamp is older than this ETH quote, but the
  // audit has not delivered the completion yet. Peeking would admit ETH.
  const ethBeforeReceipt = probe("ETH/USD", 3_000, 2, 20);
  const ethAfterReceipt = probe("ETH/USD", 5_000, 30, 40);
  const result = evaluateProbePolicies([btc, ethBeforeReceipt, ethAfterReceipt]);
  assert.deepEqual(result.selections.filter(r => r.policy === "cost-aware-ridge").map(r => r.eventIndex), [1, 30]);
  assert.equal(base(result).selections, 2);
});

test("unknown selected paths stay unknown while known-only returns remain explicitly partial", () => {
  const first = probe("BTC/USD", 1_000, 1, 10);
  for (const outcome of first.outcomes[0]!.outcomes) Object.assign(outcome, {
    status: "INVALID", netBps: null, grossBps: null, entryAtMs: null, filledFraction: 0, reason: "DISCONNECT" });
  const later = probe("ETH/USD", 5_000, 30, 40, -8);
  const row = base(evaluateProbePolicies([first, later]));
  assert.equal(row.selections, 2); assert.equal(row.unknown, 1); assert.equal(row.filled, 1);
  assert.equal(row.knownNetBpsSum, -8); assert.equal(row.fullPathKnownNetBpsSum, null);
  assert.equal(row.knownMeanNetBps, -8);
});

test("selection cannot choose an ex-post profitable alternative", () => {
  const point = probe("BTC/USD", 1_000, 1, 10, -9);
  for (const outcome of point.outcomes.find(a => a.actionId === "short-5m")!.outcomes)
    Object.assign(outcome, { grossBps: 113, netBps: 100 });
  const result = evaluateProbePolicies([point]);
  assert.equal(result.selections.find(r => r.policy === "cost-aware-ridge")!.actionId, "long-5m");
  assert.equal(base(result).knownNetBpsSum, -9);
});

test("all model policies use the same support and worst-scenario mean threshold", () => {
  for (const [support, score, expected] of [[false, 5, 0], [true, 1, 0], [true, 1.01, 1]] as const) {
    const point = probe("BTC/USD", 1_000, 1, 10);
    point.actions[0]!.supportReady = support;
    for (const model of PREDICTIVE_MODELS) point.actions[0]!.means[model] = [5, score, 5];
    const result = evaluateProbePolicies([point]);
    for (const model of PREDICTIVE_MODELS) assert.equal(base(result, model).selections, expected);
  }
});

test("incomplete scenario forecasts abstain and missing selected outcome records reject the study", () => {
  const missing = probe("BTC/USD", 1_000, 1, 10);
  missing.actions[0]!.means["cost-aware-ridge"] = [5, null, 5];
  assert.equal(base(evaluateProbePolicies([missing])).selections, 0);
  const incomplete = probe("BTC/USD", 1_000, 1, 10);
  incomplete.outcomes.shift();
  assert.throws(() => evaluateProbePolicies([incomplete]), /MISSING_SELECTED_OUTCOME/);
});

test("an outcome completion quote cannot be reused as a new entry", () => {
  const first = probe("BTC/USD", 1_000, 1, 10), sameTime = probe("ETH/USD", 2_000, 30, 40);
  assert.equal(base(evaluateProbePolicies([first, sameTime])).selections, 1);
});
