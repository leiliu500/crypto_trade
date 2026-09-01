import type { Direction, Features } from "../core/market.js";
import type { EntryFamily } from "../economics/types.js";
import type { LiquidityDecision } from "../strategy/dynamic-liquidity.js";
import type { ExecutionPlan } from "./planner.js";

export interface HybridEntryConfig {
  continuationTakerEnabled: boolean;
  continuationTakerSizeMultiplier: number;
  continuationTakerMinimumScore: number;
  continuationTakerMinimumNetEdgeBps: number;
  continuationTakerMinimumExpectedValueBps: number;
  continuationTakerMinimumOfi: number;
  continuationTakerMinimumTfi: number;
  continuationTakerMinimumQiK: number;
  continuationTakerMaximumLatencyHalfLifeFraction: number;
  continuationTakerMinimumLatencySamples: number;
  routeShadowEnabled: boolean;
  routeShadowHorizonsMs: readonly number[];
}

export interface HybridRouteInput {
  family: EntryFamily;
  side: Direction;
  regimePass: boolean;
  edgeSource: "CALIBRATED" | "ANALYTIC" | "UNRESOLVED";
  edgeEffectiveSampleCount: number;
  minimumEffectiveSampleCount: number;
  signalScore: number;
  features: Features;
  liquidity: LiquidityDecision;
  latencySamples: number;
  latencyP95Ms: number;
  alphaHalfLifeMs: number;
  makerPlan: ExecutionPlan | null;
  takerPlan: ExecutionPlan | null;
}

export interface HybridRouteDecision {
  selectedPlan: ExecutionPlan | null;
  selectedStyle: "maker" | "taker" | null;
  executionEvidencePass: boolean;
  takerEligible: boolean;
  reasons: readonly string[];
  makerExpectedValueBps: number | null;
  takerExpectedValueBps: number | null;
  takerNetEdgeBps: number | null;
  alignedOfi: number;
  alignedTfi: number;
  alignedQiK: number;
  latencySamples: number;
  latencyP95Ms: number;
  maximumLatencyMs: number;
}

/** Selects a route only after each alternative has passed its own exact cost and risk sizing. */
export class HybridEntryRouter {
  public constructor(private readonly cfg: HybridEntryConfig) { validateHybridEntryConfig(cfg); }

  public select(input: HybridRouteInput): HybridRouteDecision {
    const makerPlan = input.makerPlan?.style === "maker" ? input.makerPlan : null;
    const takerPlan = input.takerPlan?.style === "taker" && input.takerPlan.executionPath === "TAKER_TAKER"
      ? input.takerPlan : null;
    const makerExpectedValueBps = planExpectedValueBps(makerPlan, input.features.mid);
    const takerExpectedValueBps = planExpectedValueBps(takerPlan, input.features.mid);
    const takerNetEdgeBps = finiteOrNull(takerPlan?.conservativeNetEdgeBps);
    const alignedOfi = input.side * input.features.ofi;
    const alignedTfi = input.side * input.features.tfi;
    const alignedQiK = input.side * input.features.qiK;
    const maximumLatencyMs = input.alphaHalfLifeMs * this.cfg.continuationTakerMaximumLatencyHalfLifeFraction;
    const reasons: string[] = [];
    // Analytical continuation estimates remain an observation path. Only a
    // matching calibrated bucket with the required independent sample count
    // may authorize capital; regime alignment alone is not profit evidence.
    const calibratedEvidence = input.edgeSource === "CALIBRATED"
      && Number.isFinite(input.edgeEffectiveSampleCount)
      && input.edgeEffectiveSampleCount >= input.minimumEffectiveSampleCount;
    const executionEvidencePass = input.family !== "CONTINUATION" || calibratedEvidence;
    if (!executionEvidencePass) reasons.push("UNCALIBRATED_CONTINUATION");
    if (!this.cfg.continuationTakerEnabled) reasons.push("TAKER_DISABLED");
    if (input.family !== "CONTINUATION") reasons.push("PULLBACK_MAKER_ONLY");
    if (!takerPlan) reasons.push("TAKER_PLAN_UNAVAILABLE");
    if (!Number.isFinite(input.signalScore) || input.signalScore < this.cfg.continuationTakerMinimumScore) {
      reasons.push("TAKER_SCORE_BELOW_MINIMUM");
    }
    if (!Number.isFinite(alignedOfi) || alignedOfi < this.cfg.continuationTakerMinimumOfi) {
      reasons.push("TAKER_OFI_NOT_ALIGNED");
    }
    if (!Number.isFinite(alignedTfi) || alignedTfi < this.cfg.continuationTakerMinimumTfi) {
      reasons.push("TAKER_TFI_NOT_ALIGNED");
    }
    if (!Number.isFinite(alignedQiK) || alignedQiK < this.cfg.continuationTakerMinimumQiK) {
      reasons.push("TAKER_QIK_NOT_ALIGNED");
    }
    if (!input.liquidity.pass || input.liquidity.stress) reasons.push("TAKER_LIQUIDITY_NOT_CLEAN");
    if (input.latencySamples < this.cfg.continuationTakerMinimumLatencySamples) reasons.push("TAKER_LATENCY_SAMPLES_INSUFFICIENT");
    if (!Number.isFinite(input.latencyP95Ms) || input.latencyP95Ms < 0
      || !Number.isFinite(maximumLatencyMs) || maximumLatencyMs <= 0 || input.latencyP95Ms > maximumLatencyMs) {
      reasons.push("TAKER_LATENCY_ABOVE_ALPHA_BUDGET");
    }
    if (takerNetEdgeBps === null || takerNetEdgeBps < this.cfg.continuationTakerMinimumNetEdgeBps) {
      reasons.push("TAKER_NET_EDGE_BELOW_MINIMUM");
    }
    if (takerExpectedValueBps === null
      || takerExpectedValueBps < this.cfg.continuationTakerMinimumExpectedValueBps) {
      reasons.push("TAKER_EXPECTED_VALUE_BELOW_MINIMUM");
    }
    const takerEligible = reasons.length === 0;
    const takerWins = takerEligible && takerPlan !== null
      && (makerPlan === null || (takerExpectedValueBps ?? Number.NEGATIVE_INFINITY)
        > (makerExpectedValueBps ?? Number.NEGATIVE_INFINITY));
    const selectedPlan = executionEvidencePass ? (takerWins ? takerPlan : makerPlan) : null;
    return {
      selectedPlan, selectedStyle: selectedPlan?.style ?? null, executionEvidencePass, takerEligible, reasons,
      makerExpectedValueBps, takerExpectedValueBps, takerNetEdgeBps,
      alignedOfi, alignedTfi, alignedQiK, latencySamples: input.latencySamples,
      latencyP95Ms: input.latencyP95Ms, maximumLatencyMs,
    };
  }
}

export function validateHybridEntryConfig(cfg: HybridEntryConfig): void {
  if (!(cfg.continuationTakerSizeMultiplier > 0 && cfg.continuationTakerSizeMultiplier <= 1)) {
    throw new Error("Continuation taker size multiplier must be in (0,1]");
  }
  const nonNegative = [cfg.continuationTakerMinimumScore, cfg.continuationTakerMinimumNetEdgeBps,
    cfg.continuationTakerMinimumExpectedValueBps, cfg.continuationTakerMinimumOfi,
    cfg.continuationTakerMinimumTfi, cfg.continuationTakerMinimumQiK];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Continuation taker thresholds must be finite and non-negative");
  }
  const unitThresholds = [cfg.continuationTakerMinimumScore, cfg.continuationTakerMinimumOfi,
    cfg.continuationTakerMinimumTfi, cfg.continuationTakerMinimumQiK];
  if (unitThresholds.some((value) => value > 1)) {
    throw new Error("Continuation taker score and alignment thresholds cannot exceed one");
  }
  if (!(cfg.continuationTakerMaximumLatencyHalfLifeFraction > 0
    && cfg.continuationTakerMaximumLatencyHalfLifeFraction < 1)) {
    throw new Error("Continuation taker latency fraction must be in (0,1)");
  }
  if (!Number.isInteger(cfg.continuationTakerMinimumLatencySamples)
    || cfg.continuationTakerMinimumLatencySamples < 0) {
    throw new Error("Continuation taker minimum latency samples must be a non-negative integer");
  }
  if (cfg.routeShadowHorizonsMs.length === 0
    || cfg.routeShadowHorizonsMs.some((value) => !Number.isInteger(value) || value <= 0)
    || cfg.routeShadowHorizonsMs.some((value, index) => index > 0 && value <= cfg.routeShadowHorizonsMs[index - 1]!)) {
    throw new Error("Route shadow horizons must be positive, unique, and increasing");
  }
}

function planExpectedValueBps(plan: ExecutionPlan | null, mid: number): number | null {
  if (!plan) return null;
  if (Number.isFinite(plan.conservativeExpectedValueBps)) return plan.conservativeExpectedValueBps!;
  const notional = plan.qty * mid;
  return notional > 0 ? 10_000 * plan.expectedValue / notional : null;
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}
