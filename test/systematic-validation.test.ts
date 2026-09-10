import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SYSTEMATIC_SPEC } from "../src/systematic/spec.js";
import {
  evaluateSystematicValidation,
  systematicDailyNetLowerBound,
  SYSTEMATIC_VALIDATION_PROTOCOL as P,
  SYSTEMATIC_VALIDATION_PROTOCOL_SHA256 as PROTOCOL_HASH,
  type SystematicValidationInput,
  type SystematicValidationRun,
} from "../src/systematic/validation.js";

const DAY = 86_400_000;
const SOURCE_HASH = "a".repeat(64), CONFIG_HASH = "b".repeat(64), DATA_HASH = "c".repeat(64);

// Deliberately artificial unit fixtures exercise the validator only. They are
// never exported as research evidence or represented as trading performance.
function runFixture(windowId: SystematicValidationRun["windowId"], scenario: SystematicValidationRun["scenario"],
  fundingAssumption: SystematicValidationRun["fundingAssumption"]): SystematicValidationRun {
  const window = windowId === "prospective"
    ? { startMs: Date.UTC(2026, 8, 10), endMs: Date.UTC(2026, 11, 10) }
    : P.developmentWindows.find(row => row.windowId === windowId)!;
  const days = (window.endMs - window.startMs) / DAY;
  const dailyNetPnlUsd = Array.from({ length: days }, (_, i) => ({
    date: new Date(window.startMs + i * DAY).toISOString().slice(0, 10),
    netPnlUsd: 1, completedTrades: i % 7 === 0 ? 4 : 0,
  }));
  const completedTrades = dailyNetPnlUsd.reduce((sum, day) => sum + day.completedTrades, 0);
  return { windowId, scenario, fundingAssumption, strategyVersion: SYSTEMATIC_SPEC.version,
    protocolSha256: PROTOCOL_HASH, strategySourceSha256: SOURCE_HASH, strategyConfigSha256: CONFIG_HASH,
    dataSha256: DATA_HASH, evidenceKind: windowId === "prospective" ? "RECORDED_BOOK_PAPER" : "HOURLY_CANDLE_PROXY",
    startMs: window.startMs, endMs: window.endMs, accountingKnown: true, synthetic: false, completedTrades, netPnlUsd: days,
    maxDrawdownUsd: 0, fundingRequiredHours: days * 24, fundingObservedHours: days * 24,
    missingFundingHours: 0, fundingTimestampVerified: windowId === "prospective", dailyNetPnlUsd,
    perAsset: ["BTC/USD", "ETH/USD"].map(symbol => ({ symbol, completedTrades: completedTrades / 2, netPnlUsd: days / 2 })),
  };
}

function fixture(prospective = false): SystematicValidationInput {
  const runs = P.developmentWindows.flatMap(window => P.scenarios.flatMap(scenario =>
    P.fundingSensitivities.map(funding => runFixture(window.windowId as SystematicValidationRun["windowId"],
      scenario as SystematicValidationRun["scenario"], funding as SystematicValidationRun["fundingAssumption"]))));
  const input: SystematicValidationInput = { protocolSha256: PROTOCOL_HASH, strategySourceSha256: SOURCE_HASH,
    strategyConfigSha256: CONFIG_HASH, registeredAtMs: Date.UTC(2026, 8, 9), asOfMs: Date.UTC(2026, 11, 11), runs };
  if (prospective) {
    input.prospectiveRegistration = { registeredAtMs: Date.UTC(2026, 8, 9),
      startMs: Date.UTC(2026, 8, 10), endMs: Date.UTC(2026, 11, 10),
      strategySourceSha256: SOURCE_HASH, strategyConfigSha256: CONFIG_HASH };
    runs.push(runFixture("prospective", "base", "verified-settlements"),
      runFixture("prospective", "stress", "verified-settlements"));
  }
  return input;
}

function rejected(input: SystematicValidationInput, reason: string) {
  const result = evaluateSystematicValidation(input);
  assert.equal(result.paperActivationAllowed, false);
  assert.equal(result.realOrdersAllowed, false);
  assert.ok([...result.reasons, ...result.runs.flatMap(run => run.reasons)].includes(reason), JSON.stringify(result));
}

test("protocol freezes economics, uncertainty, and the strategy-notional drawdown basis before replay", () => {
  assert.equal(PROTOCOL_HASH, createHash("sha256").update(JSON.stringify(P)).digest("hex"));
  assert.ok(Object.isFrozen(P) && Object.isFrozen(P.developmentWindows) && Object.isFrozen(P.developmentWindows[0]));
  assert.ok(Object.isFrozen(P.uncertainty) && Object.isFrozen(P.prospective));
  assert.equal(P.maximumDrawdownUsd / P.studyRiskNotionalUsd, P.maximumDrawdownStudyNotionalFraction);
  assert.equal(P.historicalInterpretation, "REPEATED_DEVELOPMENT_NOT_UNTOUCHED_HOLDOUT");
});

test("profitable repeated history can reject a candidate but cannot authorize paper activation", () => {
  const result = evaluateSystematicValidation(fixture());
  assert.equal(result.developmentPassed, true);
  assert.equal(result.prospectivePassed, false);
  assert.equal(result.paperActivationAllowed, false);
  assert.equal(result.realOrdersAllowed, false);
  assert.deepEqual(result.reasons, ["PROSPECTIVE_PROFIT_EVIDENCE_REQUIRED"]);
  assert.ok(result.runs.every(run => run.lowerMeanNetUsdPerDay === 1 && run.activeWeeks >= 8));
});

test("complete prospective economics can allow paper review while never authorizing real orders", () => {
  const result = evaluateSystematicValidation(fixture(true));
  assert.equal(result.developmentPassed, true);
  assert.equal(result.prospectivePassed, true);
  assert.equal(result.paperActivationAllowed, true);
  assert.equal(result.realOrdersAllowed, false);
  assert.deepEqual(result.reasons, []);
});

test("missing, duplicate, and undeclared runs cannot cherry-pick the historical scenario matrix", () => {
  const missing = fixture(); missing.runs = missing.runs.slice(1);
  rejected(missing, "DEVELOPMENT_ECONOMICS_FAILED_OR_INCOMPLETE");
  const duplicate = fixture(); duplicate.runs = [...duplicate.runs, duplicate.runs[0]!];
  rejected(duplicate, "DUPLICATE_OR_UNDECLARED_RUN");
  const undeclared = fixture(); undeclared.runs[0]!.scenario = "optimistic" as "base";
  rejected(undeclared, "DUPLICATE_OR_UNDECLARED_RUN");
});

test("zero and negative net returns fail even if there are many entries and trades", () => {
  for (const net of [0, -10]) {
    const input = fixture(), run = input.runs[0]!;
    run.netPnlUsd = net;
    run.dailyNetPnlUsd.forEach(day => { day.netPnlUsd = net / run.dailyNetPnlUsd.length; });
    run.perAsset.forEach(asset => { asset.netPnlUsd = net / 2; });
    run.maxDrawdownUsd = Math.max(0, -net);
    rejected(input, "NET_PROFIT_NOT_POSITIVE");
  }
});

test("positive net driven by one lucky week fails dependence-aware uncertainty", () => {
  const input = fixture(), run = input.runs[0]!;
  run.dailyNetPnlUsd.forEach(day => { day.netPnlUsd = -.2; });
  run.dailyNetPnlUsd[180]!.netPnlUsd = 150;
  run.netPnlUsd = run.dailyNetPnlUsd.reduce((sum, day) => sum + day.netPnlUsd!, 0);
  run.perAsset.forEach(asset => { asset.netPnlUsd = run.netPnlUsd! / 2; });
  run.maxDrawdownUsd = 50;
  assert.ok(run.netPnlUsd > 0);
  rejected(input, "NET_UNCERTAINTY_GATE_FAILED");
});

test("many trades concentrated in one week fail coverage without using win rate as proof", () => {
  const input = fixture(), run = input.runs[0]!;
  run.dailyNetPnlUsd.forEach(day => { day.completedTrades = 0; });
  run.dailyNetPnlUsd[0]!.completedTrades = run.completedTrades;
  rejected(input, "INSUFFICIENT_ACTIVE_WEEKS");
});

test("missing funding and synthetic evidence fail closed despite positive gross results", () => {
  const missing = fixture(); missing.runs[0]!.missingFundingHours = 1;
  missing.runs[0]!.fundingObservedHours--;
  rejected(missing, "FUNDING_COVERAGE_INCOMPLETE");
  const unknown = fixture(); unknown.runs[0]!.accountingKnown = false;
  rejected(unknown, "ACCOUNTING_UNKNOWN");
  const synthetic = fixture(); synthetic.runs[0]!.synthetic = true;
  rejected(synthetic, "SYNTHETIC_OR_UNDECLARED_EVIDENCE");
});

test("daily liquidation P&L, trade counts, and both assets must reconcile", () => {
  for (const [mutate, reason] of [
    [(run: SystematicValidationRun) => { run.dailyNetPnlUsd.pop(); }, "DAILY_ACCOUNTING_INCOMPLETE"],
    [(run: SystematicValidationRun) => { run.dailyNetPnlUsd[0]!.date = "2024-01-02"; }, "DAILY_ACCOUNTING_INCOMPLETE"],
    [(run: SystematicValidationRun) => { run.dailyNetPnlUsd[0]!.netPnlUsd = null; }, "DAILY_ACCOUNTING_INCOMPLETE"],
    [(run: SystematicValidationRun) => { run.dailyNetPnlUsd[0]!.netPnlUsd = 2; }, "DAILY_ACCOUNTING_MISMATCH"],
    [(run: SystematicValidationRun) => { run.dailyNetPnlUsd[0]!.completedTrades++; }, "DAILY_TRADE_COUNT_MISMATCH"],
    [(run: SystematicValidationRun) => { run.perAsset[0]!.netPnlUsd = -1; }, "ASSET_PROFIT_OR_TRADES_FAILED"],
    [(run: SystematicValidationRun) => { run.perAsset[0]!.completedTrades++; }, "ASSET_ACCOUNTING_MISMATCH"],
    [(run: SystematicValidationRun) => { run.perAsset.pop(); }, "ASSET_EVIDENCE_MISSING"],
  ] as const) {
    const input = fixture(); mutate(input.runs[0]!); rejected(input, reason);
  }
});

test("drawdown cannot be understated or hidden by a large unrelated account balance", () => {
  const excessive = fixture(); excessive.runs[0]!.maxDrawdownUsd = 201;
  rejected(excessive, "DRAWDOWN_LIMIT_FAILED");
  const understated = fixture(), run = understated.runs[0]!;
  run.dailyNetPnlUsd[0]!.netPnlUsd = -25;
  run.dailyNetPnlUsd[1]!.netPnlUsd = 27;
  run.maxDrawdownUsd = 0;
  rejected(understated, "DRAWDOWN_ACCOUNTING_MISMATCH");
});

test("prospective evidence requires actual books, verified funding, elapsed time, and frozen source and config", () => {
  for (const [mutate, reason] of [
    [(input: SystematicValidationInput) => { input.runs[8]!.evidenceKind = "HOURLY_CANDLE_PROXY"; }, "EVIDENCE_KIND_INVALID"],
    [(input: SystematicValidationInput) => { input.runs[8]!.fundingTimestampVerified = false; }, "PROSPECTIVE_FUNDING_UNVERIFIED"],
    [(input: SystematicValidationInput) => { input.runs[8]!.strategySourceSha256 = "d".repeat(64); }, "EVIDENCE_IDENTITY_MISMATCH"],
    [(input: SystematicValidationInput) => { input.runs[8]!.strategyConfigSha256 = "d".repeat(64); }, "EVIDENCE_IDENTITY_MISMATCH"],
    [(input: SystematicValidationInput) => { input.asOfMs = Date.UTC(2026, 8, 9); }, "WINDOW_INVALID"],
    [(input: SystematicValidationInput) => { input.prospectiveRegistration!.registeredAtMs = Date.UTC(2026, 8, 11); }, "PROSPECTIVE_PROFIT_EVIDENCE_REQUIRED"],
    [(input: SystematicValidationInput) => { input.prospectiveRegistration!.strategyConfigSha256 = "d".repeat(64); }, "PROSPECTIVE_PROFIT_EVIDENCE_REQUIRED"],
  ] as const) {
    const input = fixture(true); mutate(input); rejected(input, reason);
  }
});

test("malformed external records and absent source identities do not approve or crash", () => {
  rejected(null as unknown as SystematicValidationInput, "VALIDATION_ENVELOPE_INVALID");
  const missing = fixture(); missing.strategyConfigSha256 = "";
  rejected(missing, "VALIDATION_ENVELOPE_INVALID");
  const malformed = fixture(); malformed.runs[0]!.perAsset = [null, null] as unknown as SystematicValidationRun["perAsset"];
  rejected(malformed, "ASSET_EVIDENCE_MISSING");
});

test("block uncertainty is reproducible, includes idle days, and rejects inadequate or nonfinite samples", () => {
  const clustered = [5, 5, 5, 5, 5, 5, 5, ...Array<number>(35).fill(0)];
  assert.equal(systematicDailyNetLowerBound(clustered), systematicDailyNetLowerBound(clustered));
  assert.equal(systematicDailyNetLowerBound(clustered), 0);
  assert.equal(systematicDailyNetLowerBound(Array<number>(13).fill(1)), null);
  assert.equal(systematicDailyNetLowerBound([...Array<number>(20).fill(1), NaN]), null);
});
