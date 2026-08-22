import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { ContinuationQuality, ContinuationQualityConfig } from "../economics/types.js";
import type { DeterministicFeatures } from "./deterministic-features.js";
import type { RegimeDecision } from "./deterministic-regime.js";

/** Independent post-trigger evidence used to estimate whether a move can continue over an economic horizon. */
export function continuationQuality(side: Direction, f: DeterministicFeatures, regime: RegimeDecision,
  cfg: ContinuationQualityConfig): ContinuationQuality {
  const efficiency = clamp(f.efficiency, 0, 1);
  const directionalFlow = (
    positiveRatio(side * f.qiK, .20) + positiveRatio(side * f.ofi, .50)
    + positiveRatio(side * f.tfi, .25) + positiveRatio(side * f.replenishmentPressure, .30)
  ) / 4;
  const flowPersistence = directionalFlow * (1 - clamp(f.flowFlipRate, 0, 1));
  const velocity = positiveRatio(side * f.velocityZ, cfg.velocityScale);
  const breakout = side === 1 ? f.breakoutUpBps : f.breakoutDownBps;
  const breakoutHold = positiveRatio(breakout, cfg.breakoutScaleBps);
  const regimeStability = (side === 1 ? regime.allowLong : regime.allowShort) ? clamp(regime.riskScale, 0, 1) : 0;
  const sigmaDistance = Math.abs(f.slowSigmaBps - cfg.volatilityTargetBps);
  const volatilitySuitability = clamp(1 - sigmaDistance / Math.max(cfg.volatilityToleranceBps, 1e-9), 0, 1);
  const slowTrendAlignment = f.slowTrendReady ? clamp(side * f.slowTrendAlignment, 0, 1) : 0;
  const slowTrendEfficiency = f.slowTrendReady && side * f.trendSlowBps > 0 ? clamp(f.slowTrendEfficiency, 0, 1) : 0;
  const score = clamp(
    cfg.efficiencyWeight * efficiency + cfg.flowPersistenceWeight * flowPersistence
    + cfg.velocityWeight * velocity + cfg.breakoutHoldWeight * breakoutHold
    + cfg.regimeStabilityWeight * regimeStability + cfg.volatilitySuitabilityWeight * volatilitySuitability
    + cfg.slowTrendAlignmentWeight * slowTrendAlignment + cfg.slowTrendEfficiencyWeight * slowTrendEfficiency,
    0, 1,
  );
  return { score, efficiency, flowPersistence, velocity, breakoutHold, regimeStability, volatilitySuitability,
    slowTrendAlignment, slowTrendEfficiency };
}

function positiveRatio(value: number, scale: number): number { return clamp(value / Math.max(scale, 1e-9), 0, 1); }

export function validateContinuationQualityConfig(cfg: ContinuationQualityConfig): void {
  const weights = [cfg.efficiencyWeight, cfg.flowPersistenceWeight, cfg.velocityWeight, cfg.breakoutHoldWeight,
    cfg.regimeStabilityWeight, cfg.volatilitySuitabilityWeight, cfg.slowTrendAlignmentWeight, cfg.slowTrendEfficiencyWeight];
  if (weights.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("continuation weights must be finite and nonnegative");
  if (Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) throw new Error("continuation weights must sum to 1");
  if (![cfg.velocityScale, cfg.breakoutScaleBps, cfg.volatilityToleranceBps].every((value) => Number.isFinite(value) && value > 0)
    || !Number.isFinite(cfg.volatilityTargetBps) || cfg.volatilityTargetBps < 0) throw new Error("invalid continuation quality scale");
}
