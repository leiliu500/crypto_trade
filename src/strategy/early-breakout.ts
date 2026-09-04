import type { Direction } from "../core/market.js";
import type { DeterministicFeatures } from "./deterministic-features.js";

/** Causal structure for a fresh impulse that has not yet become a fully aligned continuation. */
export interface EarlyBreakoutConfig {
  enabled: boolean;
  minimumFastTrendBps: number;
  maximumOpposingMediumTrendBps: number;
  maximumOpposingSlowTrendBps: number;
  maximumOpposingSlowTrendAlignment: number;
  minimumBreakoutBps: number;
  minimumVelocityZ: number;
  maximumFlowFlipRate: number;
}

export function earlyBreakoutPass(side: Direction, f: DeterministicFeatures,
  cfg: EarlyBreakoutConfig): boolean {
  const breakoutBps = side === 1 ? f.breakoutUpBps : f.breakoutDownBps;
  return cfg.enabled && f.slowTrendReady
    // An early route cannot require an already-established one-hour trend.
    // Bound contrary medium/slow drift instead; the fresh fast move and
    // immediate flow/kinematics still have to prove the proposed direction.
    && side * f.trendSlowBps >= -cfg.maximumOpposingSlowTrendBps
    && side * f.trendMediumBps >= -cfg.maximumOpposingMediumTrendBps
    && side * f.trendFastBps >= cfg.minimumFastTrendBps
    && side * f.slowTrendAlignment >= -cfg.maximumOpposingSlowTrendAlignment
    // Require an actual new two-second extreme plus contemporaneous motion;
    // a high score produced only by a static book is not an early breakout.
    // Confirmation takes multiple events, so retain the causal 500 ms impulse
    // as breakout evidence after the one-event new-high/new-low print itself.
    && Math.max(breakoutBps, side * f.impulseBps) >= cfg.minimumBreakoutBps
    && side * f.velocityZ >= cfg.minimumVelocityZ
    && f.flowFlipRate <= cfg.maximumFlowFlipRate;
}

export function validateEarlyBreakoutConfig(cfg: EarlyBreakoutConfig): void {
  const nonnegative = [cfg.minimumFastTrendBps, cfg.maximumOpposingMediumTrendBps,
    cfg.maximumOpposingSlowTrendBps, cfg.maximumOpposingSlowTrendAlignment, cfg.minimumBreakoutBps,
    cfg.minimumVelocityZ, cfg.maximumFlowFlipRate];
  if (nonnegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Early-breakout thresholds must be finite and non-negative");
  }
  if (cfg.maximumOpposingSlowTrendAlignment > 1 || cfg.maximumFlowFlipRate > 1) {
    throw new Error("Early-breakout alignment and flip-rate thresholds cannot exceed one");
  }
}
