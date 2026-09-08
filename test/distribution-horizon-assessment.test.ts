import assert from "node:assert/strict";
import test from "node:test";
import { StreamingHorizonAssessment, type HorizonResearchPanel } from "../src/distribution/horizon-assessment.js";
import { buildHorizonResearchActions, HORIZON_RESEARCH_SPEC } from "../src/distribution/horizon-spec.js";
import { DISTRIBUTION_SCENARIOS, type DistributionOutcome } from "../src/distribution/spec.js";

const day = 86_400_000, step = HORIZON_RESEARCH_SPEC.proposalIntervalMs;
const options = { trainingStartMs: day, laterStartMs: 4 * day };
const catalog = buildHorizonResearchActions(20);
const winner = "horizon-fixed-control-long-1m", alternative = "horizon-volatility-short-30m";
const net = (actionId: string): number => actionId === winner ? 20 : actionId === alternative ? 10 : 5;

// Synthetic complete outcomes verify accounting and causality only. Their
// returns are not a fitted forecast, replay result or profitability evidence.
function panel(signalAtMs: number, value = net, symbol = "BTC/USD"): HorizonResearchPanel {
  return { symbol, signalAtMs, completedAtMs: signalAtMs + 1500, volatility30mBps: 20,
    features: Array<number>(12).fill(0), paths: catalog.map(action => ({ action: { ...action },
      outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({ scenario: scenario.id, status: "FILLED" as const,
        netBps: value(action.id), grossBps: value(action.id) + 12, filledFraction: 1,
        entryAtMs: signalAtMs + 750, exitAtMs: signalAtMs + 1500, reason: "TAKE_PROFIT" })) })) };
}
function seed(assessment: StreamingHorizonAssessment, value = net, count = 24, symbol = "BTC/USD") {
  for (let i = 0; i < count; i++) assessment.observePanel(panel(day * (1 + Math.floor(i / 8)) + (i % 8) * step, value, symbol));
}
function chosen(report: ReturnType<StreamingHorizonAssessment["finish"]>, symbol = "BTC/USD") {
  return report.selectedPolicies.find(policy => policy.symbol === symbol)!;
}
function base(rows: ReturnType<StreamingHorizonAssessment["finish"]>["actionComparisons"]) {
  return rows.find(row => row.scenario === DISTRIBUTION_SCENARIOS[0].id)!;
}

test("training locks one action per asset before later outcomes and never picks the later hindsight winner", () => {
  const assessment = new StreamingHorizonAssessment(options); seed(assessment);
  assessment.lockSelection();
  assessment.observePanel(panel(options.laterStartMs, actionId => actionId === winner ? -50 : 100));
  assessment.observePanel(panel(options.laterStartMs + step, actionId => actionId === winner ? -10 : 200));
  const report = assessment.finish(), policy = chosen(report);
  assert.equal(policy.actionId, winner); assert.equal(policy.trainingPanels, 24); assert.equal(policy.trainingDays, 3);
  assert.ok(policy.worstTrainingLowerMeanNetBps! > 1);
  assert.equal(base(policy.later).meanNetBps, -30);
  assert.equal(base(policy.laterCommon).meanNetBps, -30);
  assert.equal(base(policy.later).normalizedNetUsdAt12, -60 * 12 / 10_000);
  assert.equal(report.completeCommonTrainingPanels, 24); assert.equal(report.completeCommonLaterPanels, 2);
  assert.equal(report.familyComparisons.length, 6);
  assert.equal(chosen(report, "ETH/USD").actionId, null, "BTC observations cannot train the ETH benchmark");
  const alt = report.actionComparisons.find(row => row.symbol === "BTC/USD" && row.period === "LATER"
    && row.actionId === alternative && row.scenario === DISTRIBUTION_SCENARIOS[0].id)!;
  assert.equal(alt.meanNetBps, 150); assert.notEqual(policy.actionId, alt.actionId);
  assert.equal(report.profitabilityEstablished, false); assert.equal(report.brokerOrdersSubmitted, 0);
  assert.ok(report.assumptions.some(value => value.includes("not the live conditional model")));
  assert.ok(report.assumptions.some(value => value.includes("neither exact simulated cash P&L nor live account profit")));
});

test("insufficient common panels or training days and nonpositive stressed lower means lock FLAT", () => {
  for (const kind of ["PANELS", "DAYS", "SCORE", "STRESS"] as const) {
    const assessment = new StreamingHorizonAssessment(options);
    if (kind === "DAYS") {
      for (let i = 0; i < 24; i++) assessment.observePanel(panel(day + i * step));
    } else if (kind === "STRESS") {
      for (let i = 0; i < 24; i++) {
        const row = panel(day * (1 + Math.floor(i / 8)) + (i % 8) * step);
        for (const path of row.paths) path.outcomes[2]!.netBps = -10;
        assessment.observePanel(row);
      }
    } else seed(assessment, kind === "SCORE" ? () => 1 : net, kind === "PANELS" ? 23 : 24);
    assessment.lockSelection(); assessment.observePanel(panel(options.laterStartMs, () => 1000));
    const policy = chosen(assessment.finish());
    assert.equal(policy.actionId, null, kind); assert.equal(base(policy.later).flat, 1);
    assert.equal(base(policy.later).filled, 0); assert.equal(base(policy.later).meanNetBps, 0);
    assert.equal(policy.reason, kind === "PANELS" ? "INSUFFICIENT_TRAINING_PANELS"
      : kind === "DAYS" ? "INSUFFICIENT_TRAINING_DAYS" : "TRAINING_LOWER_MEAN_BELOW_MINIMUM");
  }
});

test("later data requires an explicit lock and boundary-crossing training paths are jointly purged", () => {
  const assessment = new StreamingHorizonAssessment(options);
  assert.throws(() => assessment.observePanel(panel(options.laterStartMs)), /MUST_LOCK_BEFORE_LATER_DATA/);
  seed(assessment, net, 23);
  const crossing = panel(options.laterStartMs - 1500);
  assert.equal(crossing.completedAtMs, options.laterStartMs);
  assessment.observePanel(crossing);
  assessment.lockSelection();
  assessment.observePanel(panel(options.laterStartMs + step));
  const report = assessment.finish();
  assert.equal(report.boundaryPurgedTrainingPanels, 1);
  assert.equal(report.completeCommonTrainingPanels, 23);
  assert.equal(chosen(report).actionId, null);
  assert.equal(chosen(report).reason, "INSUFFICIENT_TRAINING_PANELS");
});

test("missing long paths exclude a common panel while preserving shorter coverage as unmatched diagnostics", () => {
  const assessment = new StreamingHorizonAssessment(options); seed(assessment);
  assessment.lockSelection();
  const later = panel(options.laterStartMs);
  later.paths = later.paths.filter(path => path.action.id !== alternative);
  assessment.observePanel(later);
  const report = assessment.finish(), policy = chosen(report);
  assert.equal(report.invalidOrMissingLaterPanels, 1); assert.equal(report.completeCommonLaterPanels, 0);
  assert.equal(report.invalidReasons.MISSING_ACTION, 3);
  assert.equal(base(policy.later).meanNetBps, 20, "the frozen selected short path is known");
  assert.equal(base(policy.laterCommon).meanNetBps, null, "it cannot be compared against missing long paths");
  const common = report.actionComparisons.find(row => row.period === "LATER" && row.symbol === "BTC/USD" && row.actionId === winner)!;
  const coverage = report.individualCoverage.find(row => row.period === "LATER" && row.symbol === "BTC/USD" && row.actionId === winner)!;
  assert.equal(common.opportunities, 0); assert.equal(coverage.knownOutcomes, 1); assert.equal(coverage.knownOutcomeMeanNetBps, 20);
});

test("invalid selected paths remain unknown instead of zero or a profitable known-only summary", () => {
  const assessment = new StreamingHorizonAssessment(options); seed(assessment); assessment.lockSelection();
  assessment.observePanel(panel(options.laterStartMs));
  const missing = panel(options.laterStartMs + step), target = missing.paths.find(path => path.action.id === winner)!;
  for (const outcome of target.outcomes) Object.assign(outcome, { status: "INVALID", netBps: null,
    grossBps: null, reason: "REPLAY_END" });
  assessment.observePanel(missing);
  const report = assessment.finish(), row = base(chosen(report).later);
  assert.equal(row.opportunities, 2); assert.equal(row.knownOutcomes, 1); assert.equal(row.invalidOrMissing, 1);
  assert.equal(row.meanNetBps, null); assert.equal(row.normalizedNetUsdAt12, null);
  assert.equal(row.dayMeanNetBps, null); assert.equal(row.lowerMeanNetBps, null);
  assert.equal(row.knownOutcomeMeanNetBps, 20); assert.equal(row.reasons.REPLAY_END, 1);
  assert.equal(report.invalidReasons.REPLAY_END, 3);
});

test("outcomes retain their partial-fill denominator, zero nonfills and execution exit reasons without charging costs again", () => {
  const assessment = new StreamingHorizonAssessment(options); seed(assessment); assessment.lockSelection();
  for (const [index, reason] of ["STOP_LOSS", "TAKE_PROFIT", "DEADLINE", "IOC_UNFILLED"].entries()) {
    const current = panel(options.laterStartMs + index * step);
    for (const outcome of current.paths.find(path => path.action.id === winner)!.outcomes) {
      Object.assign(outcome, reason === "IOC_UNFILLED" ? { status: "UNFILLED", reason, filledFraction: 0,
        entryAtMs: null, netBps: 0, grossBps: 0 }
        : { reason, filledFraction: .5, netBps: 10, grossBps: 16 });
    }
    assessment.observePanel(current);
  }
  const row = base(chosen(assessment.finish()).later);
  assert.equal(row.filled, 3); assert.equal(row.partialFills, 3); assert.equal(row.unfilled, 1);
  assert.equal(row.meanNetBps, 7.5); assert.equal(row.meanGrossBps, 12);
  assert.equal(row.normalizedNetUsdAt12, 30 * 12 / 10_000);
  assert.deepEqual(row.reasons, { STOP_LOSS: 1, TAKE_PROFIT: 1, DEADLINE: 1, IOC_UNFILLED: 1 });
  assert.equal(row.meanHoldingMs, 750);
});

test("late training observations cannot retroactively change locked choices and malformed policy paths are rejected", () => {
  const assessment = new StreamingHorizonAssessment(options); seed(assessment, net, 23); assessment.lockSelection();
  assessment.observePanel(panel(3 * day + 7 * step, () => 1000));
  assessment.observePanel(panel(options.laterStartMs));
  const report = assessment.finish();
  assert.equal(report.trainingPanelsAfterLock, 1); assert.equal(report.completeCommonTrainingPanels, 23);
  assert.equal(chosen(report).actionId, null);
  assert.throws(() => assessment.observePanel(panel(options.laterStartMs + step)), /FINISHED/);
  const frozen = new StreamingHorizonAssessment(options), changed = panel(day);
  changed.paths[0]!.action.stopLossBps += 1;
  assert.throws(() => frozen.observePanel(changed), /NOT_FROZEN_AT_ORIGIN/);
  const original = panel(day); frozen.observePanel(original);
  original.paths[0]!.outcomes[0]!.netBps = 1_000_000;
  assert.throws(() => frozen.observePanel(panel(day + 1000)), /OVERLAPPING_OR_REVERSED/);
  const value = frozen.finish().actionComparisons.find(row => row.period === "TRAINING" && row.symbol === "BTC/USD"
    && row.actionId === catalog[0]!.id && row.scenario === DISTRIBUTION_SCENARIOS[0].id)!;
  assert.equal(value.meanNetBps, net(catalog[0]!.id), "caller mutation cannot rewrite observed statistics");
});

test("missing, duplicate, unknown and malformed scenario outcomes never form a complete panel", () => {
  const mutations: Array<(outcomes: DistributionOutcome[]) => void> = [
    outcomes => { outcomes.pop(); },
    outcomes => { outcomes.push({ ...outcomes[0]! }); },
    outcomes => { outcomes.push({ ...outcomes[0]!, scenario: "UNREGISTERED_STRESS" }); },
    outcomes => { outcomes[0]!.netBps = NaN; },
    outcomes => { outcomes[0]!.filledFraction = 2; },
    outcomes => { outcomes[0]!.exitAtMs++; },
    outcomes => { outcomes[0]!.netBps = outcomes[0]!.grossBps! + 1; },
    outcomes => { outcomes[2]!.entryAtMs! -= 1; },
    outcomes => { outcomes[2]!.exitAtMs -= 1; },
    outcomes => { Object.assign(outcomes[2]!, { status: "UNFILLED", netBps: 0, grossBps: 0,
      filledFraction: 0, entryAtMs: null, exitAtMs: day + 749 }); },
  ];
  for (const mutate of mutations) {
    const assessment = new StreamingHorizonAssessment(options), current = panel(day);
    mutate(current.paths[0]!.outcomes); assessment.observePanel(current);
    const report = assessment.finish();
    assert.equal(report.completeCommonTrainingPanels, 0, mutate.toString());
    assert.equal(report.invalidOrMissingTrainingPanels, 1);
    assert.equal(chosen(report).actionId, null);
  }
});
