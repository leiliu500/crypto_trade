import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { RegimeDecision } from "../strategy/deterministic-regime.js";
import type { Direction } from "../core/market.js";
import type { CalibratedEdgeTable } from "../calibration/calibrated-edge-table.js";
import { analyticEdges, type MultiHorizonAnalyticConfig } from "./analytic-edge.js";
import type { ConservativeEdge, ContinuationQuality, EconomicEdgeMode, EntryFamily } from "./types.js";
import { pullbackRecoveryEdges, type PullbackRecoveryConfig } from "../strategy/pullback-recovery.js";

export interface EconomicEdgeInput {
  symbol: string; family: EntryFamily; side: Direction; features: DeterministicFeatures; regime: RegimeDecision;
  continuation: ContinuationQuality; confirmationQuality: number;
}

export class EconomicEdgeResolver {
  public constructor(private readonly mode: EconomicEdgeMode, private readonly analytic: MultiHorizonAnalyticConfig,
    private readonly pullback: PullbackRecoveryConfig, private readonly calibrated: CalibratedEdgeTable) {}

  public resolve(input: EconomicEdgeInput): ConservativeEdge[] {
    const analytic = input.family === "PULLBACK_RECOVERY"
      ? pullbackRecoveryEdges(input.side, input.features, input.confirmationQuality, this.pullback)
      : analyticEdges({ side: input.side, features: input.features, continuation: input.continuation }, this.analytic);
    const quality = input.family === "PULLBACK_RECOVERY" ? analytic[0]?.quality ?? 0 : input.continuation.score;
    const calibrated = this.calibrated.resolve({ symbol: input.symbol, family: input.family, side: input.side, regime: input.regime.name,
      quality, spreadBps: input.features.spreadBps });
    if (calibrated.length > 0) return calibrated;
    if (this.mode === "CALIBRATED_LIVE") return [];
    return analytic;
  }
}
