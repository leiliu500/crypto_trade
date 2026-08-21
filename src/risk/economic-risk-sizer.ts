import { clamp } from "../core/market.js";

/** Economic scale is continuous after the sole binary cost-quality decision. */
export function scaleEconomicQuantity(baseQuantity: number, lowerBoundNetBps: number,
  minimumNetEdgeBps: number, fullQualityEdgeBps: number, minimumScale: number): number {
  if (!(baseQuantity > 0) || lowerBoundNetBps < minimumNetEdgeBps) return 0;
  const progress = (lowerBoundNetBps - minimumNetEdgeBps) / Math.max(fullQualityEdgeBps - minimumNetEdgeBps, 1e-9);
  return baseQuantity * clamp(minimumScale + (1 - minimumScale) * progress, minimumScale, 1);
}
