import assert from "node:assert/strict";
import test from "node:test";
import { PROFIT_SPEC as S } from "../src/profit/spec.js";
import { PROFIT_STUDY_WINDOWS } from "../src/profit/study.js";
import { PROFIT_UTILITY_SPEC as U } from "../src/profit/utility.js";
import { PROFIT_UTILITY_VALIDATION_SPEC as UV, validateProfitUtilityStudy } from "../src/profit/utility-validation.js";
import { PROFIT_VALIDATION_SPEC as V, PROFIT_VALIDATION_SPEC_SHA256, profitCalendarWeeks,
  profitWeeklyNetLowerBound, validateProfitStudy, type ProfitValidationInput,
  type ProfitValidationReplay } from "../src/profit/validation.js";

// Fabricated economic summaries test the validator, never strategy performance.
// The validator cannot establish provenance from caller-supplied summaries.
function run(window: typeof PROFIT_STUDY_WINDOWS[number], policy: string, scenario: string,
  fundingAssumption: string, dailyProfit = policy === "weekly-forecast" ? 1 : .25): ProfitValidationReplay {
  const days = (window.endMs - window.startMs) / S.dayMs, net = days * dailyProfit;
  return { version: S.version, policy, benchmarkOnly: policy !== "weekly-forecast", scenario, fundingAssumption,
    startMs: window.startMs, endMs: window.endMs, evidenceKind: "HOURLY_CANDLE_PROXY", synthetic: false,
    accountingKnown: true, grossPnlUsd: net + 1, feeUsd: 1, fundingCashUsd: 0, netPnlUsd: net,
    maxDrawdownUsd: Math.max(0, -net), riskBreachCount: 0, unresolvedPosition: null,
    fundingRequiredHours: days * 24, fundingObservedHours: days * 24, missingFundingHours: 0,
    completedTrades: 1, exposureNotionalHours: days * 2400,
    dailyNetPnlUsd: Array.from({ length: days }, (_, i) => ({
      date: new Date(window.startMs + i * S.dayMs).toISOString().slice(0, 10),
      netPnlUsd: dailyProfit, exposureNotionalHours: 2400 })),
    perAsset: [{ symbol: "BTC/USD", grossPnlUsd: net + 1, feeUsd: 1, fundingCashUsd: 0,
      netPnlUsd: net, exposureNotionalHours: days * 2400, completedTrades: 1 },
    { symbol: "ETH/USD", grossPnlUsd: 0, feeUsd: 0, fundingCashUsd: 0,
      netPnlUsd: 0, exposureNotionalHours: 0, completedTrades: 0 }] };
}
function input(): ProfitValidationInput {
  return { runs: PROFIT_STUDY_WINDOWS.flatMap(w => V.scenarios.flatMap(s =>
    V.fundingAssumptions.map(f => run(w, "weekly-forecast", s, f)))),
  benchmarks: PROFIT_STUDY_WINDOWS.flatMap(w => V.benchmarkPolicies.flatMap(p =>
    V.scenarios.flatMap(s => V.fundingAssumptions.map(f => run(w, p, s, f))))) };
}
const rejected = (data: ProfitValidationInput) => {
  const result = validateProfitStudy(data);
  assert.equal(result.historicalEligible, false); assert.equal(result.paperPilotAllowed, false);
  assert.equal(result.fullValidationPassed, false); assert.equal(result.realOrdersAllowed, false);
  return result;
};

test("utility variant keeps every economic threshold and cannot relabel predecessor results as eligible evidence", () => {
  assert.deepEqual(UV.everyCandidateRun, V.everyCandidateRun);
  assert.deepEqual(UV.uncertainty, V.uncertainty);
  assert.deepEqual(UV.benchmark, V.benchmark);
  const original = input();
  assert.equal(validateProfitUtilityStudy(original).historicalEligible, false);
  const variant = { runs: original.runs.map(r => ({ ...r, version: U.version, policy: "weekly-mean-variance" })),
    benchmarks: original.benchmarks.map(r => ({ ...r, version: U.version })) };
  assert.equal(validateProfitUtilityStudy(variant).historicalEligible, true);
  assert.equal(validateProfitStudy(variant).historicalEligible, false);
  variant.runs[0]!.maxDrawdownUsd = 200.01;
  assert.equal(validateProfitUtilityStudy(variant).historicalEligible, false);
});

test("complete positive frozen economic summaries can nominate a bounded pilot, never full validation or real orders", () => {
  const result = validateProfitStudy(input());
  assert.equal(result.historicalEligible, true); assert.equal(result.paperPilotAllowed, true);
  assert.equal(result.paperPilotRequiresSealedArtifactVerification, true);
  assert.equal(result.fullValidationPassed, false); assert.equal(result.prospectivePassed, false);
  assert.equal(result.realOrdersAllowed, false); assert.equal(result.winProbability, null);
  assert.equal(result.runs.length, 8); assert.equal(result.benchmarks.length, 16);
  assert.ok(result.runs.every(r => r.passed && r.lowerMeanNetUsdPerWeek! > 0));
  assert.match(PROFIT_VALIDATION_SPEC_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(result.validationSpecSha256, PROFIT_VALIDATION_SPEC_SHA256);
});

test("UTC Monday calendar weeks retain every flat day and both partial boundary weeks", () => {
  const startMs = Date.UTC(2025, 0, 1), endMs = Date.UTC(2025, 0, 15);
  const rows = Array.from({ length: 14 }, (_, i) => ({ date: new Date(startMs + i * S.dayMs).toISOString().slice(0, 10),
    netPnlUsd: i === 0 ? 7 : 0, exposureNotionalHours: i === 0 ? 100 : 0 }));
  const weeks = profitCalendarWeeks(rows, startMs, endMs)!;
  assert.deepEqual(weeks.map(w => w.weekStartDate), ["2024-12-30", "2025-01-06", "2025-01-13"]);
  assert.deepEqual(weeks.map(w => w.calendarDays), [5, 7, 2]);
  assert.deepEqual(weeks.map(w => w.netPnlUsd), [7, 0, 0]);
  assert.equal(weeks.reduce((s, w) => s + w.calendarDays, 0), rows.length);
  assert.equal(profitCalendarWeeks(rows.slice(1), startMs, endMs), null);
  const duplicate = structuredClone(rows); duplicate[1]!.date = duplicate[0]!.date;
  assert.equal(profitCalendarWeeks(duplicate, startMs, endMs), null);
});

test("weekly uncertainty resamples serial blocks deterministically and rejects sparse isolated profits", () => {
  assert.equal(profitWeeklyNetLowerBound(Array(16).fill(7)), 7);
  assert.equal(profitWeeklyNetLowerBound(Array(16).fill(-1)), -1);
  assert.equal(profitWeeklyNetLowerBound([100, ...Array(51).fill(0)]), 0);
  const values = Array.from({ length: 53 }, (_, i) => i % 5 - 1.5);
  assert.equal(profitWeeklyNetLowerBound(values), profitWeeklyNetLowerBound(values));
  assert.equal(profitWeeklyNetLowerBound(Array(7).fill(1)), null);
  assert.equal(profitWeeklyNetLowerBound([NaN, ...Array(10).fill(1)]), null);
});

test("missing, duplicate, extra, wrong-policy and reserved-window runs fail closed", () => {
  const missing = input(); missing.runs = missing.runs.slice(1); rejected(missing);
  const duplicate = input(); duplicate.runs = [...duplicate.runs.slice(1), duplicate.runs[1]!]; rejected(duplicate);
  const extra = input(); extra.runs = [...extra.runs, extra.runs[0]!]; rejected(extra);
  const reserve = input(); reserve.runs[0]!.startMs = Date.UTC(2026, 0, 1); reserve.runs[0]!.endMs = Date.UTC(2026, 6, 1);
  assert.ok(rejected(reserve).runs[0]!.reasons.includes("WINDOW_INVALID_OR_RESERVED"));
  const mislabeled = input(); mislabeled.runs[0]!.policy = "risk-managed-long-btc";
  assert.ok(rejected(mislabeled).runs[0]!.reasons.includes("POLICY_IDENTITY_INVALID"));
  const noStressBenchmark = input(); noStressBenchmark.benchmarks = noStressBenchmark.benchmarks.filter(b => b.scenario !== "stress");
  rejected(noStressBenchmark);
});

test("funding, unresolved inventory, risk breaches and net arithmetic are mandatory", () => {
  const mutations: Array<(r: ProfitValidationReplay) => void> = [
    r => { r.accountingKnown = false; }, r => { r.fundingCashUsd = null; },
    r => { r.fundingObservedHours--; }, r => { r.missingFundingHours = 1; },
    r => { r.unresolvedPosition = { qty: 1 }; }, r => { r.riskBreachCount = 1; },
    r => { r.netPnlUsd! += 5; }, r => { r.feeUsd = -1; },
    r => { r.fundingRequiredHours = r.fundingObservedHours = 0; },
    r => { r.maxDrawdownUsd = NaN; }, r => { r.synthetic = true; },
    r => { r.evidenceKind = "RECORDED_BOOK_PAPER"; }, r => { r.version = "another-strategy"; },
  ];
  for (const mutation of mutations) { const data = input(); mutation(data.runs[0]!); rejected(data); }
});

test("daily and per-asset ledgers must reconcile including exposure and observed drawdown", () => {
  const mutations: Array<(r: ProfitValidationReplay) => void> = [
    r => { r.dailyNetPnlUsd = r.dailyNetPnlUsd.slice(1); },
    r => { r.dailyNetPnlUsd[0]!.netPnlUsd!++; },
    r => { r.dailyNetPnlUsd[1]!.date = r.dailyNetPnlUsd[0]!.date; },
    r => { r.dailyNetPnlUsd[1]!.exposureNotionalHours = -1; },
    r => { r.dailyNetPnlUsd[1]!.exposureNotionalHours = 1; },
    r => { r.perAsset = [r.perAsset[0]!, r.perAsset[0]!]; },
    r => { r.perAsset[0]!.netPnlUsd!++; }, r => { r.perAsset[0]!.completedTrades++; },
    r => { r.dailyNetPnlUsd[0]!.netPnlUsd = 11; r.dailyNetPnlUsd[1]!.netPnlUsd = -9; },
  ];
  for (const mutation of mutations) { const data = input(); mutation(data.runs[0]!); rejected(data); }
});

test("more than 200 dollars drawdown rejects even positive net; every stress and funding sensitivity must profit", () => {
  const largeDrawdown = input(); largeDrawdown.runs[0]!.maxDrawdownUsd = 200.01;
  assert.ok(rejected(largeDrawdown).runs[0]!.reasons.includes("DRAWDOWN_LIMIT_FAILED"));
  const losingStress = input(); losingStress.runs = losingStress.runs.map(r => r.scenario === "stress"
    && r.fundingAssumption === "source-as-end" ? run(PROFIT_STUDY_WINDOWS.find(w => w.startMs === r.startMs)!,
      r.policy, r.scenario, r.fundingAssumption, -.1) : r);
  assert.ok(rejected(losingStress).runs.some(r => r.reasons.includes("NET_PROFIT_NOT_POSITIVE")));
});

test("active weeks derive from exposure, while a single exceptional profit cannot pass calendar uncertainty", () => {
  const sparse = input(), r = sparse.runs[0]!;
  r.dailyNetPnlUsd = r.dailyNetPnlUsd.map((d, i) => ({ ...d, exposureNotionalHours: i < 7 ? 2400 : 0 }));
  r.exposureNotionalHours = 7 * 2400; r.perAsset[0]!.exposureNotionalHours = r.exposureNotionalHours;
  assert.ok(rejected(sparse).runs[0]!.reasons.includes("INSUFFICIENT_ACTIVE_WEEKS"));
  const isolated = input(), v = isolated.runs[0]!;
  v.dailyNetPnlUsd = v.dailyNetPnlUsd.map((d, i) => ({ ...d, netPnlUsd: i === 0 ? v.netPnlUsd! : 0 }));
  assert.ok(rejected(isolated).runs[0]!.reasons.includes("CALENDAR_NET_UNCERTAINTY_GATE_FAILED"));
});

test("pooled base excess uses the arithmetic benchmark mixture and both funding conventions", () => {
  const equal = input(); equal.benchmarks = equal.benchmarks.map(r => run(PROFIT_STUDY_WINDOWS.find(w => w.startMs === r.startMs)!,
    r.policy, r.scenario, r.fundingAssumption, 1));
  const failure = rejected(equal); assert.ok(failure.benchmarkComparisons.every(c => c.excessNetPnlUsd === 0));
  const perPeriodBelow = input(); perPeriodBelow.benchmarks = perPeriodBelow.benchmarks.map(r =>
    run(PROFIT_STUDY_WINDOWS.find(w => w.startMs === r.startMs)!, r.policy, r.scenario, r.fundingAssumption,
      r.startMs === PROFIT_STUDY_WINDOWS[0]!.startMs ? 1.1 : .1));
  const accepted = validateProfitStudy(perPeriodBelow);
  assert.equal(accepted.historicalEligible, true);
  assert.ok(accepted.benchmarkComparisons.every(c => c.periods[0]!.excessNetPnlUsd! < 0 && c.excessNetPnlUsd! > 0));
  const unknown = input(); unknown.benchmarks[0]!.fundingCashUsd = null; rejected(unknown);
});

test("a self-declared prospective pass or claimed source hash cannot authorize full validation", () => {
  const data = input(); data.prospective = { passed: true, fundingKnown: true, netPnlUsd: 1000,
    sourceSha256: "a".repeat(64), calendarDays: 365, evidenceKind: "RECORDED_BOOK_PAPER" };
  const result = validateProfitStudy(data);
  assert.equal(result.historicalEligible, true); assert.equal(result.prospectiveEvidenceSupplied, true);
  assert.equal(result.prospectivePassed, false); assert.equal(result.fullValidationPassed, false);
  assert.equal(result.realOrdersAllowed, false);
});

test("malformed external envelopes and nested records reject without throwing", () => {
  for (const value of [null, undefined, {}, { runs: null, benchmarks: [] }, { runs: [null, 12], benchmarks: [false] }])
    assert.equal(validateProfitStudy(value as unknown as ProfitValidationInput).historicalEligible, false);
  for (const mutation of [
    (r: ProfitValidationReplay) => { r.dailyNetPnlUsd = [null] as unknown as ProfitValidationReplay["dailyNetPnlUsd"]; },
    (r: ProfitValidationReplay) => { r.perAsset = [null, false] as unknown as ProfitValidationReplay["perAsset"]; },
    (r: ProfitValidationReplay) => { r.netPnlUsd = Infinity; },
  ]) { const data = input(); mutation(data.runs[0]!); rejected(data); }
});
