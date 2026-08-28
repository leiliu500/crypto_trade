import { clamp } from "../core/market.js";
import type { ConservativeEdge, CostBreakdown, CostGateConfig, CostGateDecision, CostPathEvaluation, EconomicEdgeMode } from "./types.js";

export function robustCostBps(cost: CostBreakdown, safetyFactor: number): number {
  const fixedCostBps = cost.entryFeeBps + cost.exitFeeBps + cost.fundingBps + cost.borrowBps;
  const variableCostBps = cost.entryExecutionBps + cost.exitExecutionBps + cost.marketImpactBps
    + cost.latencyBps + cost.adverseSelectionBps;
  const stressedVariableCostBps = Math.max(
    safetyFactor * variableCostBps,
    variableCostBps + cost.positiveCostErrorP95Bps,
  );
  return fixedCostBps + stressedVariableCostBps;
}

/** The sole binary economic gate. All costs and signal uncertainty are already consolidated before this point. */
export class MultiHorizonCostGate {
  public constructor(private readonly cfg: CostGateConfig, private readonly mode: EconomicEdgeMode) { validateCostGateConfig(cfg); }

  public evaluate(edges: readonly ConservativeEdge[], costs: readonly CostBreakdown[]): CostGateDecision {
    const evaluations: CostPathEvaluation[] = [];
    for (const edge of edges) for (const cost of costs) {
      if (edge.executionPath === undefined || edge.executionPath === cost.path) evaluations.push(this.pathEvaluation(edge, cost));
    }
    const ranked = [...evaluations].sort((left, right) => right.lowerBoundNetBps - left.lowerBoundNetBps);
    // Select the shortest economically sufficient horizon, then the best path
    // within it. Taking the largest extrapolated horizon simply because its
    // square-root volatility term is larger produces wide stops and a payoff
    // horizon that is inconsistent with live invalidation and time-stop rules.
    const selected = evaluations.filter((item) => item.pass).sort((left, right) =>
      left.edge.horizonMs - right.edge.horizonMs || right.lowerBoundNetBps - left.lowerBoundNetBps)[0] ?? null;
    const bestRejected = selected ? null
      : ranked.find((item) => item.cost.supported && !item.rejectionReasons.includes("MAKER_FILL_PROBABILITY")
        && !item.rejectionReasons.includes("CALIBRATED_EDGE_REQUIRED")
        && !item.rejectionReasons.includes("INSUFFICIENT_EFFECTIVE_SAMPLES")
        && !item.rejectionReasons.includes("INVALID_ECONOMICS"))
        ?? ranked.find((item) => item.cost.supported && !item.rejectionReasons.includes("INVALID_ECONOMICS"))
        ?? ranked[0] ?? null;
    const sizeScale = selected ? economicSizeScale(selected.lowerBoundNetBps, this.cfg) : 0;
    return { pass: selected !== null, selected, bestRejected, evaluations, sizeScale };
  }

  private pathEvaluation(edge: ConservativeEdge, cost: CostBreakdown): CostPathEvaluation {
    const valid = this.validEconomics(edge, cost);
    const robustCost = valid ? robustCostBps(cost, this.cfg.costSafetyFactor) : Number.POSITIVE_INFINITY;
    const rawLowerBoundNetBps = edge.conservativeGrossBps - robustCost;
    const tolerance = Math.max(1e-9, Math.abs(this.cfg.minimumNetEdgeBps) * 1e-12);
    const lowerBoundNetBps = Math.abs(rawLowerBoundNetBps - this.cfg.minimumNetEdgeBps) <= tolerance
      ? this.cfg.minimumNetEdgeBps : rawLowerBoundNetBps;
    const rejectionReasons: CostPathEvaluation["rejectionReasons"] = [];
    if (!valid) rejectionReasons.push("INVALID_ECONOMICS");
    if (!cost.supported) rejectionReasons.push("EXECUTION_PATH_UNSUPPORTED");
    if (cost.path !== "TAKER_TAKER" && cost.fillProbability < this.cfg.minimumMakerFillProbability) {
      rejectionReasons.push("MAKER_FILL_PROBABILITY");
    }
    if (this.mode === "CALIBRATED_LIVE" && edge.source !== "CALIBRATED") rejectionReasons.push("CALIBRATED_EDGE_REQUIRED");
    if ((this.mode === "CALIBRATED_LIVE" || edge.source === "CALIBRATED")
      && edge.effectiveSampleCount < this.cfg.minimumEffectiveSampleCount) rejectionReasons.push("INSUFFICIENT_EFFECTIVE_SAMPLES");
    if (lowerBoundNetBps < this.cfg.minimumNetEdgeBps) rejectionReasons.push("COST_QUALITY_GATE");
    const qualityUnitGross = edge.quality > 1e-12 ? edge.grossBeforeUncertaintyBps / edge.quality : 0;
    const requiredQuality = qualityUnitGross > 0
      ? Math.max(0, (robustCost + edge.signalUncertaintyBps + this.cfg.minimumNetEdgeBps) / qualityUnitGross) : null;
    return {
      edge, cost, robustCostBps: robustCost, lowerBoundNetBps,
      shortfallBps: Math.max(0, this.cfg.minimumNetEdgeBps - lowerBoundNetBps), requiredQuality,
      pass: rejectionReasons.length === 0, rejectionReasons,
    };
  }

  private validEconomics(edge: ConservativeEdge, cost: CostBreakdown): boolean {
    const costComponents = [cost.entryExecutionBps, cost.exitExecutionBps, cost.entryFeeBps, cost.exitFeeBps,
      cost.marketImpactBps, cost.latencyBps, cost.adverseSelectionBps, cost.fundingBps, cost.borrowBps];
    const componentTotal = costComponents.reduce((sum, value) => sum + value, 0);
    return costComponents.every((value) => Number.isFinite(value) && value >= 0)
      && Number.isFinite(cost.estimatedCostBps) && cost.estimatedCostBps >= 0
      && cost.estimatedCostBps <= this.cfg.maximumReasonableCostBps
      && Math.abs(componentTotal - cost.estimatedCostBps) <= Math.max(1e-8, cost.estimatedCostBps * 1e-9)
      && Number.isFinite(cost.positiveCostErrorP95Bps) && cost.positiveCostErrorP95Bps >= 0
      && Number.isFinite(edge.grossBeforeUncertaintyBps) && edge.grossBeforeUncertaintyBps >= 0
      && edge.grossBeforeUncertaintyBps <= this.cfg.maximumReasonableGrossBps
      && Number.isFinite(edge.signalUncertaintyBps) && edge.signalUncertaintyBps >= 0
      && Number.isFinite(edge.conservativeGrossBps) && edge.conservativeGrossBps >= 0
      && edge.conservativeGrossBps <= edge.grossBeforeUncertaintyBps + 1e-9;
  }
}

export function economicSizeScale(lowerBoundNetBps: number, cfg: CostGateConfig): number {
  if (lowerBoundNetBps < cfg.minimumNetEdgeBps) return 0;
  if (cfg.fullQualityEdgeBps <= cfg.minimumNetEdgeBps) return 1;
  const progress = (lowerBoundNetBps - cfg.minimumNetEdgeBps) / (cfg.fullQualityEdgeBps - cfg.minimumNetEdgeBps);
  return clamp(cfg.minimumEconomicSizeScale + (1 - cfg.minimumEconomicSizeScale) * progress, cfg.minimumEconomicSizeScale, 1);
}

function validateCostGateConfig(cfg: CostGateConfig): void {
  if (!Number.isFinite(cfg.costSafetyFactor) || cfg.costSafetyFactor < 1) throw new Error("costSafetyFactor must be at least 1");
  if (!Number.isFinite(cfg.minimumNetEdgeBps)) throw new Error("minimumNetEdgeBps must be finite");
  if (!(cfg.fullQualityEdgeBps > cfg.minimumNetEdgeBps)) throw new Error("fullQualityEdgeBps must exceed minimumNetEdgeBps");
  if (!(cfg.minimumEconomicSizeScale > 0 && cfg.minimumEconomicSizeScale <= 1)) throw new Error("minimumEconomicSizeScale must be in (0,1]");
  if (!(cfg.minimumMakerFillProbability >= 0 && cfg.minimumMakerFillProbability <= 1)) throw new Error("minimumMakerFillProbability must be in [0,1]");
  if (!(cfg.minimumEffectiveSampleCount >= 0)) throw new Error("minimumEffectiveSampleCount cannot be negative");
  if (!(cfg.maximumReasonableCostBps > 0 && cfg.maximumReasonableGrossBps > 0)) throw new Error("economic sanity caps must be positive");
}
