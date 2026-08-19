import type { Features } from "../core/market.js";
import { clamp } from "../core/market.js";

export type Regime = "TREND_UP" | "TREND_DOWN" | "BREAKOUT_UP" | "BREAKOUT_DOWN" | "CHOP" | "REVERSAL" | "LIQUIDITY_STRESS" | "UNKNOWN";
export interface RegimeDecision {
  regime: Regime;
  confidence: number;
  allowLong: boolean;
  allowShort: boolean;
  riskScale: number;
  reversalProbability: number;
}
export interface RegimeConfig {
  minimumConfidence: number;
  minimumTrendEfficiency: number;
  liquidityStressSpreadZ: number;
  liquidityStressDepthZ: number;
  reversalThreshold: number;
}

export class RegimeEngine {
  public constructor(private readonly cfg: RegimeConfig) {}
  public classify(f: Features): RegimeDecision {
    if (f.stale || f.spreadZ >= this.cfg.liquidityStressSpreadZ || f.depthZ <= this.cfg.liquidityStressDepthZ) {
      return this.decision("LIQUIDITY_STRESS", 1, 0, 1);
    }
    if (!f.warmedUp) return this.decision("UNKNOWN", 1, 0, .5);
    const flow = clamp((f.ofi / 3 + f.tfi + f.persistentQiK + f.replenishmentPressure / 4) / 4, -1, 1);
    const trend = clamp((f.velocityZ + .5 * f.accelerationZ) / 4, -1, 1);
    const reversalProbability = clamp(
      .5 * Math.max(0, -Math.sign(f.velocityZ || 1) * f.accelerationZ / 4)
      + .3 * Math.max(0, -Math.sign(f.velocityZ || 1) * flow)
      + .2 * f.signalFlipRate,
      0, 1,
    );
    if (reversalProbability >= this.cfg.reversalThreshold) return this.decision("REVERSAL", reversalProbability, .25, reversalProbability);
    if (f.cusumUp && flow > 0 && f.spreadZ < 2) return this.decision("BREAKOUT_UP", clamp(.55 + .25 * flow + .2 * f.efficiency, 0, 1), .8, reversalProbability);
    if (f.cusumDown && flow < 0 && f.spreadZ < 2) return this.decision("BREAKOUT_DOWN", clamp(.55 - .25 * flow + .2 * f.efficiency, 0, 1), .8, reversalProbability);
    if (f.efficiency >= this.cfg.minimumTrendEfficiency && trend > 0 && flow > 0) {
      return this.decision("TREND_UP", clamp(.4 + .3 * trend + .3 * flow, 0, 1), 1, reversalProbability);
    }
    if (f.efficiency >= this.cfg.minimumTrendEfficiency && trend < 0 && flow < 0) {
      return this.decision("TREND_DOWN", clamp(.4 - .3 * trend - .3 * flow, 0, 1), 1, reversalProbability);
    }
    const chopConfidence = clamp(.4 + .4 * (1 - f.efficiency) + .2 * f.signalFlipRate, 0, 1);
    return this.decision("CHOP", chopConfidence, 0, reversalProbability);
  }

  private decision(regime: Regime, confidence: number, riskScale: number, reversalProbability: number): RegimeDecision {
    const permitted = confidence >= this.cfg.minimumConfidence;
    return {
      regime, confidence,
      allowLong: permitted && (regime === "TREND_UP" || regime === "BREAKOUT_UP"),
      allowShort: permitted && (regime === "TREND_DOWN" || regime === "BREAKOUT_DOWN"),
      riskScale: permitted ? riskScale : 0,
      reversalProbability,
    };
  }
}
