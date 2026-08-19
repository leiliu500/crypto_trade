import type { Direction, Features } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { Forecast } from "./forecast.js";
import type { CostEstimate } from "./cost.js";

export interface SignalConfig {
  costSafetyFactor: number;
  minimumDirectionProbability: number;
  minimumNetEdgeBps: number;
  fullQualityEdgeBps: number;
}
export interface TradeIntent {
  side: Direction;
  probability: number;
  predictedGrossBps: number;
  lowerBoundNetBps: number;
  quality: number;
  decisionTsMs: number;
}

export class SignalEngine {
  public constructor(private readonly cfg: SignalConfig) {}
  public evaluate(f: Features, forecast: Forecast, cost: CostEstimate, regimeAllowsLong: boolean, regimeAllowsShort: boolean): TradeIntent | null {
    if (f.stale || !f.warmedUp || forecast.expired) return null;
    if (forecast.side === 1 && !regimeAllowsLong) return null;
    if (forecast.side === -1 && !regimeAllowsShort) return null;
    const lowerBoundNetBps = forecast.grossAtArrivalBps - forecast.residualQ95Bps - this.cfg.costSafetyFactor * cost.roundTripBps;
    if (forecast.probability < this.cfg.minimumDirectionProbability || lowerBoundNetBps < this.cfg.minimumNetEdgeBps) return null;
    return {
      side: forecast.side, probability: forecast.probability,
      predictedGrossBps: forecast.grossAtArrivalBps, lowerBoundNetBps,
      quality: clamp(lowerBoundNetBps / this.cfg.fullQualityEdgeBps, 0, 1),
      decisionTsMs: f.receiveTsMs,
    };
  }
}
