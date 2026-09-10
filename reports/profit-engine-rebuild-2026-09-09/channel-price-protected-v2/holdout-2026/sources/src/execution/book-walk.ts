import type { Level } from "../core/market.js";

export interface SweepEstimate { filledQty: number; vwap: number; worstPx: number; notional: number; }

export function estimateSweep(levels: readonly Level[], requestedQty: number, priceCap?: number): SweepEstimate | null {
  if (!(requestedQty > 0) || !Number.isFinite(requestedQty)) return null;
  let remaining = requestedQty, notional = 0, filled = 0, worstPx = 0;
  const ascending = levels.length < 2 || levels[0]!.px <= levels[1]!.px;
  for (const level of levels) {
    if (remaining <= 1e-12) break;
    if (!(level.qty > 0) || !(level.px > 0)) continue;
    if (priceCap !== undefined && (ascending ? level.px > priceCap : level.px < priceCap)) break;
    const take = Math.min(remaining, level.qty);
    notional += take * level.px; filled += take; remaining -= take; worstPx = level.px;
  }
  if (remaining > 1e-9 * requestedQty || filled <= 0) return null;
  return { filledQty: filled, vwap: notional / filled, worstPx, notional };
}
