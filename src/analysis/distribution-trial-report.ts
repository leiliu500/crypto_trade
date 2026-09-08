import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardOrderCard, DashboardSnapshot } from "../dashboard/types.js";
import { DISTRIBUTION_ENTRY_PROFILES } from "../distribution/spec.js";

export const DISTRIBUTION_TRIAL_BASELINE_VERSION = "distribution-paper-trial-baseline-v1";
export const DISTRIBUTION_TRIAL_POLICY = "btc-eth-selected-policy-paper-trial-3d-v1";
type CanonicalPaperProfile = Extract<(typeof DISTRIBUTION_ENTRY_PROFILES)[keyof typeof DISTRIBUTION_ENTRY_PROFILES],
  { entryMode: "PAPER_TRIAL" }>;
export type DistributionTrialPolicyVersion = typeof DISTRIBUTION_TRIAL_POLICY | CanonicalPaperProfile["selectionPolicyVersion"];
const trialPolicies = new Set<string>([DISTRIBUTION_TRIAL_POLICY, ...Object.values(DISTRIBUTION_ENTRY_PROFILES)
  .filter(profile => profile.entryMode === "PAPER_TRIAL").map(profile => profile.selectionPolicyVersion)]);
export interface DistributionTrialBaseline {
  version: typeof DISTRIBUTION_TRIAL_BASELINE_VERSION; trialId: string; startedAtMs: number;
  entryMode: "PAPER_TRIAL"; selectionPolicyVersion: DistributionTrialPolicyVersion;
  equity: number; orderIds: string[]; positions: 0;
}
const limit = 100;
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Read-only, time-bounded attribution. Account equity already includes paid
 * fees. UTC-session P&L and hypothetical model outcomes never enter this ledger. */
export function createDistributionTrialReport(baselineValue: unknown, currentDashboard: unknown) {
  const baseline = baselineValue as DistributionTrialBaseline, current = currentDashboard as DashboardSnapshot;
  if (!baseline || baseline.version !== DISTRIBUTION_TRIAL_BASELINE_VERSION || typeof baseline.trialId !== "string"
    || !baseline.trialId || !Number.isSafeInteger(baseline.startedAtMs) || baseline.startedAtMs < 0
    || baseline.entryMode !== "PAPER_TRIAL" || !trialPolicies.has(baseline.selectionPolicyVersion)
    || !Number.isFinite(baseline.equity) || baseline.equity <= 0 || baseline.positions !== 0
    || !Array.isArray(baseline.orderIds) || baseline.orderIds.length > 25_000
    || baseline.orderIds.some(id => typeof id !== "string" || !id)
    || new Set(baseline.orderIds).size !== baseline.orderIds.length) throw new Error("INVALID_TRIAL_BASELINE");
  if (!current || current.mode !== "paper" || current.paper !== true || !Number.isSafeInteger(current.generatedAtMs)
    || current.generatedAtMs < baseline.startedAtMs || !Number.isFinite(current.equity)
    || !Array.isArray(current.orders) || current.orders.length > 25_000 || !Array.isArray(current.positions)
    || current.positions.some(position => !position || typeof position.symbol !== "string"
      || typeof position.active !== "boolean" || !Number.isFinite(position.qty) || position.qty < 0)
    || !Array.isArray(current.markets)) throw new Error("INVALID_TRIAL_DASHBOARD");
  const reasons = new Set<string>(), unique = new Map<string, DashboardOrderCard>();
  for (const order of current.orders) {
    if (!order || typeof order.clientOrderId !== "string" || !order.clientOrderId
      || !Number.isSafeInteger(order.createdMs) || !Number.isSafeInteger(order.updatedMs)
      || order.createdMs < 0 || order.updatedMs < order.createdMs || order.updatedMs > current.generatedAtMs
      || !Number.isFinite(order.filledQty) || order.filledQty < 0
      || typeof order.reduceOnlyIntent !== "boolean" || typeof order.terminal !== "boolean") {
      throw new Error("INVALID_TRIAL_ORDER");
    }
    const previous = unique.get(order.clientOrderId);
    if (previous) reasons.add("DUPLICATE_ORDER_IDS");
    if (!previous || previous.updatedMs < order.updatedMs) unique.set(order.clientOrderId, order);
  }
  const orders = [...unique.values()], oldIds = new Set(baseline.orderIds);
  const missingBaselineOrderIds = baseline.orderIds.filter(id => !unique.has(id));
  if (missingBaselineOrderIds.length) reasons.add("BASELINE_ORDERS_MISSING_FROM_SNAPSHOT");
  if (orders.some(order => oldIds.has(order.clientOrderId) && order.filledQty > 0 && order.updatedMs > baseline.startedAtMs))
    reasons.add("BASELINE_FILLED_ORDER_CHANGED_AFTER_START");
  const added = orders.filter(order => !oldIds.has(order.clientOrderId));
  if (added.some(order => order.createdMs < baseline.startedAtMs)) reasons.add("UNRECORDED_PRE_BASELINE_ORDER");
  const trialEntry = (order: DashboardOrderCard) => {
    const decision = order.distributionDecision as (DashboardOrderCard["distributionDecision"] & { trialId?: string });
    return !order.reduceOnlyIntent && order.createdMs >= baseline.startedAtMs
      && decision?.entryMode === baseline.entryMode && decision.selectionPolicyVersion === baseline.selectionPolicyVersion
      && (decision.trialId === undefined || decision.trialId === baseline.trialId);
  };
  const entries = added.filter(trialEntry), entryIds = new Set(entries.map(order => order.clientOrderId));
  const otherOrders = added.filter(order => !entryIds.has(order.clientOrderId)
    && !(order.reduceOnlyIntent && entryIds.has(order.livePosition?.entryOrderId ?? "")));
  if (otherOrders.length) reasons.add("OTHER_POLICY_OR_UNLINKED_ORDERS");
  if (!current.database || current.database.connected !== true || current.database.droppedRecords !== 0
    || current.database.queuedRecords !== 0) reasons.add("TELEMETRY_INCOMPLETE_OR_UNCONFIRMED");
  const activePositions = current.positions.filter(position => position.active !== false && position.qty > 0);
  const attributedPositions = new Set<typeof activePositions[number]>();
  const trades = entries.map(entry => {
    const filled = entry.filledQty > 0;
    const exits = orders.filter(order => order.reduceOnlyIntent && order.filledQty > 0
      && order.livePosition?.entryOrderId === entry.clientOrderId);
    const exitedQty = sum(exits.map(order => order.filledQty)), remainingQty = entry.filledQty - exitedQty;
    const fillsValid = filled && [entry.averageFillPx, entry.filledQty].every(n => Number.isFinite(n) && n > 0)
      && [1, -1].includes(entry.side) && exits.every(exit => exit.symbol === entry.symbol && exit.side === -entry.side
        && Number.isFinite(exit.averageFillPx) && exit.averageFillPx > 0 && exit.createdMs >= entry.createdMs);
    const matchingPosition = activePositions.find(position => position.symbol === entry.symbol && position.side === entry.side
      && entry.livePosition?.active === true && entry.livePosition.entryOrderId === entry.clientOrderId
      && position.openedMs === entry.livePosition.openedMs && close(position.entryPx, entry.averageFillPx)
      && remainingQty > 0 && close(position.qty, remainingQty));
    if (matchingPosition) attributedPositions.add(matchingPosition);
    const fullyExited = fillsValid && close(exitedQty, entry.filledQty) && exits.length > 0;
    const grossFromFills = fullyExited ? entry.side * (sum(exits.map(exit => exit.filledQty * exit.averageFillPx))
      - entry.filledQty * entry.averageFillPx) : null;
    // Full-position ledgers are copied to entry and exit cards. Reconcile one
    // complete ledger against all actual exit quantities, then count it once.
    const ledgers = [entry, ...exits].flatMap(order => {
      const p = order.livePosition, b = p?.realizedBreakdown;
      return fullyExited && p?.entryOrderId === entry.clientOrderId && !p.active && p.closedAtMs !== null
        && Number.isSafeInteger(p.closedAtMs) && p.closedAtMs >= entry.createdMs && p.closedAtMs <= current.generatedAtMs
        && close(p.qty, entry.filledQty) && exits.some(exit => exit.clientOrderId === p.exitOrderId)
        && b && [b.grossPricePnl, b.entryFee, b.exitFee, b.realizedPnl, p.realizedPnl].every(Number.isFinite)
        && b.entryFee >= 0 && b.exitFee >= 0 && close(b.grossPricePnl, grossFromFills!)
        && close(b.realizedPnl, b.grossPricePnl - b.entryFee - b.exitFee) && close(b.realizedPnl, p.realizedPnl!)
        ? [{ ...b, atMs: p.closedAtMs }] : [];
    });
    const ledger = ledgers[0], reconciled = ledger !== undefined && ledgers.every(other =>
      close(other.realizedPnl, ledger.realizedPnl) && close(other.entryFee, ledger.entryFee) && close(other.exitFee, ledger.exitFee));
    const state = !filled ? entry.terminal ? "UNFILLED" : "PENDING"
      : fullyExited && reconciled && !matchingPosition ? "CLOSED" : fillsValid && matchingPosition ? "OPEN" : "UNRESOLVED";
    const market = current.markets.find(m => m.symbol === entry.symbol);
    const mark = market?.bookValid && !market.stale && Number.isFinite(market.bestBid) && Number.isFinite(market.bestAsk)
      && market.bestBid! > 0 && market.bestAsk! > market.bestBid! ? (market.bestBid! + market.bestAsk!) / 2 : null;
    const openGrossMarkPnl = state === "OPEN" && mark !== null
      ? entry.side * remainingQty * (mark - entry.averageFillPx) : null;
    const notional = filled && fillsValid ? entry.filledQty * entry.averageFillPx : null;
    return { entryOrderId: entry.clientOrderId, symbol: entry.symbol, side: entry.side, createdMs: entry.createdMs,
      state, filled, entryPending: !entry.terminal, filledQty: entry.filledQty, exitedQty,
      entryNotionalUsd: notional, closedAtMs: state === "CLOSED" ? ledger!.atMs : null,
      realizedNetPnlUsd: state === "CLOSED" ? ledger!.realizedPnl : null,
      realizedNetBps: state === "CLOSED" && notional ? ledger!.realizedPnl / notional * 10_000 : null,
      grossClosedPnlUsd: state === "CLOSED" ? ledger!.grossPricePnl : null,
      closedFeesUsd: state === "CLOSED" ? ledger!.entryFee + ledger!.exitFee : null,
      openGrossMarkPnlUsd: openGrossMarkPnl,
      partialExit: state === "OPEN" && exitedQty > 0 };
  });
  if (activePositions.length !== attributedPositions.size) reasons.add("UNATTRIBUTED_OPEN_POSITIONS");
  if (trades.some(t => t.state === "UNRESOLVED")) reasons.add("UNRESOLVED_FILLED_ENTRIES");
  if (trades.some(t => t.state === "OPEN" && t.openGrossMarkPnlUsd === null)) reasons.add("OPEN_POSITION_MARK_UNAVAILABLE");
  const closed = trades.filter(t => t.state === "CLOSED"), opened = trades.filter(t => t.state === "OPEN");
  const ledgerComplete = !trades.some(t => t.state === "UNRESOLVED" || t.partialExit);
  const closedNet = sum(closed.map(t => t.realizedNetPnlUsd!));
  const equityDelta = current.equity - baseline.equity;
  // A complete flat cohort must reconcile to the account. This also catches a
  // cash adjustment or missing filled orders when no trial fill is visible.
  if (!activePositions.length && ledgerComplete && !close(equityDelta, closedNet)) reasons.add("ACCOUNT_DELTA_DOES_NOT_RECONCILE");
  const attributable = reasons.size === 0;
  const positive = sum(closed.map(t => Math.max(0, t.realizedNetPnlUsd!))), losses = -sum(closed.map(t => Math.min(0, t.realizedNetPnlUsd!)));
  const shadow = current.markets.find(m => m.distributional)?.distributional?.statistics;
  return { version: "distribution-paper-trial-report-v1", trialId: baseline.trialId,
    startedAtMs: baseline.startedAtMs, capturedAtMs: current.generatedAtMs,
    elapsedMs: current.generatedAtMs - baseline.startedAtMs, entryMode: baseline.entryMode,
    selectionPolicyVersion: baseline.selectionPolicyVersion,
    account: { baselineEquityUsd: baseline.equity, currentEquityUsd: current.equity,
      equityDeltaUsd: equityDelta, trialEquityDeltaUsd: attributable ? equityDelta : null,
      attributableToTrial: attributable, feesAlreadyIncluded: true },
    counts: { entryAttempts: entries.length, filledEntries: trades.filter(t => t.filled).length,
      unfilledTerminalEntries: trades.filter(t => t.state === "UNFILLED").length,
      pendingUnfilledEntries: trades.filter(t => t.state === "PENDING").length,
      pendingEntryOrders: trades.filter(t => t.entryPending).length,
      closedTrades: closed.length, openTrades: opened.length,
      unresolvedFilledEntries: trades.filter(t => t.state === "UNRESOLVED").length,
      baselineOrdersExcluded: baseline.orderIds.length, otherOrUnlinkedOrders: otherOrders.length },
    actualOutcomes: { closedTradeNetPnlUsd: attributable && ledgerComplete ? closedNet : null,
      closedTradeGrossPnlUsd: attributable && ledgerComplete ? sum(closed.map(t => t.grossClosedPnlUsd!)) : null,
      closedTradeFeesUsd: attributable && ledgerComplete ? sum(closed.map(t => t.closedFeesUsd!)) : null,
      openGrossMarkPnlUsd: attributable && opened.every(t => t.openGrossMarkPnlUsd !== null)
        ? sum(opened.map(t => t.openGrossMarkPnlUsd!)) : null,
      meanClosedNetBps: attributable && ledgerComplete && closed.length ? sum(closed.map(t => t.realizedNetBps!)) / closed.length : null,
      winRate: attributable && ledgerComplete && closed.length ? closed.filter(t => t.realizedNetPnlUsd! > 0).length / closed.length : null,
      profitFactor: attributable && ledgerComplete && losses > 0 ? positive / losses : null,
      maximumDrawdownUsd: null },
    completeness: { attributable, orderCountsAreSnapshotOnly: true, closedLedgerComplete: ledgerComplete,
      reasons: [...reasons], missingBaselineOrders: missingBaselineOrderIds.length,
      missingBaselineOrderIds: missingBaselineOrderIds.slice(0, limit),
      otherOrUnlinkedOrderIds: otherOrders.slice(0, limit).map(o => o.clientOrderId) },
    shadowValidation: shadow?.validation ? structuredClone(shadow.validation) : null,
    trades: trades.slice(-limit), omittedTradeRows: Math.max(0, trades.length - limit),
    profitabilityEstablished: false,
    notes: [
      "Trial cohort is identified by immutable baseline time, entry mode and selection policy; earlier orders and UTC-day session P&L are excluded",
      "Account equity delta already includes paid paper fees; do not subtract fees again",
      "Order counts are a snapshot view; missing, conflicting or unlinked evidence prevents trial P&L attribution",
      "Closed P&L requires a complete position ledger reconciled to actual entry and exit quantities and prices",
      "Open gross mark P&L uses current midpoint and excludes fees; it is not a net liquidation value and must not be added to account equity delta",
      "Partial exits without a reconciled full-position ledger are excluded from closed aggregate P&L",
      "A single snapshot cannot establish maximum drawdown or profitability; zero filled trades provide no empirical profit evidence",
      "Shadow validation contains hypothetical execution outcomes and remains separate from actual paper-account results",
    ] };
}

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("TRIAL_REPORT_INPUT_TOO_LARGE_OR_NOT_FILE");
  return JSON.parse(await readFile(path, "utf8"));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) throw new Error("Usage: distribution-trial-report baseline.json current-dashboard.json");
  const report = createDistributionTrialReport(await readJson(process.argv[2]!), await readJson(process.argv[3]!));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
