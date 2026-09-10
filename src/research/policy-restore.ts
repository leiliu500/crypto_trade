import type { KrakenPaperHistory } from "../kraken/paper-broker.js";
import type { VenuePosition } from "../venue/types.js";
import type { Position } from "../strategy/position-manager.js";
import { findPolicy } from "./trading-policy.js";
import { newLinearLedger, recordLinearFill } from "../economics/net-liquidation.js";

/** Recover a filled policy order even if the process died before its first DB
 * position snapshot. The paper broker's own durable fill ledger is authoritative. */
export function recoverPolicyPositions(history: KrakenPaperHistory, remote: readonly VenuePosition[],
  stored: readonly Position[]): Position[] {
  const result = [...stored];
  for (const p of remote) {
    const symbol = p.symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const side = p.side === "long" ? 1 : -1;
    const entryPx = Number(p.avg_entry_price), qty = Number(p.qty);
    const entry = history.orders.filter((o) => o.plan.symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase() === symbol
      && !o.plan.reduceOnlyIntent && Number(o.remote.filled_qty) > 0)
      .sort((a, b) => Date.parse(b.remote.created_at) - Date.parse(a.remote.created_at))[0];
    if (!entry || (!entry.plan.policy && entry.plan.systematic === undefined) || entry.plan.side !== side || !(qty > 0) || !(entryPx > 0)
      || Math.abs(Number(entry.remote.filled_avg_price) - entryPx) > Math.max(1e-8, entryPx * 1e-6)) continue;
    const previousIndex = result.findIndex((s) => s.symbol === entry.plan.symbol && s.side === side
      && Math.abs(s.entryPx - entryPx) <= Math.max(1e-8, entryPx * 1e-6));
    const previous = previousIndex >= 0 ? result[previousIndex] : undefined;
    const sameSystematicLifecycle = entry.plan.systematic !== undefined && previous?.systematic !== undefined
      && previous.systematic?.signalId === entry.plan.systematic?.signalId
      && Math.abs(previous.qty - qty) < 1e-8 && Math.abs((previous.ledger?.remainingQty ?? NaN) - qty) < 1e-8;
    if (sameSystematicLifecycle || (entry.plan.systematic === undefined && previous?.policy)) continue;
    // A partially filled IOC is canceled with no filled_at. Its observed first
    // fill, not the process wall clock at order creation, starts the holding age.
    const entryFillTimes = history.activities.filter(activity => activity.order_id === entry.remote.id)
      .map(activity => Date.parse(activity.transaction_time ?? "")).filter(Number.isFinite);
    const openedMs = entryFillTimes.length ? Math.min(...entryFillTimes)
      : Date.parse(entry.remote.filled_at ?? entry.remote.created_at);
    if (!Number.isFinite(openedMs)) continue;
    const systematicStop = entryPx * Number(entry.plan.systematic?.stopBps) / 10_000;
    const initialRiskPx = entry.plan.systematic !== undefined
      ? Number.isFinite(systematicStop) && systematicStop > 0 && systematicStop < entryPx
        ? systematicStop : entryPx * .01
      : entry.plan.risk.maximumLossPerUnit;
    const restored: Position = { symbol: entry.plan.symbol, side, qty, entryPx, openedMs, initialRiskPx,
      roundTripCostPx: entryPx * entry.plan.expectedCost.roundTripBps / 10_000,
      mfePx: 0, maePx: 0, floorPx: entry.plan.systematic !== undefined ? -initialRiskPx
        : -entryPx * (findPolicy(entry.plan.policy!.id)?.stopLossBps ?? 0) / 10_000,
      breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER",
      ...(entry.plan.policy ? { policy: { ...entry.plan.policy } } : {}),
      ...(entry.plan.systematic !== undefined ? { systematic: structuredClone(entry.plan.systematic) } : {}),
      ...(entry.plan.entryFamily ? { entryFamily: entry.plan.entryFamily } : {}),
      ...(entry.plan.economicHorizonMs ? { selectedHorizonMs: entry.plan.economicHorizonMs } : {}) };
    if (entry.plan.systematic !== undefined || entry.plan.policy?.id.startsWith("retest-")) {
      const ledger = newLinearLedger(side);
      const orders = new Map(history.orders.map((o) => [o.remote.id, o]));
      const start = Math.min(Date.parse(entry.remote.created_at), openedMs);
      let completeFees = true;
      for (const activity of [...history.activities].reverse()) {
        const order = orders.get(activity.order_id ?? "");
        if (!order || order.plan.symbol !== entry.plan.symbol || Date.parse(activity.transaction_time ?? "") < start
          || (order.remote.id !== entry.remote.id && !order.plan.reduceOnlyIntent)) continue;
        const fee = activity.fee_usd === undefined ? NaN : Number(activity.fee_usd);
        if (!Number.isFinite(fee)) { completeFees = false; break; }
        try { recordLinearFill(ledger, Number(activity.qty), Number(activity.price), fee, order.plan.reduceOnlyIntent); }
        catch { completeFees = false; break; }
      }
      if (completeFees && Math.abs(ledger.remainingQty - qty) < 1e-8) restored.ledger = ledger;
      // Without an acknowledged prior floor, recovery cannot reconstruct the
      // unobserved peak. Close under the uncertainty path instead of loosening.
      restored.phase = "EXITING";
    }
    if (previousIndex >= 0) result[previousIndex] = { ...result[previousIndex]!, ...restored };
    else result.push(restored);
  }
  return result;
}
