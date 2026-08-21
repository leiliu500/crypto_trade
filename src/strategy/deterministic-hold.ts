import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { DeterministicFeatures } from "./deterministic-features.js";

export interface DeterministicHoldConfig {
  holdHorizonMs: number; kinematicSigmaCap: number; flowSigmaScale: number; totalSigmaCap: number;
  minimumContinuationScore: number; reversalVoteThreshold: number;
  opposingAccelerationZ: number; opposingOfi: number; opposingTfi: number; opposingReplenishment: number; opposingCusum: number;
  uncertaintySpreadPenaltyBps: number; uncertaintyFlipPenaltyBps: number; minimumHoldEdgeBps: number;
}
export interface DeterministicHoldDecision {
  continuationScore: number; reversalScore: number; holdGrossBps: number; uncertaintyBps: number;
  holdLowerBoundBps: number; exitEvidence: boolean; reversalVotes: number;
}
export class DeterministicHoldEngine {
  public constructor(private readonly cfg: DeterministicHoldConfig) { validateHoldConfig(cfg); }
  public evaluate(side: Direction, f: DeterministicFeatures, expectedIncrementalDelayCostBps: number,
    remainingEconomicHorizonMs = this.cfg.holdHorizonMs): DeterministicHoldDecision {
    const horizonSec = Math.max(1, remainingEconomicHorizonMs) / 1_000;
    const sigmaHBps = 10_000 * Math.sqrt(Math.max(f.varianceRate * horizonSec, 1e-16));
    const directionalFlow = clamp((side * f.qiK + side * f.ofi + side * f.tfi + side * f.replenishmentPressure) / 4, -1, 1);
    const directionalKinematic = clamp((side * f.velocityZ + .5 * side * f.accelerationZ) / 1.5, -1, 1);
    const continuationScore = clamp(.35 * directionalFlow + .35 * directionalKinematic + .2 * (2 * f.efficiency - 1) + .1 * (1 - 2 * f.flowFlipRate), -1, 1);
    const kinematicBps = clamp(10_000 * side * (f.velocity * horizonSec + .5 * f.acceleration * horizonSec * horizonSec), 0, this.cfg.kinematicSigmaCap * sigmaHBps);
    const flowBps = this.cfg.flowSigmaScale * sigmaHBps * Math.max(0, directionalFlow);
    const holdGrossBps = Math.max(0, continuationScore) * Math.min(this.cfg.totalSigmaCap * sigmaHBps, .6 * kinematicBps + .4 * flowBps);
    const directionalCusumAgainst = side === 1 ? -f.cusumDownScore : f.cusumUpScore;
    const reversalVotes = Number(side * f.accelerationZ <= -this.cfg.opposingAccelerationZ)
      + Number(side * f.ofi <= -this.cfg.opposingOfi) + Number(side * f.tfi <= -this.cfg.opposingTfi)
      + Number(side * f.replenishmentPressure <= -this.cfg.opposingReplenishment) + Number(directionalCusumAgainst >= this.cfg.opposingCusum);
    const reversalScore = clamp(reversalVotes / 5, 0, 1);
    const uncertaintyBps = this.cfg.uncertaintySpreadPenaltyBps * Math.max(0, f.spreadZ) + this.cfg.uncertaintyFlipPenaltyBps * f.flowFlipRate;
    // Entry fees are sunk and an exit fee/spread is unavoidable whether the
    // position exits now or after this hold interval. Subtract only incremental
    // delay costs here so every market event does not charge the round trip again.
    const holdLowerBoundBps = holdGrossBps - uncertaintyBps - expectedIncrementalDelayCostBps;
    const exitEvidence = continuationScore < this.cfg.minimumContinuationScore || reversalVotes >= this.cfg.reversalVoteThreshold || holdLowerBoundBps < this.cfg.minimumHoldEdgeBps;
    return { continuationScore, reversalScore, holdGrossBps, uncertaintyBps, holdLowerBoundBps, exitEvidence, reversalVotes };
  }
}
function validateHoldConfig(cfg: DeterministicHoldConfig): void {
  for (const [name, value] of Object.entries(cfg)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid deterministic hold configuration: ${name}`);
  if (!Number.isInteger(cfg.reversalVoteThreshold) || cfg.reversalVoteThreshold < 1 || cfg.reversalVoteThreshold > 5) throw new Error("reversalVoteThreshold must be an integer from 1 to 5");
  if (cfg.minimumContinuationScore > 1) throw new Error("minimumContinuationScore must be at most 1");
}
