import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { DeterministicFeatures } from "./deterministic-features.js";

export type EdgeSourceMode = "CALIBRATED_REQUIRED" | "CALIBRATED_OR_ANALYTIC" | "ANALYTIC_ONLY";

export interface AnalyticEdgeConfig {
  economicHorizonMs: number;
  qiKScale: number;
  ofiScale: number;
  tfiScale: number;
  velocityScale: number;
  microEdgeScaleBps: number;
  breakoutScaleBps: number;
  sigmaCaptureFraction: number;
  breakoutWeight: number;
  maximumGrossBps: number;
  baseUncertaintyBps: number;
  sigmaUncertaintyFraction: number;
  spreadUncertaintyWeight: number;
  flipUncertaintyWeight: number;
  fullEvidence: number;
}

export interface EdgeEstimate {
  source: "CALIBRATED" | "ANALYTIC";
  grossOpportunityBps: number;
  uncertaintyBps: number;
  horizonMs: number;
  quality: number;
}

export interface EdgeResolutionInput {
  side: Direction;
  score: number;
  scoreReset: number;
  persistence: number;
  evidence: number;
  features: DeterministicFeatures;
}

export interface CalibratedEdgeProvider {
  resolve(input: EdgeResolutionInput): EdgeEstimate | null;
}

/** Uses a calibrated estimate when available and otherwise falls back to deterministic analytical edge. */
export class DeterministicEdgeResolver {
  public constructor(
    private readonly mode: EdgeSourceMode,
    private readonly cfg: AnalyticEdgeConfig,
    private readonly calibrated?: CalibratedEdgeProvider,
  ) { validateAnalyticEdgeConfig(cfg); }

  public resolve(input: EdgeResolutionInput): EdgeEstimate | null {
    if (this.mode !== "ANALYTIC_ONLY") {
      const calibrated = this.calibrated?.resolve(input) ?? null;
      if (calibrated) return calibrated;
      if (this.mode === "CALIBRATED_REQUIRED") return null;
    }
    return this.analytic(input);
  }

  private analytic(input: EdgeResolutionInput): EdgeEstimate {
    const { side, features } = input;
    const economicSigmaBps = 10_000 * Math.sqrt(
      Math.max(features.varianceRate, 1e-16) * this.cfg.economicHorizonMs / 1_000,
    );
    const scoreQuality = clamp(
      (input.score - input.scoreReset) / Math.max(1 - input.scoreReset, 1e-9), 0, 1,
    );
    const evidenceQuality = clamp(input.evidence / this.cfg.fullEvidence, 0, 1);
    const flowQuality = (
      positiveRatio(side * features.qiK, this.cfg.qiKScale)
      + positiveRatio(side * features.ofi, this.cfg.ofiScale)
      + positiveRatio(side * features.tfi, this.cfg.tfiScale)
    ) / 3;
    const directionalBreakoutBps = side === 1 ? features.breakoutUpBps : features.breakoutDownBps;
    const quality = clamp(
      .30 * scoreQuality + .20 * input.persistence + .20 * evidenceQuality
      + .15 * features.efficiency + .15 * flowQuality,
      0, 1,
    );
    const grossOpportunityBps = Math.min(
      this.cfg.maximumGrossBps,
      this.cfg.sigmaCaptureFraction * quality * economicSigmaBps
        + this.cfg.breakoutWeight * directionalBreakoutBps,
    );
    const uncertaintyBps = this.cfg.baseUncertaintyBps
      + this.cfg.sigmaUncertaintyFraction * (1 - quality) * economicSigmaBps
      + this.cfg.spreadUncertaintyWeight * features.spreadBps
      + this.cfg.flipUncertaintyWeight * features.flowFlipRate * economicSigmaBps;
    return {
      source: "ANALYTIC", grossOpportunityBps, uncertaintyBps,
      horizonMs: this.cfg.economicHorizonMs, quality,
    };
  }
}

function positiveRatio(value: number, scale: number): number {
  return clamp(value / Math.max(scale, 1e-9), 0, 1);
}

function validateAnalyticEdgeConfig(cfg: AnalyticEdgeConfig): void {
  const positive = [cfg.economicHorizonMs, cfg.qiKScale, cfg.ofiScale, cfg.tfiScale, cfg.velocityScale,
    cfg.microEdgeScaleBps, cfg.breakoutScaleBps, cfg.maximumGrossBps, cfg.fullEvidence];
  const nonnegative = [cfg.sigmaCaptureFraction, cfg.breakoutWeight, cfg.baseUncertaintyBps,
    cfg.sigmaUncertaintyFraction, cfg.spreadUncertaintyWeight, cfg.flipUncertaintyWeight];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)
    || nonnegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid deterministic analytical edge configuration");
  }
}
