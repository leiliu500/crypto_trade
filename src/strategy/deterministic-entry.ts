import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import { exactCostBreakdown, type CostEstimate } from "./cost.js";
import type { AnalyticEdgeConfig, EdgeSourceMode } from "./deterministic-edge-resolver.js";
import type { DeterministicFeatures } from "./deterministic-features.js";
import type { SideTriggerDiagnostics, SmallFractionCandidate, SmallFractionFeatures, SmallFractionTriggerConfig } from "./micro-fraction-types.js";
import type { RegimeDecision } from "./deterministic-regime.js";
import { SmallFractionEntryTrigger, validateSmallFractionTriggerConfig } from "./small-fraction-entry-trigger.js";
import type { LiquidityDecision } from "./dynamic-liquidity.js";
import type { AnalyticHorizonConfig, ContinuationQualityConfig, CostBreakdown, EconomicEdgeMode, EntryFamily, ExecutionPath } from "../economics/types.js";
import { MultiHorizonCostGate } from "../economics/multi-horizon-cost-gate.js";
import { EconomicEdgeResolver } from "../economics/economic-edge-resolver.js";
import { CalibratedEdgeTable } from "../calibration/calibrated-edge-table.js";
import type { CalibratedEdgeBucket } from "../calibration/calibrated-edge-table.js";
import { continuationQuality, validateContinuationQualityConfig } from "./continuation-quality.js";
import { validateMultiHorizonAnalyticConfig } from "../economics/analytic-edge.js";
import { pullbackRecoveryPass, pullbackState, validatePullbackRecoveryConfig,
  type PullbackRecoveryConfig } from "./pullback-recovery.js";
import { earlyBreakoutPass, validateEarlyBreakoutConfig, type EarlyBreakoutConfig } from "./early-breakout.js";

export type SignalMode = "DETERMINISTIC_ONLY" | "DETERMINISTIC_WITH_MODEL_VETO" | "DETERMINISTIC_WITH_MODEL_RANKING";
export interface SystemGateState {
  bookValid: boolean; sequenceValid: boolean; checksumValid: boolean; publicStreamHealthy: boolean; privateStreamHealthy: boolean;
  accountReconciled: boolean; clockHealthy: boolean; entriesAllowed: boolean; noExistingPosition: boolean; noPendingEntry: boolean;
}
export interface ScoreWeights {
  micro: number; qi1: number; qiK: number; ofi: number; tfi: number; replenishment: number; velocity: number;
  acceleration: number; impulse: number; cusum: number; efficiency: number; flipQuality: number;
}
export interface DeterministicSignalConfig {
  mode: SignalMode;
  configurationVersion: string;
  maximumSpreadBps: number; maximumSpreadZ: number; minimumDepthZ: number; maximumImpactBps: number;
  microEdgeBps: number; qi1: number; qiK: number; ofi: number; tfi: number; replenishment: number; velocityZ: number;
  maximumOpposingAccelerationZ: number; impulseBps: number; breakoutBps: number; cusum: number; efficiency: number; maximumFlipRate: number;
  minimumBookVotes: number; minimumFlowVotes: number; minimumKinematicVotes: number;
  scoreEnter: number; scoreReset: number; arbitrationMargin: number; scoreWeights: ScoreWeights;
  persistenceWindowMs: number; minimumPersistence: number; minimumConfirmationMs: number; minimumConfirmationEvents: number;
  cooldownMs: number; resetMs: number;
  maximumImpulseZ: number; maximumChaseBps: number; maximumAnchorZ: number;
  costSafetyFactor: number; minimumNetEdgeBps: number; fullQualityEdgeBps: number;
  edgeSourceMode: EdgeSourceMode; analyticEdge: AnalyticEdgeConfig;
  economicEdgeMode: EconomicEdgeMode;
  analyticHorizons: AnalyticHorizonConfig[];
  continuationQuality: ContinuationQualityConfig;
  minimumEconomicSizeScale: number;
  minimumMakerFillProbability: number;
  requireMakerEntry: boolean;
  /** Allows exact taker economics to qualify only the continuation family; pullbacks remain maker-only. */
  allowTakerContinuation: boolean;
  minimumSlowTrendAlignment: number;
  minimumSlowTrendEfficiency: number;
  minimumSlowTrendMoveBps: number;
  minimumEffectiveSampleCount: number;
  positiveCostErrorP95Bps: number;
  maximumReasonableCostBps: number;
  maximumReasonableGrossBps: number;
  calibratedEdges: CalibratedEdgeBucket[];
  pullbackRecovery: PullbackRecoveryConfig;
  earlyBreakout: EarlyBreakoutConfig;
  microTrigger: SmallFractionTriggerConfig;
}
export interface EntryContext {
  symbol: string; sequence: bigint; nowMs: number; features: DeterministicFeatures; regime: RegimeDecision; system: SystemGateState;
  bestBid: number; bestAsk: number; longCost: CostEstimate; shortCost: CostEstimate;
  longEconomicCosts?: readonly CostBreakdown[]; shortEconomicCosts?: readonly CostBreakdown[];
  longPullbackEconomicCosts?: readonly CostBreakdown[]; shortPullbackEconomicCosts?: readonly CostBreakdown[];
  longLiquidity?: LiquidityDecision; shortLiquidity?: LiquidityDecision;
}
export interface RuleVoteVector {
  micro: boolean; qi1: boolean; qiK: boolean; ofi: boolean; tfi: boolean; replenishment: boolean;
  velocity: boolean; acceleration: boolean; impulse: boolean; breakout: boolean; cusum: boolean;
}
export interface RuleVotes {
  book: number; flow: number; kinematic: number; activeGroups: number; qualityVotes: number;
  quality: boolean; quorum: boolean; vector: RuleVoteVector;
}
export type DirectionPhase = "IDLE" | "ARMED" | "COOLDOWN";
export interface RuleDiagnostics {
  family: EntryFamily; side: Direction; phase: DirectionPhase; score: number; oppositeScore: number; scoreMargin: number; votes: RuleVotes;
  persistence: number; evidence: number; confirmationMs: number; confirmationEvents: number;
  deltaMicroBps: number; sensorThresholdBps: number; microNoiseBps: number; microPressure: number;
  grossOpportunityBps: number; uncertaintyReserveBps: number; roundTripCostBps: number; lowerBoundNetBps: number;
  chaseBps: number; impulseZ: number; anchorZ: number;
  edgeSource: "CALIBRATED" | "ANALYTIC" | "UNRESOLVED"; edgeHorizonMs: number; edgeQuality: number;
  edgeEffectiveSampleCount: number;
  executionPath?: ExecutionPath; robustCostBps: number; costShortfallBps: number;
  costBreakdown?: CostBreakdown;
  requiredContinuationQuality: number | null; continuationQuality: number; economicSizeScale: number;
  scorePass: boolean; rawDirectionalPass: boolean; candidatePass: boolean; edgeResolvedPass: boolean;
  healthPass: boolean; liquidityPass: boolean; regimePass: boolean; directionAuthorizationPass: boolean;
  persistencePass: boolean; antiChasePass: boolean;
  pullbackCalibrationPass: boolean; pullbackTrendConfirmationPass: boolean;
  exposurePass: boolean; cooldownPass: boolean; costPass: boolean; arbitrationPass: boolean; slowTrendPass: boolean;
  continuationTrendPass: boolean; pullbackRecoveryPass: boolean; earlyBreakoutPass: boolean;
  pullbackStructuralMoveBps: number; pullbackDepthBps: number; pullbackRecoveryBps: number; pullbackRemainingRoomBps: number;
  liquidityReasons: readonly string[]; tradeThresholdBps: number; stressThresholdBps: number; reasons: string[];
}
export interface DeterministicDirectionalCandidate {
  source: "DETERMINISTIC_MICRO" | "DETERMINISTIC_PULLBACK_RECOVERY" | "DETERMINISTIC_EARLY_BREAKOUT"; configurationVersion: string; decisionId: string; symbol: string; sequence: bigint; createdMs: number;
  side: Direction; deterministicScore: number; occupancy: number; evidence: number; deltaMicroBps: number;
  sensorThresholdBps: number; chaseBps: number; diagnostics: RuleDiagnostics;
}
export interface DeterministicTradeIntent {
  source: "DETERMINISTIC_MICRO" | "DETERMINISTIC_PULLBACK_RECOVERY" | "DETERMINISTIC_EARLY_BREAKOUT"; configurationVersion: string; decisionId: string; symbol: string; sequence: bigint; createdMs: number;
  side: Direction; deterministicScore: number; grossOpportunityBps: number; uncertaintyReserveBps: number; lowerBoundNetBps: number;
  quality: number; diagnostics: RuleDiagnostics;
  selectedHorizonMs?: number; executionPath?: ExecutionPath; robustCostBps?: number;
}
export interface DeterministicEvaluation {
  long: RuleDiagnostics; short: RuleDiagnostics; candidate: DeterministicDirectionalCandidate | null; intent: DeterministicTradeIntent | null;
}
export interface SignalValidityAssessment {
  valid: boolean;
  /** Hard failures invalidate a resting maker immediately; transient micro evidence may use lifecycle confirmation. */
  immediateCancel: boolean;
  reasons: readonly string[];
}

/** Converts a sensitive micro-move candidate into an order intent only after all conservative execution gates pass. */
export class DeterministicEntryEngine {
  private readonly edgeResolver: EconomicEdgeResolver;
  private readonly costGate: MultiHorizonCostGate;
  private readonly microTrigger: SmallFractionEntryTrigger;
  private lastEvaluation?: DeterministicEvaluation;

  public constructor(private readonly cfg: DeterministicSignalConfig,
    calibrated = new CalibratedEdgeTable(cfg.calibratedEdges)) {
    validateDeterministicConfig(cfg);
    this.edgeResolver = new EconomicEdgeResolver(cfg.economicEdgeMode, {
      horizons: cfg.analyticHorizons,
      spreadUncertaintyWeight: cfg.analyticEdge.spreadUncertaintyWeight,
      flipUncertaintyWeight: cfg.analyticEdge.flipUncertaintyWeight,
    }, cfg.analyticEdge, cfg.pullbackRecovery, calibrated);
    this.costGate = new MultiHorizonCostGate({
      costSafetyFactor: cfg.costSafetyFactor, minimumNetEdgeBps: cfg.minimumNetEdgeBps,
      fullQualityEdgeBps: cfg.fullQualityEdgeBps, minimumEconomicSizeScale: cfg.minimumEconomicSizeScale,
      minimumMakerFillProbability: cfg.minimumMakerFillProbability,
      minimumEffectiveSampleCount: cfg.minimumEffectiveSampleCount,
      maximumReasonableCostBps: cfg.maximumReasonableCostBps,
      maximumReasonableGrossBps: cfg.maximumReasonableGrossBps,
    }, cfg.economicEdgeMode);
    this.microTrigger = new SmallFractionEntryTrigger(cfg.microTrigger);
  }

  public evaluate(context: EntryContext): DeterministicTradeIntent | null {
    const trigger = this.microTrigger.update(this.microFeatures(context));
    const longArbitrationPass = trigger.long.score - trigger.short.score >= this.cfg.microTrigger.arbitrationMargin;
    const shortArbitrationPass = trigger.short.score - trigger.long.score >= this.cfg.microTrigger.arbitrationMargin;
    const long = this.diagnostics(trigger.long, trigger.short.score, context, trigger.candidate, longArbitrationPass);
    const short = this.diagnostics(trigger.short, trigger.long.score, context, trigger.candidate, shortArbitrationPass);
    const selectedDiagnostics = trigger.candidate?.side === 1 ? long : trigger.candidate?.side === -1 ? short : undefined;
    const candidate = selectedDiagnostics && trigger.candidate
      ? this.directionalCandidate(context, trigger.candidate, selectedDiagnostics) : null;
    const intent = selectedDiagnostics && this.commonPass(selectedDiagnostics)
      ? this.tradeIntent(context, selectedDiagnostics) : null;
    if (intent) this.microTrigger.commitCandidate(intent.side, context.nowMs);
    this.lastEvaluation = { long, short, candidate, intent };
    return intent;
  }

  public latestEvaluation(): DeterministicEvaluation | undefined { return this.lastEvaluation; }

  public rearmAfterUnfilledMakerExpiry(side: Direction, nowMs: number): boolean {
    return this.microTrigger.rearmAfterUnfilledMakerExpiry(side, nowMs);
  }

  public revalidateExactCost(intent: DeterministicTradeIntent, exactCost: CostEstimate): DeterministicTradeIntent | null {
    const path = intent.executionPath ?? "TAKER_TAKER";
    const exact = exactCostBreakdown(exactCost, path,
      path === "TAKER_TAKER" ? 1 : this.cfg.minimumMakerFillProbability,
      this.cfg.positiveCostErrorP95Bps);
    if (intent.diagnostics.edgeSource === "UNRESOLVED") return null;
    const decision = this.costGate.evaluate([{
      source: intent.diagnostics.edgeSource, side: intent.side, horizonMs: intent.selectedHorizonMs ?? intent.diagnostics.edgeHorizonMs,
      grossBeforeUncertaintyBps: intent.grossOpportunityBps + intent.uncertaintyReserveBps,
      signalUncertaintyBps: intent.uncertaintyReserveBps, conservativeGrossBps: intent.grossOpportunityBps,
      quality: intent.diagnostics.edgeQuality, effectiveSampleCount: intent.diagnostics.edgeEffectiveSampleCount,
      family: intent.diagnostics.family,
      executionPath: path,
    }], [exact]);
    const selected = decision.selected;
    if (!selected) return null;
    const lowerBoundNetBps = selected.lowerBoundNetBps;
    const robustCost = selected.robustCostBps;
    const quality = decision.sizeScale;
    return {
      ...intent, lowerBoundNetBps, quality, robustCostBps: robustCost,
      diagnostics: {
        ...intent.diagnostics, roundTripCostBps: exactCost.roundTripBps, robustCostBps: robustCost,
        lowerBoundNetBps, costShortfallBps: 0, economicSizeScale: quality, costPass: true,
        costBreakdown: exact,
        reasons: intent.diagnostics.reasons.filter((reason) => reason !== "COST_GATE"),
      },
    };
  }

  public signalStillValid(side: Direction, features: DeterministicFeatures, regime: RegimeDecision,
    family?: EntryFamily, edgeSource?: RuleDiagnostics["edgeSource"]): boolean {
    return this.assessSignalValidity(side, features, regime, family, edgeSource).valid;
  }

  public assessSignalValidity(side: Direction, features: DeterministicFeatures, regime: RegimeDecision,
    family?: EntryFamily, edgeSource?: RuleDiagnostics["edgeSource"]): SignalValidityAssessment {
    if (features.stale) return invalidSignal(true, "STALE_FEATURES");
    if (!features.kinematicsReady) return invalidSignal(true, "KINEMATICS_UNAVAILABLE");
    if (family === "PULLBACK_RECOVERY" && edgeSource !== "CALIBRATED"
      && !(this.cfg.economicEdgeMode === "ANALYTIC_PAPER" && edgeSource === "ANALYTIC")) {
      return invalidSignal(true, "PULLBACK_CALIBRATION_REQUIRED");
    }
    if (family === "PULLBACK_RECOVERY" && edgeSource === "ANALYTIC"
      && !this.analyticPullbackTrendPass(side, features)) {
      return invalidSignal(true, "PULLBACK_TREND_CONFIRMATION_REQUIRED");
    }
    if (family === "PULLBACK_RECOVERY" && edgeSource === "ANALYTIC"
      && !(side === 1 ? regime.allowLong : regime.allowShort)) {
      return invalidSignal(true, "REGIME_GATE");
    }
    const structure = this.structuralSetup(side, features);
    if (family === "CONTINUATION" ? !structure.continuationPass
      : family === "PULLBACK_RECOVERY" ? !structure.pullbackPass
        : family === "EARLY_BREAKOUT" ? !structure.earlyBreakoutPass : !structure.pass) {
      const reason = family === "CONTINUATION" ? "CONTINUATION_TREND_GATE"
        : family === "EARLY_BREAKOUT" ? "EARLY_BREAKOUT_GATE" : "PULLBACK_RECOVERY_GATE";
      return invalidSignal(family !== "PULLBACK_RECOVERY", reason);
    }
    const halfSpread = Math.max(features.spread / 2, 1e-12);
    const pressure = clamp((features.microprice - features.mid) / halfSpread, -1, 1);
    const cfg = this.cfg.microTrigger;
    const directionAuthorizationPass = this.continuationDirectionAuthorized(side, regime);
    const neutralRegime = !regime.allowLong && !regime.allowShort;
    const neutralBookCoherencePass = side * pressure >= cfg.minimumMicroPressure
      && side * features.qiK >= cfg.minimumQiK;
    const book = side * pressure >= cfg.minimumMicroPressure || side * features.qiK >= cfg.minimumQiK;
    const flow = side * features.ofi >= cfg.minimumOfi || side * features.tfi >= cfg.minimumTfi
      || side * features.replenishmentPressure >= cfg.minimumReplenishment;
    const breakout = side === 1 ? features.breakoutUpBps : features.breakoutDownBps;
    const cusum = side === 1 ? features.cusumUpScore : -features.cusumDownScore;
    const motion = side * features.velocityZ >= cfg.minimumVelocityZ
      || breakout >= cfg.minimumBreakoutBps || cusum >= cfg.minimumCusum;
    const score = side * this.signedScore(pressure, features);
    const reasons: string[] = [];
    // A resting neutral-regime continuation remains valid only while both the
    // top-of-book pressure and aggregate-book imbalance agree with its side.
    if ((family === "CONTINUATION" || family === "EARLY_BREAKOUT") && (!directionAuthorizationPass
      || (neutralRegime && !neutralBookCoherencePass))) reasons.push("REGIME_GATE");
    if (Number(book) + Number(flow) + Number(motion) < 2) reasons.push("MICRO_GROUP_QUORUM");
    if (!motion) reasons.push("MOTION_EVIDENCE");
    if (!(score > cfg.releaseScore)) reasons.push("RELEASE_SCORE");
    return reasons.length === 0
      ? { valid: true, immediateCancel: false, reasons: [] }
      : { valid: false, immediateCancel: false, reasons };
  }

  private commonPass(d: RuleDiagnostics): boolean {
    return d.candidatePass && d.healthPass && d.liquidityPass && d.antiChasePass && d.exposurePass
      && d.cooldownPass && d.edgeResolvedPass && d.costPass && d.slowTrendPass && d.pullbackCalibrationPass
      && d.pullbackTrendConfirmationPass && d.directionAuthorizationPass;
  }

  private diagnostics(trigger: SideTriggerDiagnostics, oppositeScore: number, context: EntryContext,
    candidate: SmallFractionCandidate | null, arbitrationPass: boolean): RuleDiagnostics {
    const direction = trigger.side;
    const f = context.features;
    const cost = direction === 1 ? context.longCost : context.shortCost;
    const dynamicLiquidity = direction === 1 ? context.longLiquidity : context.shortLiquidity;
    const votes = this.microVotes(direction, f, trigger);
    const healthPass = this.healthPass(context.system);
    const regimePass = direction === 1 ? context.regime.allowLong : context.regime.allowShort;
    const candidatePass = candidate?.side === direction;
    const scorePass = trigger.score >= this.cfg.microTrigger.armScore;
    const rawDirectionalPass = trigger.groupQuorum && scorePass && arbitrationPass;
    const strong = trigger.score >= this.cfg.microTrigger.strongScore;
    const requiredTimeMs = strong ? this.cfg.microTrigger.strongConfirmationMs : this.cfg.microTrigger.minimumConfirmationMs;
    const requiredEvents = strong ? this.cfg.microTrigger.strongConfirmationEvents : this.cfg.microTrigger.minimumConfirmationEvents;
    const persistencePass = trigger.occupancy >= trigger.requiredOccupancy
      && trigger.evidence >= trigger.requiredEvidence
      && trigger.confirmationMs >= requiredTimeMs && trigger.consecutiveEvents >= requiredEvents;
    const antiChasePass = trigger.chaseBps <= this.cfg.microTrigger.maximumChaseBps;
    const cooldownPass = !trigger.reasons.includes("COOLDOWN_ACTIVE") && !trigger.reasons.includes("ALREADY_FIRED_IN_EPISODE");
    const continuation = continuationQuality(direction, f, context.regime, this.cfg.continuationQuality);
    const structure = this.structuralSetup(direction, f);
    // A neutral micro regime is not evidence for the opposite direction, but
    // it may authorize a new continuation only when strong confirmation and
    // both independent book views agree. This prevents a slow-trend signal
    // from entering at a local turn while immediate price pressure opposes it.
    const neutralRegime = !context.regime.allowLong && !context.regime.allowShort;
    const continuationDirectionAuthorizationPass = regimePass || (neutralRegime && strong && votes.book >= 2);
    // During a causally aligned continuation, a moderately widened spread may
    // proceed to exact economics when it is still below the learned stress
    // threshold and every non-spread liquidity check remains healthy. The
    // robust cost gate below prices the observed spread and may still reject.
    const costRevalidatedSpreadPass = dynamicLiquidity !== undefined
      && structure.family === "CONTINUATION" && structure.continuationPass && !dynamicLiquidity.stress
      && dynamicLiquidity.reasons.length === 1
      && dynamicLiquidity.reasons[0] === "SPREAD_ABOVE_DYNAMIC_TRADE_THRESHOLD";
    const liquidityPass = dynamicLiquidity?.pass === true || costRevalidatedSpreadPass
      || (dynamicLiquidity === undefined && this.staticLiquidityPass(f, cost));
    const liquidityReasons = liquidityPass ? []
      : dynamicLiquidity?.reasons ?? ["STATIC_LIQUIDITY_LIMIT"];
    const slowTrendPass = structure.pass;
    const confirmationQuality = clamp((trigger.score - this.cfg.microTrigger.releaseScore)
      / Math.max(this.cfg.microTrigger.strongScore - this.cfg.microTrigger.releaseScore, 1e-9), 0, 1);
    const edges = this.edgeResolver.resolve({ symbol: context.symbol, family: structure.family, side: direction, features: f,
      regime: context.regime, continuation, confirmationQuality,
      score: trigger.score, scoreReset: this.cfg.microTrigger.releaseScore,
      persistence: trigger.occupancy, evidence: trigger.evidence });
    const suppliedCosts = structure.family === "PULLBACK_RECOVERY"
      ? direction === 1 ? context.longPullbackEconomicCosts : context.shortPullbackEconomicCosts
      : direction === 1 ? context.longEconomicCosts : context.shortEconomicCosts;
    const availableCosts = suppliedCosts && suppliedCosts.length > 0 ? suppliedCosts
      : [exactCostBreakdown(cost, "TAKER_TAKER", 1, this.cfg.positiveCostErrorP95Bps)];
    const makerRequired = this.cfg.requireMakerEntry
      && !(structure.family === "CONTINUATION" && this.cfg.allowTakerContinuation)
      && structure.family !== "EARLY_BREAKOUT";
    // Qualify a breakout on the route it must actually use. A maker estimate is
    // not a substitute while price is moving away from the resting order.
    const costs = structure.family === "EARLY_BREAKOUT"
      ? availableCosts.filter((item) => item.path === "TAKER_TAKER")
      : makerRequired
        ? availableCosts.filter((item) => item.path === "MAKER_TAKER" || item.path === "MAKER_MAKER_TAKER_FALLBACK")
        : availableCosts;
    const decision = this.costGate.evaluate(edges, costs);
    const economic = decision.selected ?? decision.bestRejected;
    const calibratedPullbackPass = economic?.edge.source === "CALIBRATED"
      && economic.edge.effectiveSampleCount >= this.cfg.minimumEffectiveSampleCount;
    const analyticPaperPullbackPass = this.cfg.economicEdgeMode === "ANALYTIC_PAPER"
      && economic?.edge.source === "ANALYTIC";
    // Counter-regime pullbacks need cohort-level evidence. Analytical research
    // may observe them in shadow, but may execute only in an explicitly
    // authorized directional regime.
    const directionAuthorizationPass = structure.family === "PULLBACK_RECOVERY"
      ? calibratedPullbackPass || (analyticPaperPullbackPass && regimePass)
      : continuationDirectionAuthorizationPass;
    const pullbackCalibrationPass = structure.family !== "PULLBACK_RECOVERY"
      || calibratedPullbackPass || analyticPaperPullbackPass;
    // A calibrated bucket may prove a counter-trend pullback profitable. The
    // uncalibrated analytical paper path has no such evidence, so require the
    // causal 15/60-minute trends to retain the proposed direction. The fast
    // five-minute return may still oppose the entry during the pullback.
    const pullbackTrendConfirmationPass = structure.family !== "PULLBACK_RECOVERY"
      || calibratedPullbackPass
      || (analyticPaperPullbackPass && this.analyticPullbackTrendPass(direction, f));
    // Signal uncertainty is already incorporated in conservativeGrossBps and is not charged again.
    const grossOpportunityBps = economic?.edge.conservativeGrossBps ?? 0;
    const uncertaintyReserveBps = economic?.edge.signalUncertaintyBps ?? 0;
    const lowerBoundNetBps = economic?.lowerBoundNetBps ?? Number.NEGATIVE_INFINITY;
    const edgeResolvedPass = edges.length > 0;
    const costPass = decision.pass;
    const exposurePass = context.system.noExistingPosition && context.system.noPendingEntry;
    const impulseZ = direction * f.impulseBps / Math.max(f.sigmaImpulseBps, 1e-6);
    const anchorZ = direction * f.anchorDistanceBps / Math.max(f.sigmaHBps, 1e-6);
    const phase: DirectionPhase = trigger.reasons.includes("COOLDOWN_ACTIVE") || trigger.reasons.includes("ALREADY_FIRED_IN_EPISODE")
      ? "COOLDOWN" : trigger.armed ? "ARMED" : "IDLE";
    const reasons = [...trigger.reasons];
    if (!healthPass) reasons.push("HEALTH_GATE");
    if (!liquidityPass) reasons.push("LIQUIDITY_GATE");
    if (!directionAuthorizationPass) reasons.push("REGIME_GATE");
    if (!exposurePass) reasons.push("EXPOSURE_GATE");
    if (!edgeResolvedPass) reasons.push("EDGE_NOT_RESOLVED");
    if (edgeResolvedPass && !costPass) reasons.push("COST_GATE");
    if (!arbitrationPass) reasons.push("ARBITRATION_GATE");
    const pullback = pullbackState(direction, f);
    if (!slowTrendPass) reasons.push(!f.slowTrendReady && !pullback.ready
      ? "STRUCTURAL_HISTORY_WARMUP" : "STRUCTURAL_SETUP_GATE");
    if (!structure.continuationPass) reasons.push("CONTINUATION_TREND_GATE");
    if (!structure.pullbackPass) reasons.push("PULLBACK_RECOVERY_GATE");
    if (!structure.earlyBreakoutPass) reasons.push("EARLY_BREAKOUT_GATE");
    if (!pullbackCalibrationPass) reasons.push("PULLBACK_CALIBRATION_REQUIRED");
    if (!pullbackTrendConfirmationPass) reasons.push("PULLBACK_TREND_CONFIRMATION_REQUIRED");
    return {
      family: structure.family, side: direction, phase, score: trigger.score, oppositeScore, scoreMargin: trigger.score - oppositeScore, votes,
      persistence: trigger.occupancy, evidence: trigger.evidence, confirmationMs: trigger.confirmationMs,
      confirmationEvents: trigger.consecutiveEvents, deltaMicroBps: trigger.deltaMicroBps,
      sensorThresholdBps: trigger.sensorThresholdBps, microNoiseBps: trigger.microNoiseBps, microPressure: trigger.microPressure,
      grossOpportunityBps, uncertaintyReserveBps,
      roundTripCostBps: economic?.cost.estimatedCostBps ?? cost.roundTripBps,
      robustCostBps: economic?.robustCostBps ?? this.cfg.costSafetyFactor * cost.roundTripBps,
      costShortfallBps: economic?.shortfallBps ?? Number.POSITIVE_INFINITY,
      requiredContinuationQuality: economic?.requiredQuality ?? null,
      continuationQuality: continuation.score, economicSizeScale: decision.sizeScale,
      ...(economic ? { executionPath: economic.cost.path } : {}), lowerBoundNetBps,
      ...(economic ? { costBreakdown: economic.cost } : {}),
      chaseBps: trigger.chaseBps, impulseZ, anchorZ,
      edgeSource: economic?.edge.source ?? "UNRESOLVED", edgeHorizonMs: economic?.edge.horizonMs ?? 0,
      edgeQuality: economic?.edge.quality ?? continuation.score,
      edgeEffectiveSampleCount: economic?.edge.effectiveSampleCount ?? 0,
      scorePass, rawDirectionalPass, candidatePass, edgeResolvedPass, healthPass, liquidityPass, regimePass,
      directionAuthorizationPass,
      pullbackCalibrationPass, pullbackTrendConfirmationPass, persistencePass, antiChasePass, exposurePass, cooldownPass, costPass, arbitrationPass,
      slowTrendPass,
      continuationTrendPass: structure.continuationPass, pullbackRecoveryPass: structure.pullbackPass,
      earlyBreakoutPass: structure.earlyBreakoutPass,
      pullbackStructuralMoveBps: pullback.structuralMoveBps, pullbackDepthBps: pullback.pullbackDepthBps,
      pullbackRecoveryBps: pullback.recoveryBps, pullbackRemainingRoomBps: pullback.remainingRoomBps,
      liquidityReasons,
      tradeThresholdBps: dynamicLiquidity?.tradeThresholdBps ?? this.cfg.maximumSpreadBps,
      stressThresholdBps: dynamicLiquidity?.stressThresholdBps ?? this.cfg.maximumSpreadBps,
      reasons: [...new Set([...reasons, ...(economic?.rejectionReasons ?? [])])],
    };
  }

  private tradeIntent(context: EntryContext, selected: RuleDiagnostics): DeterministicTradeIntent {
    const source = deterministicSource(selected.family);
    return {
      source, configurationVersion: this.cfg.configurationVersion,
      decisionId: `${context.symbol}:${context.sequence.toString()}:${selected.side}:${selected.family}:${context.nowMs}`,
      symbol: context.symbol, sequence: context.sequence, createdMs: context.nowMs, side: selected.side,
      deterministicScore: selected.score, grossOpportunityBps: selected.grossOpportunityBps,
      uncertaintyReserveBps: selected.uncertaintyReserveBps, lowerBoundNetBps: selected.lowerBoundNetBps,
      quality: selected.economicSizeScale, diagnostics: selected,
      selectedHorizonMs: selected.edgeHorizonMs,
      ...(selected.executionPath === undefined ? {} : { executionPath: selected.executionPath }),
      robustCostBps: selected.robustCostBps,
    };
  }

  private directionalCandidate(context: EntryContext, micro: SmallFractionCandidate,
    selected: RuleDiagnostics): DeterministicDirectionalCandidate {
    const source = deterministicSource(selected.family);
    return {
      source, configurationVersion: this.cfg.configurationVersion,
      decisionId: `${context.symbol}:${context.sequence.toString()}:${selected.side}:${selected.family}:${context.nowMs}`,
      symbol: context.symbol, sequence: context.sequence, createdMs: context.nowMs, side: selected.side,
      deterministicScore: selected.score, occupancy: micro.occupancy, evidence: micro.evidence,
      deltaMicroBps: micro.deltaMicroBps, sensorThresholdBps: micro.sensorThresholdBps,
      chaseBps: micro.chaseBps, diagnostics: selected,
    };
  }

  private healthPass(system: SystemGateState): boolean {
    return system.bookValid && system.sequenceValid && system.checksumValid && system.publicStreamHealthy
      && system.privateStreamHealthy && system.accountReconciled && system.clockHealthy && system.entriesAllowed;
  }

  private staticLiquidityPass(f: DeterministicFeatures, cost: CostEstimate): boolean {
    return f.warmedUp && !f.stale && f.providerAgeMs >= 0 && f.spreadBps <= this.cfg.maximumSpreadBps
      && f.spreadZ <= this.cfg.maximumSpreadZ && f.depthZ >= this.cfg.minimumDepthZ
      && cost.impactBps <= this.cfg.maximumImpactBps;
  }

  private microFeatures(context: EntryContext): SmallFractionFeatures {
    const f = context.features;
    return {
      symbol: context.symbol, nowMs: context.nowMs, bestBid: context.bestBid, bestAsk: context.bestAsk,
      mid: f.mid, microprice: f.microprice, qiK: f.qiK, ofi: f.ofi, tfi: f.tfi,
      replenishmentPressure: f.replenishmentPressure, velocityZ: f.velocityZ, accelerationZ: f.accelerationZ,
      breakoutUpBps: f.breakoutUpBps, breakoutDownBps: f.breakoutDownBps,
      cusumUp: f.cusumUpScore, cusumDown: f.cusumDownScore, efficiency: f.efficiency,
      flowFlipRate: f.flowFlipRate, varianceRate: f.varianceRate, providerAgeMs: f.providerAgeMs,
      kinematicsReady: f.kinematicsReady, stale: f.stale, bookReady: context.system.bookValid,
    };
  }

  private signedScore(microPressure: number, f: DeterministicFeatures): number {
    const cfg = this.cfg.microTrigger;
    return cfg.microWeight * Math.tanh(microPressure / cfg.microPressureScale)
      + cfg.qiKWeight * Math.tanh(f.qiK / cfg.qiKScale)
      + cfg.ofiWeight * Math.tanh(f.ofi / cfg.ofiScale)
      + cfg.tfiWeight * Math.tanh(f.tfi / cfg.tfiScale)
      + cfg.replenishmentWeight * Math.tanh(f.replenishmentPressure / cfg.replenishmentScale)
      + cfg.velocityWeight * Math.tanh(f.velocityZ / cfg.velocityScale)
      + cfg.breakoutWeight * Math.tanh((f.breakoutUpBps - f.breakoutDownBps) / cfg.breakoutScaleBps);
  }

  private continuationTrendPass(side: Direction, f: DeterministicFeatures): boolean {
    return f.slowTrendReady
      && side * f.slowTrendAlignment >= this.cfg.minimumSlowTrendAlignment
      && f.slowTrendEfficiency >= this.cfg.minimumSlowTrendEfficiency
      && side * f.trendSlowBps >= this.cfg.minimumSlowTrendMoveBps
      && side * f.trendFastBps > 0 && side * f.trendMediumBps > 0;
  }

  private analyticPullbackTrendPass(side: Direction, f: DeterministicFeatures): boolean {
    return f.slowTrendReady
      && side * f.slowTrendAlignment >= this.cfg.minimumSlowTrendAlignment
      && f.slowTrendEfficiency >= this.cfg.minimumSlowTrendEfficiency
      && side * f.trendMediumBps > 0
      && side * f.trendSlowBps >= this.cfg.minimumSlowTrendMoveBps;
  }

  private continuationDirectionAuthorized(side: Direction, regime: RegimeDecision): boolean {
    // Aligned and neutral regimes are eligible; an explicit opposite-side
    // authorization remains a hard initial-entry block.
    return side === 1
      ? regime.allowLong || !regime.allowShort
      : regime.allowShort || !regime.allowLong;
  }

  private structuralSetup(side: Direction, f: DeterministicFeatures): {
    family: EntryFamily; pass: boolean; continuationPass: boolean; pullbackPass: boolean; earlyBreakoutPass: boolean;
  } {
    const continuationPass = this.continuationTrendPass(side, f);
    const pullbackPass = pullbackRecoveryPass(side, f, this.cfg.pullbackRecovery);
    const breakoutPass = earlyBreakoutPass(side, f, this.cfg.earlyBreakout);
    const family: EntryFamily = pullbackPass ? "PULLBACK_RECOVERY"
      : breakoutPass ? "EARLY_BREAKOUT" : continuationPass ? "CONTINUATION" : "CONTINUATION";
    return { family, pass: continuationPass || pullbackPass || breakoutPass,
      continuationPass, pullbackPass, earlyBreakoutPass: breakoutPass };
  }

  private microVotes(direction: Direction, f: DeterministicFeatures, d: SideTriggerDiagnostics): RuleVotes {
    const cfg = this.cfg.microTrigger;
    const directionalBreakout = direction === 1 ? f.breakoutUpBps : f.breakoutDownBps;
    const directionalCusum = direction === 1 ? f.cusumUpScore : -f.cusumDownScore;
    const vector: RuleVoteVector = {
      micro: direction * d.microPressure >= cfg.minimumMicroPressure, qi1: false,
      qiK: direction * f.qiK >= cfg.minimumQiK, ofi: direction * f.ofi >= cfg.minimumOfi,
      tfi: direction * f.tfi >= cfg.minimumTfi,
      replenishment: direction * f.replenishmentPressure >= cfg.minimumReplenishment,
      velocity: direction * f.velocityZ >= cfg.minimumVelocityZ, acceleration: false,
      impulse: direction * d.deltaMicroBps >= d.sensorThresholdBps,
      breakout: directionalBreakout >= cfg.minimumBreakoutBps, cusum: directionalCusum >= cfg.minimumCusum,
    };
    const book = Number(vector.micro) + Number(vector.qiK);
    const flow = Number(vector.ofi) + Number(vector.tfi) + Number(vector.replenishment);
    const kinematic = Number(vector.velocity) + Number(vector.impulse) + Number(vector.breakout) + Number(vector.cusum);
    const qualityVotes = Number(f.efficiency >= this.cfg.efficiency) + Number(f.flowFlipRate <= this.cfg.maximumFlipRate);
    return { book, flow, kinematic, activeGroups: d.groupCount, qualityVotes, quality: true, quorum: d.groupQuorum, vector };
  }

}

export function validateDeterministicConfig(cfg: DeterministicSignalConfig): void {
  const fail = (message: string): never => { throw new Error(`Invalid deterministic configuration: ${message}`); };
  if (!cfg.configurationVersion) fail("configurationVersion is required");
  if (!["DETERMINISTIC_ONLY", "DETERMINISTIC_WITH_MODEL_VETO", "DETERMINISTIC_WITH_MODEL_RANKING"].includes(cfg.mode)) fail("unknown signal mode");
  if (!["CALIBRATED_REQUIRED", "CALIBRATED_OR_ANALYTIC", "ANALYTIC_ONLY"].includes(cfg.edgeSourceMode)) fail("unknown edge source mode");
  if (!["ANALYTIC_SHADOW", "ANALYTIC_PAPER", "CALIBRATED_PAPER", "CALIBRATED_LIVE"].includes(cfg.economicEdgeMode)) fail("unknown economic edge mode");
  if (flattenNumbers(cfg).some((value) => !Number.isFinite(value))) fail("all numeric configuration values must be finite");
  if (!(cfg.scoreEnter > cfg.scoreReset)) fail("scoreEnter must be greater than scoreReset");
  if (cfg.scoreEnter < -1 || cfg.scoreEnter > 1 || cfg.scoreReset < -1 || cfg.scoreReset > 1) fail("score thresholds must be in [-1,1]");
  if (cfg.arbitrationMargin < 0 || cfg.arbitrationMargin > 2) fail("arbitrationMargin must be in [0,2]");
  if (cfg.minimumPersistence < 0 || cfg.minimumPersistence > 1) fail("minimumPersistence must be in [0,1]");
  if (cfg.efficiency < 0 || cfg.efficiency > 1 || cfg.maximumFlipRate <= 0 || cfg.maximumFlipRate > 1) fail("quality thresholds must be in [0,1]");
  if (!(cfg.costSafetyFactor >= 1)) fail("costSafetyFactor must be at least 1");
  if (!(cfg.minimumEconomicSizeScale > 0 && cfg.minimumEconomicSizeScale <= 1)) fail("minimumEconomicSizeScale must be in (0,1]");
  if (!(cfg.minimumMakerFillProbability >= 0 && cfg.minimumMakerFillProbability <= 1)) fail("minimumMakerFillProbability must be in [0,1]");
  if (!(cfg.minimumSlowTrendAlignment >= 0 && cfg.minimumSlowTrendAlignment <= 1)) fail("minimumSlowTrendAlignment must be in [0,1]");
  if (!(cfg.minimumSlowTrendEfficiency >= 0 && cfg.minimumSlowTrendEfficiency <= 1)) fail("minimumSlowTrendEfficiency must be in [0,1]");
  if (!(cfg.minimumSlowTrendMoveBps >= 0)) fail("minimumSlowTrendMoveBps cannot be negative");
  if (!(cfg.minimumEffectiveSampleCount >= 0)) fail("minimumEffectiveSampleCount cannot be negative");
  if (!(cfg.minimumConfirmationMs >= 0) || !(cfg.cooldownMs >= cfg.minimumConfirmationMs)) fail("cooldown must cover confirmation time");
  if (!Number.isInteger(cfg.minimumConfirmationEvents) || cfg.minimumConfirmationEvents < 1) fail("minimumConfirmationEvents must be a positive integer");
  for (const [value, maximum, name] of [[cfg.minimumBookVotes, 3, "minimumBookVotes"], [cfg.minimumFlowVotes, 3, "minimumFlowVotes"], [cfg.minimumKinematicVotes, 5, "minimumKinematicVotes"]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`${name} is outside its evidence group`);
  }
  const scoreWeights = Object.values(cfg.scoreWeights);
  if (scoreWeights.some((value) => value < 0) || !(scoreWeights.reduce((sum, value) => sum + value, 0) > 0)) fail("score weights must be nonnegative with positive total");
  const positive = [cfg.maximumSpreadBps, cfg.microEdgeBps, cfg.qi1, cfg.qiK, cfg.ofi, cfg.tfi, cfg.replenishment,
    cfg.velocityZ, cfg.efficiency, cfg.persistenceWindowMs, cfg.fullQualityEdgeBps];
  if (positive.some((value) => value <= 0)) fail("positive thresholds must be finite and positive");
  const nonnegative = [cfg.maximumSpreadZ, cfg.maximumImpactBps, cfg.maximumOpposingAccelerationZ, cfg.impulseBps,
    cfg.breakoutBps, cfg.cusum, cfg.minimumConfirmationMs, cfg.cooldownMs, cfg.resetMs, cfg.maximumImpulseZ,
    cfg.maximumChaseBps, cfg.maximumAnchorZ];
  if (nonnegative.some((value) => value < 0)) fail("nonnegative thresholds cannot be negative");
  validateContinuationQualityConfig(cfg.continuationQuality);
  validateMultiHorizonAnalyticConfig({ horizons: cfg.analyticHorizons,
    spreadUncertaintyWeight: cfg.analyticEdge.spreadUncertaintyWeight,
    flipUncertaintyWeight: cfg.analyticEdge.flipUncertaintyWeight });
  validateSmallFractionTriggerConfig(cfg.microTrigger);
  validatePullbackRecoveryConfig(cfg.pullbackRecovery);
  validateEarlyBreakoutConfig(cfg.earlyBreakout);
}

function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(flattenNumbers);
}

function invalidSignal(immediateCancel: boolean, reason: string): SignalValidityAssessment {
  return { valid: false, immediateCancel, reasons: [reason] };
}

function deterministicSource(family: EntryFamily): DeterministicTradeIntent["source"] {
  return family === "PULLBACK_RECOVERY" ? "DETERMINISTIC_PULLBACK_RECOVERY"
    : family === "EARLY_BREAKOUT" ? "DETERMINISTIC_EARLY_BREAKOUT" : "DETERMINISTIC_MICRO";
}
