import type { Direction, Features } from "../core/market.js";
import type { EntryFamily } from "../economics/types.js";
import type { LiquidityDecision } from "../strategy/dynamic-liquidity.js";
import type { ExecutionPlan } from "./planner.js";

export interface HybridEntryConfig {
  /** Allows analytical continuation evidence to route only in the normal paper execution mode. */
  allowAnalyticPaperExecution: boolean;
  /** Caps uncalibrated analytical paper orders while they collect research evidence. */
  analyticPaperSizeMultiplier: number;
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
  /** Independent, reduced-size IOC route for fresh breakouts in evidence modes. */
  earlyBreakoutTakerEnabled: boolean;
  earlyBreakoutTakerSizeMultiplier: number;
  earlyBreakoutMinimumScore: number;
  earlyBreakoutMinimumNetEdgeBps: number;
  earlyBreakoutMinimumExpectedValueBps: number;
  earlyBreakoutMinimumBreakoutBps: number;
  earlyBreakoutMinimumVelocityZ: number;
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
  directionalBreakoutBps?: number;
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
  directionalBreakoutBps: number;
  alignedVelocityZ: number;
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
    const directionalBreakoutBps = input.directionalBreakoutBps ?? 0;
    const alignedVelocityZ = input.side * input.features.velocityZ;
    const maximumLatencyMs = input.alphaHalfLifeMs * this.cfg.continuationTakerMaximumLatencyHalfLifeFraction;
    const reasons: string[] = [];
    // Live/shadow routing still requires a matching calibrated bucket. Normal
    // paper execution may deliberately collect fill and outcome evidence from
    // analytical signals while retaining every cost, risk, and route gate.
    const calibratedEvidence = input.edgeSource === "CALIBRATED"
      && Number.isFinite(input.edgeEffectiveSampleCount)
      && input.edgeEffectiveSampleCount >= input.minimumEffectiveSampleCount;
    const analyticPaperEvidence = this.cfg.allowAnalyticPaperExecution
      && input.edgeSource === "ANALYTIC";
    const evidenceRequired = input.family === "CONTINUATION" || input.family === "EARLY_BREAKOUT";
    const executionEvidencePass = !evidenceRequired
      || calibratedEvidence || analyticPaperEvidence;
    if (!executionEvidencePass) reasons.push(input.family === "EARLY_BREAKOUT"
      ? "UNCALIBRATED_EARLY_BREAKOUT" : "UNCALIBRATED_CONTINUATION");
    const earlyBreakout = input.family === "EARLY_BREAKOUT";
    const takerFamily = input.family === "CONTINUATION" || earlyBreakout;
    const takerEnabled = earlyBreakout ? this.cfg.earlyBreakoutTakerEnabled : this.cfg.continuationTakerEnabled;
    if (!takerEnabled) reasons.push(earlyBreakout ? "EARLY_BREAKOUT_TAKER_DISABLED" : "TAKER_DISABLED");
    if (!takerFamily) reasons.push("PULLBACK_MAKER_ONLY");
    if (!takerPlan) reasons.push("TAKER_PLAN_UNAVAILABLE");
    const minimumScore = earlyBreakout ? this.cfg.earlyBreakoutMinimumScore : this.cfg.continuationTakerMinimumScore;
    if (!Number.isFinite(input.signalScore) || input.signalScore < minimumScore) {
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
    const minimumNetEdgeBps = earlyBreakout
      ? this.cfg.earlyBreakoutMinimumNetEdgeBps : this.cfg.continuationTakerMinimumNetEdgeBps;
    if (takerNetEdgeBps === null || takerNetEdgeBps < minimumNetEdgeBps) {
      reasons.push("TAKER_NET_EDGE_BELOW_MINIMUM");
    }
    if (earlyBreakout && (!Number.isFinite(directionalBreakoutBps)
      || directionalBreakoutBps < this.cfg.earlyBreakoutMinimumBreakoutBps)) {
      reasons.push("EARLY_BREAKOUT_DISTANCE_BELOW_MINIMUM");
    }
    if (earlyBreakout && (!Number.isFinite(alignedVelocityZ)
      || alignedVelocityZ < this.cfg.earlyBreakoutMinimumVelocityZ)) {
      reasons.push("EARLY_BREAKOUT_VELOCITY_BELOW_MINIMUM");
    }
    const minimumExpectedValueBps = earlyBreakout
      ? this.cfg.earlyBreakoutMinimumExpectedValueBps : this.cfg.continuationTakerMinimumExpectedValueBps;
    if (takerExpectedValueBps === null
      || takerExpectedValueBps < minimumExpectedValueBps) {
      reasons.push("TAKER_EXPECTED_VALUE_BELOW_MINIMUM");
    }
    const takerEligible = reasons.length === 0;
    const takerWins = takerEligible && takerPlan !== null
      && (earlyBreakout || makerPlan === null || (takerExpectedValueBps ?? Number.NEGATIVE_INFINITY)
        > (makerExpectedValueBps ?? Number.NEGATIVE_INFINITY));
    // Early breakouts are an IOC-only strategy. Never silently turn a failed
    // taker qualification into a resting maker order with different fill and
    // adverse-selection economics.
    const selectedPlan = executionEvidencePass
      ? earlyBreakout ? (takerEligible ? takerPlan : null) : takerWins ? takerPlan : makerPlan
      : null;
    return {
      selectedPlan, selectedStyle: selectedPlan?.style ?? null, executionEvidencePass, takerEligible, reasons,
      makerExpectedValueBps, takerExpectedValueBps, takerNetEdgeBps,
      alignedOfi, alignedTfi, alignedQiK, directionalBreakoutBps, alignedVelocityZ,
      latencySamples: input.latencySamples,
      latencyP95Ms: input.latencyP95Ms, maximumLatencyMs,
    };
  }
}

export function validateHybridEntryConfig(cfg: HybridEntryConfig): void {
  if (!(cfg.analyticPaperSizeMultiplier > 0 && cfg.analyticPaperSizeMultiplier <= 1)) {
    throw new Error("Analytical paper size multiplier must be in (0,1]");
  }
  if (!(cfg.continuationTakerSizeMultiplier > 0 && cfg.continuationTakerSizeMultiplier <= 1)) {
    throw new Error("Continuation taker size multiplier must be in (0,1]");
  }
  if (!(cfg.earlyBreakoutTakerSizeMultiplier > 0 && cfg.earlyBreakoutTakerSizeMultiplier <= 1)) {
    throw new Error("Early-breakout taker size multiplier must be in (0,1]");
  }
  const nonNegative = [cfg.continuationTakerMinimumScore, cfg.continuationTakerMinimumNetEdgeBps,
    cfg.continuationTakerMinimumExpectedValueBps, cfg.continuationTakerMinimumOfi,
    cfg.continuationTakerMinimumTfi, cfg.continuationTakerMinimumQiK,
    cfg.earlyBreakoutMinimumScore, cfg.earlyBreakoutMinimumNetEdgeBps,
    cfg.earlyBreakoutMinimumExpectedValueBps, cfg.earlyBreakoutMinimumBreakoutBps,
    cfg.earlyBreakoutMinimumVelocityZ];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Continuation taker thresholds must be finite and non-negative");
  }
  const unitThresholds = [cfg.continuationTakerMinimumScore, cfg.earlyBreakoutMinimumScore, cfg.continuationTakerMinimumOfi,
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
