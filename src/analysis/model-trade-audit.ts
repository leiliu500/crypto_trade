import type { DashboardOrderCard } from "../dashboard/types.js";
import { CROSS_ASSET_SPEC, crossAssetPaperCandidate } from "../research/cross-asset-model.js";

export type ModelAuditOrder = Pick<DashboardOrderCard, "clientOrderId" | "symbol" | "side" | "modelVersion"
  | "configurationVersion" | "crossAssetEntryMode" | "crossAssetForecast" | "reduceOnlyIntent" | "filledQty"
  | "averageFillPx" | "createdMs" | "updatedMs" | "terminal" | "livePosition" | "exitReason">
  & { telemetryDroppedRecords?: number | null };

/** Read-only attribution. Full-position ledgers may be copied to several order
 * cards: never sum those copies as if they were independent trades. */
export function auditModelTrades(input: readonly ModelAuditOrder[], configurationVersion: string, cutoffMs: number) {
  if (!configurationVersion || !Number.isFinite(cutoffMs)) throw new Error("INVALID_MODEL_AUDIT_SCOPE");
  const orders = new Map<string, ModelAuditOrder>();
  let excludedAfterCutoff = 0;
  for (const order of input) {
    if (!Number.isFinite(order.createdMs) || !Number.isFinite(order.updatedMs)
      || order.createdMs > cutoffMs || order.updatedMs > cutoffMs) { excludedAfterCutoff++; continue; }
    const previous = orders.get(order.clientOrderId);
    if (!previous || previous.updatedMs < order.updatedMs) orders.set(order.clientOrderId, order);
  }
  const entries = [...orders.values()].filter(o => !o.reduceOnlyIntent
    && o.configurationVersion === configurationVersion && o.modelVersion === CROSS_ASSET_SPEC.version);
  const trades = entries.sort((a, b) => a.createdMs - b.createdMs || a.clientOrderId.localeCompare(b.clientOrderId)).map(entry => {
    const exits = [...orders.values()].filter(o => o.reduceOnlyIntent && o.symbol === entry.symbol
      && o.side === -entry.side && o.filledQty > 0 && o.livePosition?.entryOrderId === entry.clientOrderId
      && o.livePosition.active === false && o.livePosition.closedAtMs !== null
      && Number.isFinite(o.livePosition.closedAtMs) && o.livePosition.closedAtMs <= cutoffMs
      && o.livePosition.closedAtMs >= entry.createdMs && Number.isFinite(o.livePosition.realizedPnl))
      .filter(o => Math.abs(o.livePosition!.qty - entry.filledQty) <= Math.max(1e-12, entry.filledQty * 1e-8))
      .sort((a, b) => b.livePosition!.closedAtMs! - a.livePosition!.closedAtMs! || b.updatedMs - a.updatedMs);
    const exit = exits[0], position = exit?.livePosition;
    const breakdown = position?.realizedBreakdown;
    const netPnl = position?.realizedPnl ?? null;
    const reconciled = breakdown && netPnl !== null
      && [breakdown.grossPricePnl, breakdown.entryFee, breakdown.exitFee, breakdown.realizedPnl].every(Number.isFinite)
      && breakdown.entryFee >= 0 && breakdown.exitFee >= 0
      && Math.abs(breakdown.realizedPnl - netPnl) < 1e-8
      && Math.abs(breakdown.grossPricePnl - breakdown.entryFee - breakdown.exitFee - netPnl) < 1e-8;
    const forecast = entry.crossAssetForecast;
    const validForecast = forecast?.side === entry.side
      && Boolean(crossAssetPaperCandidate(forecast ?? undefined, entry.symbol, entry.createdMs, true));
    const filled = Number.isFinite(entry.filledQty) && entry.filledQty > 0;
    const state = !filled ? entry.terminal ? "UNFILLED" : "PENDING"
      : exit ? "CLOSED" : entry.livePosition?.active === true ? "OPEN" : "UNRESOLVED";
    const notional = filled && Number.isFinite(entry.averageFillPx) && entry.averageFillPx > 0
      ? entry.filledQty * entry.averageFillPx : null;
    return { entryOrderId: entry.clientOrderId, symbol: entry.symbol, side: entry.side,
      entryMode: entry.crossAssetEntryMode ?? "UNKNOWN", entryAtMs: entry.createdMs,
      exitAtMs: position?.closedAtMs ?? null, state, filled, notional,
      exitReason: exit?.exitReason ?? null, netPnl: state === "CLOSED" ? netPnl : null,
      netBps: state === "CLOSED" && netPnl !== null && notional ? netPnl / notional * 10_000 : null,
      grossPnl: reconciled ? breakdown.grossPricePnl : null,
      fees: reconciled ? breakdown.entryFee + breakdown.exitFee : null,
      cleanTelemetry: entry.telemetryDroppedRecords === 0 && (!exit || exit.telemetryDroppedRecords === 0),
      forecastValid: validForecast, forecastAtMs: validForecast ? forecast!.atMs : null,
      predictedDirectionalGrossBps: validForecast ? entry.side * forecast!.predictedGrossBps : null,
      costHurdleBps: validForecast ? forecast!.costHurdleBps : null,
      conservativeNetBps: validForecast ? forecast!.conservativeNetBps : null,
      passesCostScreen: validForecast ? entry.side * forecast!.predictedGrossBps > forecast!.costHurdleBps : null,
      passesConservativeScreen: validForecast ? forecast!.eligible && forecast!.conservativeNetBps > 0 : null };
  });
  type Trade = typeof trades[number];
  const stats = (rows: readonly Trade[]) => {
    const closed = rows.filter(r => r.state === "CLOSED" && r.netPnl !== null);
    const attributed = closed.filter(r => r.fees !== null && r.grossPnl !== null);
    return { attempts: rows.length, filled: rows.filter(r => r.filled).length, closed: closed.length,
      open: rows.filter(r => r.state === "OPEN").length, unresolved: rows.filter(r => r.state === "UNRESOLVED").length,
      pending: rows.filter(r => r.state === "PENDING").length, unfilled: rows.filter(r => r.state === "UNFILLED").length,
      wins: closed.filter(r => r.netPnl! > 0).length, netPnl: closed.length ? sum(closed.map(r => r.netPnl!)) : null,
      attributedClosed: attributed.length, missingCostBreakdowns: closed.length - attributed.length,
      attributedGrossPnl: attributed.length ? sum(attributed.map(r => r.grossPnl!)) : null,
      attributedFees: attributed.length ? sum(attributed.map(r => r.fees!)) : null,
      grossWinnersLostAfterFees: attributed.filter(r => r.grossPnl! > 0 && r.netPnl! < 0).length,
      forecastMissingOrInvalid: rows.filter(r => !r.forecastValid).length,
      belowCostHurdle: rows.filter(r => r.passesCostScreen === false).length,
      telemetryUncleanOrUnknown: rows.filter(r => !r.cleanTelemetry).length };
  };
  // Compare filters on the original attempt panel. A skipped trade contributes
  // zero; it does not free capital or invent an unobserved replacement trade.
  const panel = trades.filter(t => t.forecastValid && t.cleanTelemetry
    && (t.state === "CLOSED" && t.netPnl !== null || t.state === "UNFILLED"));
  const entryScreens = ["EVALUATION", "COST_COVERED", "CONSERVATIVE"] as const;
  return { generatedAtMs: cutoffMs, configurationVersion, modelVersion: CROSS_ASSET_SPEC.version,
    summary: stats(trades), excludedAfterCutoff,
    groups: [...new Set(trades.map(t => JSON.stringify([t.symbol, t.side, t.entryMode])))].sort().map(key =>
      ({ key, ...stats(trades.filter(t => JSON.stringify([t.symbol, t.side, t.entryMode]) === key)) })),
    entryScreenComparison: { panelAttempts: panel.length, excludedAttempts: trades.length - panel.length,
      screens: entryScreens.map(screen => {
        const selected = panel.filter(t => screen === "EVALUATION"
          || (screen === "COST_COVERED" ? t.passesCostScreen : t.passesConservativeScreen));
        const pnl = sum(selected.map(t => t.netPnl ?? 0));
        return { screen, acceptedAttempts: selected.length, skippedAttempts: panel.length - selected.length,
          closed: selected.filter(t => t.state === "CLOSED").length,
          netPnl: panel.length ? pnl : null, meanPnlPerOriginalAttempt: panel.length ? pnl / panel.length : null };
      }) },
    feeSensitivity: [0, .5, 1, 1.5].map(multiplier => {
      const rows = trades.filter(t => t.state === "CLOSED" && t.fees !== null && t.grossPnl !== null);
      return { multiplier, closed: rows.length,
        hypotheticalNetPnl: rows.length ? sum(rows.map(t => t.grossPnl! - multiplier * t.fees!)) : null };
    }), trades, deploymentReady: false,
    limitations: ["Paper fills only; this audit cannot establish live profitability or promote a strategy",
      "Entry screens share recorded attempts; skipping an entry does not simulate replacement opportunities",
      "Fee sensitivity holds fills and prices fixed; cheaper execution may change fills and adverse selection",
      "Forecast targets are 15-minute midpoint returns, not realized stop/target trade returns",
      "Partial-exit ledgers without a full-position aggregate remain unresolved instead of being counted as closed trades",
      "Open, unresolved, unclean and missing-forecast outcomes remain visible; no small-sample confidence claim"] };
}

function sum(values: readonly number[]) { return values.reduce((a, b) => a + b, 0); }
