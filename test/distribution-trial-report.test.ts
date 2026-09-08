import assert from "node:assert/strict";
import test from "node:test";
import { createDistributionTrialReport, DISTRIBUTION_TRIAL_BASELINE_VERSION, DISTRIBUTION_TRIAL_POLICY,
  type DistributionTrialBaseline } from "../src/analysis/distribution-trial-report.js";
import { DISTRIBUTION_ENTRY_PROFILES } from "../src/distribution/spec.js";

const atMs = 1_800_000_000_000;
function baseline(): DistributionTrialBaseline {
  return { version: DISTRIBUTION_TRIAL_BASELINE_VERSION, trialId: "paper-trial-2026-09-07", startedAtMs: atMs,
    entryMode: "PAPER_TRIAL", selectionPolicyVersion: DISTRIBUTION_TRIAL_POLICY,
    equity: 99_998.28269740003, orderIds: ["legacy-entry", "legacy-exit"], positions: 0 };
}
function order(id: string, options: Record<string, unknown> = {}) {
  return { clientOrderId: id, symbol: "BTC/USD", side: 1, createdMs: atMs + 100, updatedMs: atMs + 100,
    reduceOnlyIntent: false, filledQty: 0, averageFillPx: 0, terminal: true, livePosition: null as Record<string, unknown> | null,
    distributionDecision: { entryMode: "PAPER_TRIAL", selectionPolicyVersion: DISTRIBUTION_TRIAL_POLICY }, ...options };
}
function snapshot() {
  return { generatedAtMs: atMs + 10_000, mode: "paper", paper: true, equity: baseline().equity,
    sessionPnl: -.4338593, realizedSessionBreakdown: { totalPnl: -.4338593, tradeCount: 53 },
    database: { connected: true, droppedRecords: 0, queuedRecords: 0 }, positions: [] as Record<string, unknown>[],
    markets: [{ symbol: "BTC/USD", bookValid: true, stale: false, bestBid: 109, bestAsk: 111,
      distributional: { statistics: { validation: { selections: 1, observedDays: 1, lowerNetBps: 2, ready: false } } } }],
    orders: [order("legacy-entry", { createdMs: atMs - 2000, updatedMs: atMs - 1000, filledQty: .1,
      averageFillPx: 100, distributionDecision: null }),
    order("legacy-exit", { createdMs: atMs - 1500, updatedMs: atMs - 1000, filledQty: .1,
      averageFillPx: 99, reduceOnlyIntent: true, distributionDecision: null })] };
}
function closedTrade(id = "trial-entry") {
  const ledger = { active: false, closedAtMs: atMs + 2000, openedMs: atMs + 100,
    qty: .1, entryPx: 100, entryOrderId: id, exitOrderId: `${id}-exit`, realizedPnl: .98,
    realizedBreakdown: { grossPricePnl: 1, entryFee: .01, exitFee: .01, realizedPnl: .98,
      entryStyle: "taker", exitStyle: "taker" } };
  return [order(id, { filledQty: .1, averageFillPx: 100, livePosition: structuredClone(ledger) }),
    order(`${id}-exit`, { side: -1, reduceOnlyIntent: true, filledQty: .1, averageFillPx: 110,
      createdMs: atMs + 2000, updatedMs: atMs + 2000, distributionDecision: null,
      livePosition: structuredClone(ledger) })];
}

test("zero trial orders exclude previous UTC-session losses and preserve hypothetical results separately", () => {
  const b = baseline(), current = snapshot(), before = JSON.stringify([b, current]);
  const report = createDistributionTrialReport(b, current);
  assert.equal(report.counts.entryAttempts, 0); assert.equal(report.counts.baselineOrdersExcluded, 2);
  assert.equal(report.account.equityDeltaUsd, 0); assert.equal(report.account.trialEquityDeltaUsd, 0);
  assert.equal(report.account.feesAlreadyIncluded, true); assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, 0);
  assert.equal(report.actualOutcomes.winRate, null); assert.equal(report.actualOutcomes.profitFactor, null);
  assert.equal(report.profitabilityEstablished, false);
  assert.equal(report.shadowValidation?.selections, 1);
  assert.equal(JSON.stringify([b, current]), before, "reporting must not mutate baseline or dashboard");
});

test("complete copied trade ledgers count actual entry/exit fees once and reconcile account equity", () => {
  const current = snapshot(); current.orders.push(...closedTrade()); current.equity += .98;
  const report = createDistributionTrialReport(baseline(), current);
  assert.equal(report.account.attributableToTrial, true);
  assert.equal(report.counts.entryAttempts, 1); assert.equal(report.counts.filledEntries, 1);
  assert.equal(report.counts.closedTrades, 1); assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, .98);
  assert.equal(report.actualOutcomes.closedTradeGrossPnlUsd, 1); assert.equal(report.actualOutcomes.closedTradeFeesUsd, .02);
  assert.ok(Math.abs(report.account.trialEquityDeltaUsd! - .98) < 1e-8, "fees must not be subtracted from account delta again");
  assert.equal(report.actualOutcomes.meanClosedNetBps, 980); assert.equal(report.actualOutcomes.winRate, 1);
  assert.equal(report.profitabilityEstablished, false, "one positive result does not establish profitability");
});

test("terminal nonfills and pending entry orders are distinct from filled trades", () => {
  const current = snapshot(); current.orders.push(order("no-fill"), order("pending", { terminal: false }));
  const report = createDistributionTrialReport(baseline(), current);
  assert.equal(report.counts.entryAttempts, 2); assert.equal(report.counts.filledEntries, 0);
  assert.equal(report.counts.unfilledTerminalEntries, 1); assert.equal(report.counts.pendingUnfilledEntries, 1);
  assert.equal(report.counts.pendingEntryOrders, 1); assert.equal(report.account.trialEquityDeltaUsd, 0);
  assert.equal(report.profitabilityEstablished, false);
});

test("missing baseline history, other policies and unlinked exits prevent cohort attribution", () => {
  for (const modify of [
    (current: ReturnType<typeof snapshot>) => { current.orders.pop(); },
    (current: ReturnType<typeof snapshot>) => { current.orders.push(order("other", { distributionDecision: null })); },
    (current: ReturnType<typeof snapshot>) => { current.orders.push(order("unlinked-exit", { reduceOnlyIntent: true })); },
    (current: ReturnType<typeof snapshot>) => { current.orders.push(order("another-trial", { distributionDecision: {
      entryMode: "PAPER_TRIAL", selectionPolicyVersion: DISTRIBUTION_TRIAL_POLICY, trialId: "other-trial" } })); },
  ]) {
    const current = snapshot(); modify(current);
    const report = createDistributionTrialReport(baseline(), current);
    assert.equal(report.account.attributableToTrial, false); assert.equal(report.account.trialEquityDeltaUsd, null);
    assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, null);
    assert.ok(report.completeness.reasons.length > 0);
  }
});

test("unexplained account changes and changed baseline fills cannot be reported as trial profit", () => {
  const current = snapshot(); current.equity += 10;
  const report = createDistributionTrialReport(baseline(), current);
  assert.equal(report.account.equityDeltaUsd, 10); assert.equal(report.account.trialEquityDeltaUsd, null);
  assert.ok(report.completeness.reasons.includes("ACCOUNT_DELTA_DOES_NOT_RECONCILE"));
  const changed = snapshot(); changed.orders[0]!.updatedMs = atMs + 1;
  assert.ok(createDistributionTrialReport(baseline(), changed).completeness.reasons
    .includes("BASELINE_FILLED_ORDER_CHANGED_AFTER_START"));
});

test("open gross midpoint P&L is reported separately without copying net liquidation estimates", () => {
  const current = snapshot(), livePosition = { active: true, entryOrderId: "open", openedMs: atMs + 100,
    qty: .1, entryPx: 100, unrealizedPnl: 999, realizedPnl: null };
  current.orders.push(order("open", { filledQty: .1, averageFillPx: 100, livePosition }));
  current.positions.push({ active: true, symbol: "BTC/USD", side: 1, qty: .1, entryPx: 100, openedMs: atMs + 100 });
  current.equity += .99;
  const report = createDistributionTrialReport(baseline(), current);
  assert.equal(report.account.attributableToTrial, true); assert.equal(report.counts.openTrades, 1);
  assert.equal(report.actualOutcomes.openGrossMarkPnlUsd, 1); assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, 0);
  assert.ok(Math.abs(report.account.trialEquityDeltaUsd! - .99) < 1e-8);
  assert.equal(report.actualOutcomes.maximumDrawdownUsd, null);
  current.markets[0]!.stale = true;
  const stale = createDistributionTrialReport(baseline(), current);
  assert.equal(stale.actualOutcomes.openGrossMarkPnlUsd, null); assert.equal(stale.account.trialEquityDeltaUsd, null);
});

test("broken closed ledger and partial exits are never manufactured into completed zero-profit trades", () => {
  const broken = snapshot(); broken.orders.push(...closedTrade()); broken.equity += .98;
  for (const order of broken.orders.slice(-2)) (order.livePosition!.realizedBreakdown as { realizedPnl: number }).realizedPnl = 100;
  const bad = createDistributionTrialReport(baseline(), broken);
  assert.equal(bad.counts.closedTrades, 0); assert.equal(bad.counts.unresolvedFilledEntries, 1);
  assert.equal(bad.actualOutcomes.closedTradeNetPnlUsd, null);
  const current = snapshot();
  current.orders.push(order("partial", { filledQty: .1, averageFillPx: 100,
    livePosition: { active: true, entryOrderId: "partial", openedMs: atMs + 100 } }));
  current.orders.push(order("partial-exit", { filledQty: .04, averageFillPx: 110, reduceOnlyIntent: true, side: -1,
    livePosition: { active: false, entryOrderId: "partial" } }));
  current.positions.push({ active: true, symbol: "BTC/USD", side: 1, qty: .06, entryPx: 100, openedMs: atMs + 100 });
  current.equity += .99;
  const partial = createDistributionTrialReport(baseline(), current);
  assert.equal(partial.counts.openTrades, 1); assert.equal(partial.counts.closedTrades, 0);
  assert.equal(partial.completeness.closedLedgerComplete, false); assert.equal(partial.actualOutcomes.closedTradeNetPnlUsd, null);
});

test("duplicate orders and incomplete telemetry are explicit completeness failures", () => {
  const current = snapshot(); current.orders.push({ ...current.orders[0]! });
  const duplicate = createDistributionTrialReport(baseline(), current);
  assert.ok(duplicate.completeness.reasons.includes("DUPLICATE_ORDER_IDS"));
  assert.equal(duplicate.account.trialEquityDeltaUsd, null);
  const dropped = snapshot(); dropped.database.droppedRecords = 1;
  assert.ok(createDistributionTrialReport(baseline(), dropped).completeness.reasons.includes("TELEMETRY_INCOMPLETE_OR_UNCONFIRMED"));
});

test("invalid baseline, wrong account mode and future order timestamps fail before reporting", () => {
  for (const patch of [{ positions: 1 }, { entryMode: "VALIDATED" }, { selectionPolicyVersion: "wrong" },
    { equity: NaN }, { orderIds: ["duplicate", "duplicate"] }]) {
    assert.throws(() => createDistributionTrialReport({ ...baseline(), ...patch }, snapshot()), /INVALID_TRIAL_BASELINE/);
  }
  assert.throws(() => createDistributionTrialReport(baseline(), { ...snapshot(), mode: "live" }), /INVALID_TRIAL_DASHBOARD/);
  assert.throws(() => createDistributionTrialReport(baseline(), { ...snapshot(), generatedAtMs: atMs - 1 }), /INVALID_TRIAL_DASHBOARD/);
  const future = snapshot(); future.orders.push(order("future", { updatedMs: atMs + 100_000 }));
  assert.throws(() => createDistributionTrialReport(baseline(), future), /INVALID_TRIAL_ORDER/);
});

test("historical, current and efficient paper policies each attribute matching closed trades to their own baseline", () => {
  const policies = [DISTRIBUTION_TRIAL_POLICY, DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL.selectionPolicyVersion,
    DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT.selectionPolicyVersion] as const;
  for (const policy of policies) {
    const b: DistributionTrialBaseline = { ...baseline(), trialId: `trial-${policy}`, selectionPolicyVersion: policy };
    const current = snapshot(), trade = closedTrade();
    trade[0]!.distributionDecision = { entryMode: "PAPER_TRIAL", selectionPolicyVersion: policy };
    current.orders.push(...trade); current.equity += .98;
    const report = createDistributionTrialReport(b, current);
    assert.equal(report.selectionPolicyVersion, policy); assert.equal(report.trialId, b.trialId);
    assert.equal(report.counts.entryAttempts, 1); assert.equal(report.counts.closedTrades, 1);
    assert.equal(report.account.attributableToTrial, true);
    assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, .98);
  }
});

test("recognizing multiple paper policies does not mix their orders or account returns across baselines", () => {
  const policies = [DISTRIBUTION_TRIAL_POLICY, DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL.selectionPolicyVersion,
    DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT.selectionPolicyVersion] as const;
  for (const baselinePolicy of policies) for (const orderPolicy of policies) {
    if (baselinePolicy === orderPolicy) continue;
    const b: DistributionTrialBaseline = { ...baseline(), selectionPolicyVersion: baselinePolicy };
    const current = snapshot(), trade = closedTrade();
    trade[0]!.distributionDecision = { entryMode: "PAPER_TRIAL", selectionPolicyVersion: orderPolicy };
    current.orders.push(...trade); current.equity += .98;
    const report = createDistributionTrialReport(b, current);
    assert.equal(report.counts.entryAttempts, 0); assert.equal(report.counts.closedTrades, 0);
    assert.equal(report.account.attributableToTrial, false);
    assert.equal(report.account.trialEquityDeltaUsd, null);
    assert.equal(report.actualOutcomes.closedTradeNetPnlUsd, null);
    assert.ok(report.completeness.reasons.includes("OTHER_POLICY_OR_UNLINKED_ORDERS"));
  }
});

test("efficient trial attribution retains baseline time and trial identity checks and rejects unknown policies", () => {
  const policy = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT.selectionPolicyVersion;
  const b: DistributionTrialBaseline = { ...baseline(), selectionPolicyVersion: policy, trialId: "fresh-efficient-trial" };
  for (const extra of [
    order("before-efficient-baseline", { createdMs: atMs - 100, updatedMs: atMs - 50,
      distributionDecision: { entryMode: "PAPER_TRIAL", selectionPolicyVersion: policy } }),
    order("different-efficient-trial", { distributionDecision: { entryMode: "PAPER_TRIAL",
      selectionPolicyVersion: policy, trialId: "previous-efficient-trial" } }),
  ]) {
    const current = snapshot(); current.orders.push(extra);
    const report = createDistributionTrialReport(b, current);
    assert.equal(report.counts.entryAttempts, 0); assert.equal(report.account.attributableToTrial, false);
    assert.equal(report.account.trialEquityDeltaUsd, null);
  }
  for (const invalid of [DISTRIBUTION_ENTRY_PROFILES.VALIDATED.selectionPolicyVersion,
    "btc-eth-selected-policy-paper-trial-3d-efficient-v2", "btc-eth-selected-policy-paper-trial-3d-v999"]) {
    assert.throws(() => createDistributionTrialReport({ ...b, selectionPolicyVersion: invalid }, snapshot()), /INVALID_TRIAL_BASELINE/);
  }
});
