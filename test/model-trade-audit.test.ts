import assert from "node:assert/strict";
import test from "node:test";
import { auditModelTrades, type ModelAuditOrder } from "../src/analysis/model-trade-audit.js";
import { CROSS_ASSET_SPEC, type CrossAssetForecast } from "../src/research/cross-asset-model.js";

const version = "audit-test", cutoff = 2_000_000;
function entry(id = "entry", side: 1 | -1 = 1): ModelAuditOrder {
  const f: CrossAssetForecast = { version: CROSS_ASSET_SPEC.version, symbol: "BTC/USD", side, atMs: 1_000_000,
    horizonMs: 900_000, referenceMid: 100, trainingLabels: 30, trainedThroughMs: 999_000,
    predictedGrossBps: side * 1, parameterUncertaintyBps: 2, predictiveStdBps: 20, costHurdleBps: 13,
    conservativeNetBps: -18, eligible: false, reason: "COST_OR_UNCERTAINTY", factorBeta: 1, expertWeights: { trend: 1 } };
  return { clientOrderId: id, symbol: "BTC/USD", side, modelVersion: CROSS_ASSET_SPEC.version,
    configurationVersion: version, crossAssetEntryMode: "PAPER_EVALUATION", crossAssetForecast: f,
    reduceOnlyIntent: false, filledQty: .1, averageFillPx: 100, createdMs: 1_000_100, updatedMs: 1_000_200,
    terminal: true, livePosition: null, exitReason: null, telemetryDroppedRecords: 0 };
}
function exit(e = entry()): ModelAuditOrder {
  return { ...e, clientOrderId: `exit-${e.clientOrderId}`, side: e.side === 1 ? -1 : 1,
    configurationVersion: "new-exit-config", crossAssetForecast: null, crossAssetEntryMode: null,
    reduceOnlyIntent: true, createdMs: 1_900_000, updatedMs: 1_900_100, exitReason: "POLICY_DEADLINE",
    livePosition: { active: false, closedAtMs: 1_900_100, openedMs: 1_000_200, ageMs: 899_900,
      qty: .1, entryPx: 100, currentPx: 100.01, unrealizedPnl: -.009, unrealizedPnlBps: -9,
      realizedPnl: -.009, realizedPnlBps: -9, closePx: 100.01, entryOrderId: e.clientOrderId,
      exitOrderId: `exit-${e.clientOrderId}`, phase: "CLOSED", latestAction: "EXIT", latestReason: "POLICY_DEADLINE",
      pnlHistory: [], realizedBreakdown: { grossPricePnl: .001, entryFee: .005, exitFee: .005,
        realizedPnl: -.009, entryStyle: "taker", exitStyle: "taker" } } };
}

test("model audit joins changed-config exits, deduplicates ledgers and reconciles fee drag", () => {
  const e = entry(), x = exit(e);
  const report = auditModelTrades([e, x, x, { ...x, clientOrderId: "copied-exit", updatedMs: x.updatedMs - 1 }], version, cutoff);
  assert.equal(report.summary.closed, 1); assert.equal(report.summary.netPnl, -.009);
  assert.equal(report.summary.attributedFees, .01); assert.equal(report.summary.attributedGrossPnl, .001);
  assert.equal(report.summary.grossWinnersLostAfterFees, 1); assert.equal(report.summary.belowCostHurdle, 1);
  assert.equal(report.trades[0]!.netBps, -9); assert.equal(report.deploymentReady, false);
  assert.equal(report.feeSensitivity[0]!.hypotheticalNetPnl, .001);
  assert.equal(report.entryScreenComparison.screens[1]!.netPnl, 0);
  assert.equal(report.entryScreenComparison.screens[1]!.skippedAttempts, 1);
});

test("model audit preserves open, unresolved and unfilled attempts on a common screen denominator", () => {
  const e = entry(), x = exit(e), unfilled = { ...entry("miss"), filledQty: 0 };
  const unresolved = entry("unresolved");
  const open = { ...entry("open"), livePosition: { ...x.livePosition!, active: true, closedAtMs: null, realizedPnl: null } };
  const r = auditModelTrades([e, x, unfilled, unresolved, open], version, cutoff);
  assert.equal(r.summary.attempts, 4); assert.equal(r.summary.closed, 1);
  assert.equal(r.summary.unfilled, 1); assert.equal(r.summary.unresolved, 1); assert.equal(r.summary.open, 1);
  assert.equal(r.entryScreenComparison.panelAttempts, 2); assert.equal(r.entryScreenComparison.excludedAttempts, 2);
  assert.equal(r.entryScreenComparison.screens[0]!.meanPnlPerOriginalAttempt, -.0045);
});

test("wrong entry links, future data and partial exit legs cannot manufacture a closed trade", () => {
  const e = entry(), x = exit(e);
  for (const bad of [{ ...x, livePosition: { ...x.livePosition!, entryOrderId: "different" } },
    { ...x, livePosition: { ...x.livePosition!, qty: .05 } },
    { ...x, livePosition: { ...x.livePosition!, closedAtMs: cutoff + 1 } }, { ...x, updatedMs: cutoff + 1 }]) {
    const r = auditModelTrades([e, bad], version, cutoff);
    assert.equal(r.summary.closed, 0); assert.equal(r.summary.unresolved, 1); assert.equal(r.summary.netPnl, null);
  }
});

test("bad cost breakdowns stay visible and unknown telemetry cannot qualify for filter comparisons", () => {
  const e = { ...entry(), telemetryDroppedRecords: null }, x = exit(e);
  x.livePosition!.realizedBreakdown!.exitFee = .1;
  const r = auditModelTrades([e, x], version, cutoff);
  assert.equal(r.summary.netPnl, -.009); assert.equal(r.summary.missingCostBreakdowns, 1);
  assert.equal(r.summary.attributedFees, null); assert.equal(r.entryScreenComparison.panelAttempts, 0);
});

test("short forecasts use directional magnitude; stale or opposite-side forecasts are excluded from comparisons", () => {
  const e = entry("short", -1), x = exit(e);
  const r = auditModelTrades([e, x], version, cutoff);
  assert.equal(r.trades[0]!.predictedDirectionalGrossBps, 1);
  for (const f of [{ ...e.crossAssetForecast!, atMs: e.createdMs - 1_001 },
    { ...e.crossAssetForecast!, side: 1 as const }]) {
    const bad = auditModelTrades([{ ...e, crossAssetForecast: f }, x], version, cutoff);
    assert.equal(bad.summary.closed, 1); assert.equal(bad.summary.forecastMissingOrInvalid, 1);
    assert.equal(bad.entryScreenComparison.panelAttempts, 0);
  }
});
