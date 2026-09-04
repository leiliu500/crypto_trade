import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { RegimeDecision } from "../strategy/deterministic-regime.js";
import { clamp, type Direction } from "../core/market.js";
import type { CalibratedEdgeTable } from "../calibration/calibrated-edge-table.js";
import { analyticEdges, type MultiHorizonAnalyticConfig } from "./analytic-edge.js";
import type { ConservativeEdge, ContinuationQuality, EconomicEdgeMode, EntryFamily } from "./types.js";
import { pullbackRecoveryEdges, type PullbackRecoveryConfig } from "../strategy/pullback-recovery.js";
import type { AnalyticEdgeConfig } from "../strategy/deterministic-edge-resolver.js";

export interface EconomicEdgeInput {
  symbol: string; family: EntryFamily; side: Direction; features: DeterministicFeatures; regime: RegimeDecision;
  continuation: ContinuationQuality; confirmationQuality: number;
  score: number; scoreReset: number; persistence: number; evidence: number;
}

export class EconomicEdgeResolver {
  public constructor(private readonly mode: EconomicEdgeMode, private readonly analytic: MultiHorizonAnalyticConfig,
    private readonly breakout: AnalyticEdgeConfig, private readonly pullback: PullbackRecoveryConfig,
    private readonly calibrated: CalibratedEdgeTable) {}

  public resolve(input: EconomicEdgeInput): ConservativeEdge[] {
    const analytic = input.family === "PULLBACK_RECOVERY"
      ? pullbackRecoveryEdges(input.side, input.features, input.confirmationQuality, this.pullback)
      : input.family === "EARLY_BREAKOUT" ? earlyBreakoutEdges(input, this.breakout)
        : analyticEdges({ side: input.side, features: input.features, continuation: input.continuation }, this.analytic);
    const quality = input.family === "PULLBACK_RECOVERY" || input.family === "EARLY_BREAKOUT"
      ? analytic[0]?.quality ?? 0 : input.continuation.score;
    const calibrated = this.calibrated.resolve({ symbol: input.symbol, family: input.family, side: input.side, regime: input.regime.name,
      quality, spreadBps: input.features.spreadBps });
    if (calibrated.length > 0) return calibrated;
    // Shadow and live pullbacks remain observation-only without a matching
    // calibrated bucket. ANALYTIC_PAPER deliberately executes them to collect
    // local fill and outcome evidence under the normal economic/risk gates.
    if (input.family === "PULLBACK_RECOVERY" && this.mode !== "ANALYTIC_PAPER") return [];
    // Breakouts are separately observable in replay/shadow and executable only
    // as reduced-size analytical paper research until their own cohort calibrates.
    if (input.family === "EARLY_BREAKOUT"
      && this.mode !== "ANALYTIC_SHADOW" && this.mode !== "ANALYTIC_PAPER") return [];
    if (this.mode === "CALIBRATED_LIVE") return [];
    return analytic;
  }
}

function earlyBreakoutEdges(input: EconomicEdgeInput, cfg: AnalyticEdgeConfig): ConservativeEdge[] {
  const f = input.features;
  const economicSigmaBps = 10_000 * Math.sqrt(
    Math.max(f.slowVarianceRate, 1e-16) * cfg.economicHorizonMs / 1_000,
  );
  const scoreQuality = clamp((input.score - input.scoreReset) / Math.max(1 - input.scoreReset, 1e-9), 0, 1);
  const evidenceQuality = clamp(input.evidence / cfg.fullEvidence, 0, 1);
  const positiveRatio = (value: number, scale: number): number => clamp(value / Math.max(scale, 1e-9), 0, 1);
  const flowQuality = (
    positiveRatio(input.side * f.qiK, cfg.qiKScale)
      + positiveRatio(input.side * f.ofi, cfg.ofiScale)
      + positiveRatio(input.side * f.tfi, cfg.tfiScale)
  ) / 3;
  const quality = clamp(.30 * scoreQuality + .20 * input.persistence + .20 * evidenceQuality
    + .15 * f.efficiency + .15 * flowQuality, 0, 1);
  const directionalBreakoutBps = input.side === 1 ? f.breakoutUpBps : f.breakoutDownBps;
  const directionalImpulseBps = Math.max(0, input.side * f.impulseBps);
  const grossBeforeUncertaintyBps = Math.min(cfg.maximumGrossBps,
    cfg.sigmaCaptureFraction * quality * economicSigmaBps
      + cfg.breakoutWeight * Math.max(directionalBreakoutBps, directionalImpulseBps));
  const signalUncertaintyBps = cfg.baseUncertaintyBps
    + cfg.sigmaUncertaintyFraction * (1 - quality) * economicSigmaBps
    + cfg.spreadUncertaintyWeight * f.spreadBps
    + cfg.flipUncertaintyWeight * f.flowFlipRate * economicSigmaBps;
  return [{
    source: "ANALYTIC", family: "EARLY_BREAKOUT", side: input.side,
    horizonMs: cfg.economicHorizonMs, grossBeforeUncertaintyBps, signalUncertaintyBps,
    conservativeGrossBps: Math.max(0, grossBeforeUncertaintyBps - signalUncertaintyBps),
    quality, effectiveSampleCount: 0, executionPath: "TAKER_TAKER",
  }];
}
