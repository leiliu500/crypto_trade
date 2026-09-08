import assert from "node:assert/strict";
import test from "node:test";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC } from "../src/distribution/spec.js";
import { HORIZON_RESEARCH_SPEC as S, HORIZON_RESEARCH_FAMILIES, HORIZON_RESEARCH_ACTION_IDS,
  buildHorizonResearchActions, type HorizonResearchAction } from "../src/distribution/horizon-spec.js";
import { findPolicy } from "../src/research/trading-policy.js";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
  `${actual} differs from ${expected}`);

test("research menu preserves the six live reference policies and supplies two complete controlled menus", () => {
  const menu = buildHorizonResearchActions(40), legacy = menu.filter(a => a.family === "LEGACY");
  assert.equal(menu.length, 26); assert.equal(legacy.length, 6);
  for (const action of DISTRIBUTION_ACTIONS) {
    const reference = legacy.find(a => a.side === action.side && a.horizonMs === action.horizonMs)!;
    assert.ok(reference); assert.equal(reference.stopLossBps, action.stopLossBps);
    assert.equal(reference.takeProfitNetBps, action.takeProfitNetBps);
    assert.equal(reference.volatility30mBps, null); assert.equal(reference.referenceSigmaBps, null);
  }
  for (const family of ["FIXED_CONTROL", "VOLATILITY"] as const) {
    const rows = menu.filter(a => a.family === family);
    assert.equal(rows.length, 10);
    for (const minutes of S.horizonsMinutes) for (const side of [1, -1]) {
      assert.equal(rows.filter(a => a.horizonMs === minutes * 60_000 && a.side === side).length, 1);
    }
  }
  assert.equal(new Set(menu.map(a => a.id)).size, menu.length);
  assert.equal(new Set(menu.map(a => a.policyId)).size, menu.length);
  assert.ok(menu.every(a => findPolicy(a.policyId) === undefined), "research policies cannot resolve as live position policies");
  assert.ok(menu.every(a => a.horizonMs < S.proposalIntervalMs));
  assert.deepEqual(menu.map(a => a.id), HORIZON_RESEARCH_ACTION_IDS);
});

test("only the fixed control family isolates duration with identical barriers across horizons and volatility", () => {
  const quiet = buildHorizonResearchActions(5), volatile = buildHorizonResearchActions(200);
  for (const family of ["LEGACY", "FIXED_CONTROL"] as const) {
    assert.deepEqual(quiet.filter(a => a.family === family), volatile.filter(a => a.family === family));
  }
  const fixed = quiet.filter(a => a.family === "FIXED_CONTROL");
  assert.ok(fixed.every(a => a.stopLossBps === 25 && a.takeProfitNetBps === 40));
  assert.ok(fixed.every(a => a.volatility30mBps === null && a.referenceSigmaBps === null));
  assert.equal(HORIZON_RESEARCH_FAMILIES.FIXED_CONTROL.isolatesDeadline, true);
  assert.equal(HORIZON_RESEARCH_FAMILIES.LEGACY.isolatesDeadline, false);
  assert.equal(HORIZON_RESEARCH_FAMILIES.VOLATILITY.isolatesDeadline, false,
    "square-root scaling changes barriers along with duration");
});

test("volatility barriers use uncapped square-root-of-time scaling with separately applied gross-stop and net-target floors", () => {
  const menu = buildHorizonResearchActions(40).filter(a => a.family === "VOLATILITY");
  for (const action of menu) {
    const sigma = 40 * Math.sqrt(action.horizonMs / (30 * 60_000));
    assert.equal(action.volatility30mBps, 40); close(action.referenceSigmaBps!, sigma);
    close(action.stopLossBps, Math.max(10, sigma));
    close(action.takeProfitNetBps, Math.max(20, 1.6 * sigma));
  }
  const shortest = menu.find(a => a.horizonMs === 60_000)!;
  assert.equal(shortest.stopLossBps, 10); assert.equal(shortest.takeProfitNetBps, 20);
  const thirty = menu.find(a => a.horizonMs === 30 * 60_000)!;
  assert.equal(thirty.stopLossBps, 40); assert.equal(thirty.takeProfitNetBps, 64);
  const uncapped = buildHorizonResearchActions(400).find(a => a.family === "VOLATILITY" && a.horizonMs === 30 * 60_000)!;
  assert.equal(uncapped.referenceSigmaBps, 400); assert.equal(uncapped.stopLossBps, 400);
  assert.equal(uncapped.takeProfitNetBps, 640, "raw volatility must not be recovered from a capped market feature");
});

test("quiet markets remain admitted and use positive fixed floors", () => {
  for (const volatility of [0, Number.MIN_VALUE, 1]) {
    const actions = buildHorizonResearchActions(volatility).filter(a => a.family === "VOLATILITY");
    assert.equal(actions.length, 10);
    assert.ok(actions.every(a => a.stopLossBps === 10 && a.takeProfitNetBps === 20));
    assert.ok(actions.every(a => Number.isFinite(a.referenceSigmaBps) && a.referenceSigmaBps! >= 0));
  }
});

test("opposite sides share the same ex-ante barriers and action identities stay stable as market volatility changes", () => {
  const first = buildHorizonResearchActions(40), second = buildHorizonResearchActions(80);
  assert.deepEqual(first.map(a => a.id), second.map(a => a.id));
  for (const family of ["LEGACY", "FIXED_CONTROL", "VOLATILITY"] as const) {
    for (const long of first.filter(a => a.family === family && a.side === 1)) {
      const short = first.find(a => a.family === family && a.side === -1 && a.horizonMs === long.horizonMs)!;
      assert.equal(short.stopLossBps, long.stopLossBps); assert.equal(short.takeProfitNetBps, long.takeProfitNetBps);
      assert.equal(short.referenceSigmaBps, long.referenceSigmaBps);
    }
  }
  const longThirty = first.find(a => a.family === "VOLATILITY" && a.side === 1 && a.horizonMs === 30 * 60_000)!;
  const doubled = second.find(a => a.id === longThirty.id)!;
  assert.equal(doubled.stopLossBps, longThirty.stopLossBps * 2);
  assert.equal(doubled.takeProfitNetBps, longThirty.takeProfitNetBps * 2);
});

test("research actions, constants and references are immutable without mutating live settings", () => {
  const originalSpec = JSON.stringify(DISTRIBUTION_SPEC), originalActions = JSON.stringify(DISTRIBUTION_ACTIONS);
  const actions = buildHorizonResearchActions(40);
  assert.ok(Object.isFrozen(S)); assert.ok(Object.isFrozen(S.horizonsMinutes));
  assert.ok(Object.isFrozen(HORIZON_RESEARCH_FAMILIES));
  assert.ok(Object.values(HORIZON_RESEARCH_FAMILIES).every(Object.isFrozen));
  assert.ok(Object.isFrozen(actions)); assert.ok(actions.every(Object.isFrozen));
  assert.ok(Object.isFrozen(HORIZON_RESEARCH_ACTION_IDS));
  assert.throws(() => { (actions[0] as HorizonResearchAction).stopLossBps = 1; }, TypeError);
  assert.throws(() => { (actions as HorizonResearchAction[]).pop(); }, TypeError);
  assert.equal(JSON.stringify(DISTRIBUTION_SPEC), originalSpec);
  assert.equal(JSON.stringify(DISTRIBUTION_ACTIONS), originalActions);
  assert.notEqual(buildHorizonResearchActions(40)[0], actions[0], "each factory result owns its action values");
});

test("invalid volatility and arithmetic-overflow action limits are rejected", () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => buildHorizonResearchActions(value), /INVALID_HORIZON_RESEARCH_VOLATILITY/);
  }
  assert.throws(() => buildHorizonResearchActions(Number.MAX_VALUE), /INVALID_HORIZON_RESEARCH_ACTION/);
});
