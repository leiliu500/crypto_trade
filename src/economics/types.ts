import type { Direction } from "../core/market.js";

export type ExecutionPath = "MAKER_MAKER" | "MAKER_TAKER" | "TAKER_TAKER";
export type EdgeSource = "CALIBRATED" | "ANALYTIC";
export type EconomicEdgeMode = "ANALYTIC_SHADOW" | "ANALYTIC_PAPER" | "CALIBRATED_PAPER" | "CALIBRATED_LIVE";

export interface ConservativeEdge {
  source: EdgeSource;
  side: Direction;
  horizonMs: number;
  grossBeforeUncertaintyBps: number;
  signalUncertaintyBps: number;
  conservativeGrossBps: number;
  quality: number;
  effectiveSampleCount: number;
  executionPath?: ExecutionPath;
}

/** Every economic cost component is represented exactly once and expressed in basis points. */
export interface CostBreakdown {
  path: ExecutionPath;
  supported: boolean;
  entryExecutionBps: number;
  exitExecutionBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  marketImpactBps: number;
  latencyBps: number;
  adverseSelectionBps: number;
  fundingBps: number;
  borrowBps: number;
  estimatedCostBps: number;
  positiveCostErrorP95Bps: number;
  fillProbability: number;
}

export interface CostGateConfig {
  costSafetyFactor: number;
  minimumNetEdgeBps: number;
  fullQualityEdgeBps: number;
  minimumEconomicSizeScale: number;
  minimumMakerFillProbability: number;
  minimumEffectiveSampleCount: number;
  maximumReasonableCostBps: number;
  maximumReasonableGrossBps: number;
}

export type CostGateRejectionReason =
  | "EXECUTION_PATH_UNSUPPORTED"
  | "MAKER_FILL_PROBABILITY"
  | "CALIBRATED_EDGE_REQUIRED"
  | "INSUFFICIENT_EFFECTIVE_SAMPLES"
  | "INVALID_ECONOMICS"
  | "COST_QUALITY_GATE";

export interface CostPathEvaluation {
  edge: ConservativeEdge;
  cost: CostBreakdown;
  robustCostBps: number;
  lowerBoundNetBps: number;
  shortfallBps: number;
  requiredQuality: number | null;
  pass: boolean;
  rejectionReasons: CostGateRejectionReason[];
}

export interface CostGateDecision {
  pass: boolean;
  selected: CostPathEvaluation | null;
  bestRejected: CostPathEvaluation | null;
  evaluations: CostPathEvaluation[];
  sizeScale: number;
}

export interface ContinuationQuality {
  score: number;
  efficiency: number;
  flowPersistence: number;
  velocity: number;
  breakoutHold: number;
  regimeStability: number;
  volatilitySuitability: number;
}

export interface ContinuationQualityConfig {
  efficiencyWeight: number;
  flowPersistenceWeight: number;
  velocityWeight: number;
  breakoutHoldWeight: number;
  regimeStabilityWeight: number;
  volatilitySuitabilityWeight: number;
  velocityScale: number;
  breakoutScaleBps: number;
  volatilityTargetBps: number;
  volatilityToleranceBps: number;
}

export interface AnalyticHorizonConfig {
  horizonMs: number;
  sigmaCaptureFraction: number;
  breakoutWeight: number;
  maximumGrossBps: number;
  baseUncertaintyBps: number;
  sigmaUncertaintyFraction: number;
}
