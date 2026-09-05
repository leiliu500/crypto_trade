import type { KrakenPaperHistory } from "../kraken/paper-broker.js";
import type { VenuePosition } from "../venue/types.js";
import type { Position } from "../strategy/position-manager.js";
import { findPolicy } from "./trading-policy.js";

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
    if (!entry?.plan.policy || entry.plan.side !== side || !(qty > 0) || !(entryPx > 0)
      || Math.abs(Number(entry.remote.filled_avg_price) - entryPx) > Math.max(1e-8, entryPx * 1e-6)) continue;
    const previousIndex = result.findIndex((s) => s.symbol === entry.plan.symbol && s.side === side
      && Math.abs(s.entryPx - entryPx) <= Math.max(1e-8, entryPx * 1e-6));
    if (previousIndex >= 0 && result[previousIndex]!.policy) continue;
    const openedMs = Date.parse(entry.remote.filled_at ?? entry.remote.created_at);
    if (!Number.isFinite(openedMs)) continue;
    const initialRiskPx = entry.plan.risk.maximumLossPerUnit;
    const restored: Position = { symbol: entry.plan.symbol, side, qty, entryPx, openedMs, initialRiskPx,
      roundTripCostPx: entryPx * entry.plan.expectedCost.roundTripBps / 10_000,
      mfePx: 0, maePx: 0, floorPx: -entryPx * (findPolicy(entry.plan.policy.id)?.stopLossBps ?? 0) / 10_000,
      breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER",
      policy: { ...entry.plan.policy },
      ...(entry.plan.entryFamily ? { entryFamily: entry.plan.entryFamily } : {}),
      ...(entry.plan.economicHorizonMs ? { selectedHorizonMs: entry.plan.economicHorizonMs } : {}) };
    if (previousIndex >= 0) result[previousIndex] = { ...result[previousIndex]!, ...restored };
    else result.push(restored);
  }
  return result;
}
