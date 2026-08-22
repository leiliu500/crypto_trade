import type { Direction } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { AnalyticHorizonConfig, ConservativeEdge, ContinuationQuality } from "./types.js";

export interface MultiHorizonAnalyticConfig {
  horizons: AnalyticHorizonConfig[];
  spreadUncertaintyWeight: number;
  flipUncertaintyWeight: number;
}

export interface AnalyticEdgeInput {
  side: Direction;
  features: DeterministicFeatures;
  continuation: ContinuationQuality;
}

/** Analytical paper/shadow edge estimates. Signal uncertainty is incorporated once in conservativeGrossBps. */
export function analyticEdges(input: AnalyticEdgeInput, cfg: MultiHorizonAnalyticConfig): ConservativeEdge[] {
  if (!input.features.slowTrendReady) return [];
  const directionalBreakoutBps = input.side === 1 ? input.features.breakoutUpBps : input.features.breakoutDownBps;
  const directionalTrendBps = Math.max(0, input.side * input.features.trendSlowBps);
  return cfg.horizons.map((horizon) => {
    const economicSigmaBps = 10_000 * Math.sqrt(Math.max(input.features.slowVarianceRate, 1e-16) * horizon.horizonMs / 1_000);
    const trendContributionBps = horizon.trendCaptureFraction * input.continuation.slowTrendAlignment
      * input.continuation.slowTrendEfficiency * directionalTrendBps;
    const grossBeforeUncertaintyBps = Math.min(horizon.maximumGrossBps,
      horizon.sigmaCaptureFraction * input.continuation.score * economicSigmaBps
        + horizon.breakoutWeight * directionalBreakoutBps + trendContributionBps);
    const signalUncertaintyBps = horizon.baseUncertaintyBps
      + horizon.sigmaUncertaintyFraction * (1 - input.continuation.score) * economicSigmaBps
      + horizon.trendUncertaintyFraction * (1 - input.continuation.slowTrendEfficiency) * directionalTrendBps
      + cfg.spreadUncertaintyWeight * input.features.spreadBps
      + cfg.flipUncertaintyWeight * input.features.flowFlipRate * economicSigmaBps;
    return {
      source: "ANALYTIC", family: "CONTINUATION", side: input.side, horizonMs: horizon.horizonMs,
      grossBeforeUncertaintyBps, signalUncertaintyBps,
      conservativeGrossBps: Math.max(0, grossBeforeUncertaintyBps - signalUncertaintyBps),
      quality: input.continuation.score, effectiveSampleCount: 0,
    };
  });
}

export function validateMultiHorizonAnalyticConfig(cfg: MultiHorizonAnalyticConfig): void {
  if (cfg.horizons.length === 0) throw new Error("at least one analytical horizon is required");
  const seen = new Set<number>();
  for (const horizon of cfg.horizons) {
    if (seen.has(horizon.horizonMs)) throw new Error("analytical horizons must be unique");
    seen.add(horizon.horizonMs);
    if (!(horizon.horizonMs > 0 && horizon.maximumGrossBps > 0)
      || [horizon.sigmaCaptureFraction, horizon.breakoutWeight, horizon.baseUncertaintyBps, horizon.sigmaUncertaintyFraction,
        horizon.trendCaptureFraction, horizon.trendUncertaintyFraction]
        .some((value) => !Number.isFinite(value) || value < 0)) throw new Error("invalid analytical horizon configuration");
  }
  if ([cfg.spreadUncertaintyWeight, cfg.flipUncertaintyWeight].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("invalid analytical uncertainty weight");
  }
}
