import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { RegimeDecision } from "../strategy/deterministic-regime.js";
import type { Direction } from "../core/market.js";
import type { CalibratedEdgeTable } from "../calibration/calibrated-edge-table.js";
import { analyticEdges, type MultiHorizonAnalyticConfig } from "./analytic-edge.js";
import type { ConservativeEdge, ContinuationQuality, EconomicEdgeMode } from "./types.js";

export interface EconomicEdgeInput {
  symbol: string; side: Direction; features: DeterministicFeatures; regime: RegimeDecision; continuation: ContinuationQuality;
}

export class EconomicEdgeResolver {
  public constructor(private readonly mode: EconomicEdgeMode, private readonly analytic: MultiHorizonAnalyticConfig,
    private readonly calibrated: CalibratedEdgeTable) {}

  public resolve(input: EconomicEdgeInput): ConservativeEdge[] {
    const calibrated = this.calibrated.resolve({ symbol: input.symbol, side: input.side, regime: input.regime.name,
      quality: input.continuation.score, spreadBps: input.features.spreadBps });
    if (calibrated.length > 0) return calibrated;
    if (this.mode === "CALIBRATED_LIVE") return [];
    return analyticEdges({ side: input.side, features: input.features, continuation: input.continuation }, this.analytic);
  }
}
