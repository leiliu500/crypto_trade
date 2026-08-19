import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { CostEstimate } from "./cost.js";
import type { DeterministicFeatures } from "./deterministic-features.js";
import type { RegimeDecision } from "./deterministic-regime.js";
import type { LiquidityDecision } from "./dynamic-liquidity.js";

export type SignalMode = "DETERMINISTIC_ONLY" | "DETERMINISTIC_WITH_MODEL_VETO" | "DETERMINISTIC_WITH_MODEL_RANKING";
export interface SystemGateState {
  bookValid: boolean; sequenceValid: boolean; checksumValid: boolean; publicStreamHealthy: boolean; privateStreamHealthy: boolean;
  accountReconciled: boolean; clockHealthy: boolean; entriesAllowed: boolean; noExistingPosition: boolean; noPendingEntry: boolean;
}
export interface ScoreWeights {
  micro: number; qi1: number; qiK: number; ofi: number; tfi: number; replenishment: number; velocity: number;
  acceleration: number; impulse: number; cusum: number; efficiency: number; flipQuality: number;
}
export interface OpportunityWeights { micro: number; kinematic: number; flow: number; impulse: number; }
export interface DeterministicSignalConfig {
  mode: SignalMode;
  configurationVersion: string;
  maximumProviderAgeMs: number; maximumSpreadBps: number; maximumSpreadZ: number; minimumDepthZ: number;
  minimumDepthNotional: number; maximumImpactBps: number;
  microEdgeBps: number; qi1: number; qiK: number; ofi: number; tfi: number; replenishment: number; velocityZ: number;
  maximumOpposingAccelerationZ: number; impulseBps: number; breakoutBps: number; cusum: number; efficiency: number; maximumFlipRate: number;
  minimumBookVotes: number; minimumFlowVotes: number; minimumKinematicVotes: number;
  scoreEnter: number; scoreReset: number; arbitrationMargin: number; scoreWeights: ScoreWeights;
  persistenceWindowMs: number; minimumPersistence: number; minimumConfirmationMs: number; minimumConfirmationEvents: number;
  cooldownMs: number; resetMs: number;
  maximumImpulseZ: number; maximumChaseBps: number; maximumAnchorZ: number;
  expectedLatencyMs: number; holdHorizonMs: number; ruleDecayTauMs: number;
  kinematicSigmaCap: number; flowSigmaScale: number; impulseSigmaCap: number; totalSigmaCap: number; opportunityWeights: OpportunityWeights;
  efficiencyExponent: number; persistenceExponent: number;
  disagreementPenalty: number; latencyVolatilityPenalty: number; spreadStressPenaltyBps: number; flipPenaltyBps: number; opposingAccelerationPenaltyBps: number;
  costSafetyFactor: number; minimumNetEdgeBps: number; fullQualityEdgeBps: number;
}
export interface EntryContext {
  symbol: string; sequence: bigint; nowMs: number; features: DeterministicFeatures; regime: RegimeDecision; system: SystemGateState;
  bestBid: number; bestAsk: number; expectedLatencyMs: number; longCost: CostEstimate; shortCost: CostEstimate;
  longLiquidity?: LiquidityDecision; shortLiquidity?: LiquidityDecision;
}
export interface RuleVoteVector {
  micro: boolean; qi1: boolean; qiK: boolean; ofi: boolean; tfi: boolean; replenishment: boolean;
  velocity: boolean; acceleration: boolean; impulse: boolean; breakout: boolean; cusum: boolean;
}
export interface RuleVotes { book: number; flow: number; kinematic: number; quality: boolean; quorum: boolean; vector: RuleVoteVector; }
export type DirectionPhase = "IDLE" | "ARMED" | "COOLDOWN";
export interface RuleDiagnostics {
  side: Direction; phase: DirectionPhase; score: number; oppositeScore: number; scoreMargin: number; votes: RuleVotes;
  persistence: number; confirmationMs: number; confirmationEvents: number; grossOpportunityBps: number; uncertaintyReserveBps: number;
  roundTripCostBps: number; lowerBoundNetBps: number; chaseBps: number; impulseZ: number; anchorZ: number;
  scorePass: boolean; rawDirectionalPass: boolean; candidatePass: boolean;
  healthPass: boolean; liquidityPass: boolean; regimePass: boolean; persistencePass: boolean; antiChasePass: boolean;
  exposurePass: boolean; cooldownPass: boolean; costPass: boolean; arbitrationPass: boolean;
  liquidityReasons: readonly string[]; tradeThresholdBps: number; stressThresholdBps: number; reasons: string[];
}
export interface DeterministicDirectionalCandidate {
  source: "DETERMINISTIC"; configurationVersion: string; decisionId: string; symbol: string; sequence: bigint; createdMs: number;
  side: Direction; deterministicScore: number; diagnostics: RuleDiagnostics;
}
export interface DeterministicTradeIntent {
  source: "DETERMINISTIC"; configurationVersion: string; decisionId: string; symbol: string; sequence: bigint; createdMs: number;
  side: Direction; deterministicScore: number; grossOpportunityBps: number; uncertaintyReserveBps: number; lowerBoundNetBps: number;
  quality: number; diagnostics: RuleDiagnostics;
}
export interface DeterministicEvaluation {
  long: RuleDiagnostics; short: RuleDiagnostics; candidate: DeterministicDirectionalCandidate | null; intent: DeterministicTradeIntent | null;
}

interface PersistenceSample { t: number; pass: boolean; }
interface PersistenceResult { occupancy: number; consecutiveMs: number; consecutiveEvents: number; }
interface DirectionState { phase: DirectionPhase; lastFireMs: number; resetObservedMs?: number; persistence: TimeWeightedPersistence; }

class TimeWeightedPersistence {
  private samples: PersistenceSample[] = [];
  private head = 0;
  private streakStartMs?: number;
  private streakEvents = 0;
  public constructor(private readonly windowMs: number) {}
  public update(nowMs: number, pass: boolean): PersistenceResult {
    const previous = this.samples.at(-1);
    if (!previous || previous.pass !== pass) {
      if (pass) { this.streakStartMs = nowMs; this.streakEvents = 1; }
      else { delete this.streakStartMs; this.streakEvents = 0; }
    } else if (pass) this.streakEvents += 1;
    this.samples.push({ t: nowMs, pass });
    const cutoff = nowMs - this.windowMs;
    while (this.head + 1 < this.samples.length && this.samples[this.head + 1]!.t < cutoff) this.head += 1;
    if (this.head > 2048) { this.samples = this.samples.slice(this.head); this.head = 0; }
    let passDuration = 0, totalDuration = 0;
    for (let index = this.head; index < this.samples.length; index += 1) {
      const sample = this.samples[index]!;
      const nextT = index + 1 < this.samples.length ? this.samples[index + 1]!.t : nowMs;
      const start = Math.max(sample.t, cutoff), end = Math.max(start, Math.min(nextT, nowMs)), duration = end - start;
      totalDuration += duration; if (sample.pass) passDuration += duration;
    }
    return {
      occupancy: clamp(totalDuration > 0 ? passDuration / totalDuration : pass ? 1 : 0, 0, 1),
      consecutiveMs: pass && this.streakStartMs !== undefined ? nowMs - this.streakStartMs : 0,
      consecutiveEvents: pass ? this.streakEvents : 0,
    };
  }
}

export class DeterministicEntryEngine {
  private readonly states = new Map<Direction, DirectionState>();
  private lastEvaluation?: DeterministicEvaluation;
  public constructor(private readonly cfg: DeterministicSignalConfig) {
    validateDeterministicConfig(cfg);
    this.states.set(1, { phase: "IDLE", lastFireMs: Number.NEGATIVE_INFINITY, persistence: new TimeWeightedPersistence(cfg.persistenceWindowMs) });
    this.states.set(-1, { phase: "IDLE", lastFireMs: Number.NEGATIVE_INFINITY, persistence: new TimeWeightedPersistence(cfg.persistenceWindowMs) });
  }

  public evaluate(context: EntryContext): DeterministicTradeIntent | null {
    const longVotes = this.votes(1, context.features), shortVotes = this.votes(-1, context.features);
    const longScore = this.normalizedScore(1, context.features), shortScore = this.normalizedScore(-1, context.features);
    const longAntiChase = this.antiChase(1, context.features, context.bestBid, context.bestAsk);
    const shortAntiChase = this.antiChase(-1, context.features, context.bestBid, context.bestAsk);
    const longArbitrationPass = longScore - shortScore >= this.cfg.arbitrationMargin;
    const shortArbitrationPass = shortScore - longScore >= this.cfg.arbitrationMargin;
    const longRaw = this.directionalPass(1, context.regime, longVotes, longScore, longArbitrationPass);
    const shortRaw = this.directionalPass(-1, context.regime, shortVotes, shortScore, shortArbitrationPass);
    const longPersistence = this.mustState(1).persistence.update(context.nowMs, longRaw);
    const shortPersistence = this.mustState(-1).persistence.update(context.nowMs, shortRaw);
    const long = this.diagnostics(1, context, longScore, shortScore, longVotes, longPersistence, longRaw, longArbitrationPass, longAntiChase);
    const short = this.diagnostics(-1, context, shortScore, longScore, shortVotes, shortPersistence, shortRaw, shortArbitrationPass, shortAntiChase);
    const longCandidate = long.candidatePass, shortCandidate = short.candidatePass;
    let candidate: DeterministicDirectionalCandidate | null = null;
    if (longCandidate !== shortCandidate) {
      const selected = longCandidate ? long : short;
      candidate = this.directionalCandidate(context, selected);
    }
    const longPass = this.commonPass(long);
    const shortPass = this.commonPass(short);
    let intent: DeterministicTradeIntent | null = null;
    if (longPass !== shortPass) {
      const selected = longPass ? long : short;
      intent = {
        source: "DETERMINISTIC", configurationVersion: this.cfg.configurationVersion,
        decisionId: `${context.symbol}:${context.sequence.toString()}:${selected.side}:${context.nowMs}`,
        symbol: context.symbol, sequence: context.sequence, createdMs: context.nowMs, side: selected.side,
        deterministicScore: selected.score, grossOpportunityBps: selected.grossOpportunityBps,
        uncertaintyReserveBps: selected.uncertaintyReserveBps, lowerBoundNetBps: selected.lowerBoundNetBps,
        quality: clamp(selected.lowerBoundNetBps / this.cfg.fullQualityEdgeBps, 0, 1), diagnostics: selected,
      };
    }
    this.lastEvaluation = { long, short, candidate, intent };
    return intent;
  }

  public latestEvaluation(): DeterministicEvaluation | undefined { return this.lastEvaluation; }
  public revalidateExactCost(intent: DeterministicTradeIntent, exactCost: CostEstimate): DeterministicTradeIntent | null {
    const lowerBoundNetBps = intent.grossOpportunityBps - intent.uncertaintyReserveBps - this.cfg.costSafetyFactor * exactCost.roundTripBps;
    if (lowerBoundNetBps < this.cfg.minimumNetEdgeBps) return null;
    return { ...intent, lowerBoundNetBps, quality: clamp(lowerBoundNetBps / this.cfg.fullQualityEdgeBps, 0, 1),
      diagnostics: { ...intent.diagnostics, roundTripCostBps: exactCost.roundTripBps, lowerBoundNetBps, costPass: true,
        reasons: intent.diagnostics.reasons.filter((reason) => reason !== "COST_GATE") } };
  }
  public markFired(side: Direction, nowMs: number): void {
    const state = this.mustState(side); state.phase = "COOLDOWN"; state.lastFireMs = nowMs; delete state.resetObservedMs;
  }
  public signalStillValid(side: Direction, features: DeterministicFeatures, regime: RegimeDecision): boolean {
    const votes = this.votes(side, features), score = this.normalizedScore(side, features);
    return !features.stale && votes.quorum && score > this.cfg.scoreReset && (side === 1 ? regime.allowLong : regime.allowShort);
  }

  private directionalPass(direction: Direction, regime: RegimeDecision, votes: RuleVotes, score: number, arbitrationPass: boolean): boolean {
    return this.regimeAllows(direction, regime) && votes.quorum && score >= this.cfg.scoreEnter && arbitrationPass;
  }
  private commonPass(d: RuleDiagnostics): boolean {
    return d.candidatePass && d.healthPass && d.liquidityPass && d.antiChasePass
      && d.exposurePass && d.cooldownPass && d.costPass;
  }
  private healthPass(system: SystemGateState): boolean {
    return system.bookValid && system.sequenceValid && system.checksumValid && system.publicStreamHealthy && system.privateStreamHealthy
      && system.accountReconciled && system.clockHealthy && system.entriesAllowed;
  }
  private staticLiquidityPass(f: DeterministicFeatures, cost: CostEstimate): boolean {
    return f.warmedUp && !f.stale && f.providerAgeMs >= 0 && f.providerAgeMs <= this.cfg.maximumProviderAgeMs && f.spreadBps <= this.cfg.maximumSpreadBps
      && f.spreadZ <= this.cfg.maximumSpreadZ && f.depthZ >= this.cfg.minimumDepthZ && f.usableDepthNotional >= this.cfg.minimumDepthNotional
      && cost.impactBps <= this.cfg.maximumImpactBps;
  }
  private regimeAllows(direction: Direction, regime: RegimeDecision): boolean { return direction === 1 ? regime.allowLong : regime.allowShort; }
  private votes(direction: Direction, f: DeterministicFeatures): RuleVotes {
    const directionalBreakout = direction === 1 ? f.breakoutUpBps : f.breakoutDownBps;
    const directionalCusum = direction === 1 ? f.cusumUpScore : -f.cusumDownScore;
    const vector: RuleVoteVector = {
      micro: direction * f.microEdgeBps >= this.cfg.microEdgeBps, qi1: direction * f.qi1 >= this.cfg.qi1,
      qiK: direction * f.qiK >= this.cfg.qiK, ofi: direction * f.ofi >= this.cfg.ofi, tfi: direction * f.tfi >= this.cfg.tfi,
      replenishment: direction * f.replenishmentPressure >= this.cfg.replenishment,
      velocity: direction * f.velocityZ >= this.cfg.velocityZ,
      acceleration: direction * f.accelerationZ >= -this.cfg.maximumOpposingAccelerationZ,
      impulse: direction * f.impulseBps >= this.cfg.impulseBps, breakout: directionalBreakout >= this.cfg.breakoutBps,
      cusum: directionalCusum >= this.cfg.cusum,
    };
    const book = Number(vector.micro) + Number(vector.qi1) + Number(vector.qiK);
    const flow = Number(vector.ofi) + Number(vector.tfi) + Number(vector.replenishment);
    const kinematic = Number(vector.velocity) + Number(vector.acceleration) + Number(vector.impulse) + Number(vector.breakout) + Number(vector.cusum);
    const quality = f.efficiency >= this.cfg.efficiency && f.flowFlipRate <= this.cfg.maximumFlipRate;
    return { book, flow, kinematic, quality, quorum: book >= this.cfg.minimumBookVotes && flow >= this.cfg.minimumFlowVotes
      && kinematic >= this.cfg.minimumKinematicVotes && quality, vector };
  }
  private normalizedScore(direction: Direction, f: DeterministicFeatures): number {
    const directionalCusum = direction === 1 ? f.cusumUpScore : -f.cusumDownScore;
    return clamp(weightedAverage([
      term(direction * f.microEdgeBps / this.cfg.microEdgeBps, this.cfg.scoreWeights.micro),
      term(direction * f.qi1 / this.cfg.qi1, this.cfg.scoreWeights.qi1), term(direction * f.qiK / this.cfg.qiK, this.cfg.scoreWeights.qiK),
      term(direction * f.ofi / this.cfg.ofi, this.cfg.scoreWeights.ofi), term(direction * f.tfi / this.cfg.tfi, this.cfg.scoreWeights.tfi),
      term(direction * f.replenishmentPressure / this.cfg.replenishment, this.cfg.scoreWeights.replenishment),
      term(direction * f.velocityZ / this.cfg.velocityZ, this.cfg.scoreWeights.velocity),
      term(direction * f.accelerationZ, this.cfg.scoreWeights.acceleration), term(direction * f.impulseBps / this.cfg.impulseBps, this.cfg.scoreWeights.impulse),
      term(directionalCusum / this.cfg.cusum, this.cfg.scoreWeights.cusum),
      term((f.efficiency - this.cfg.efficiency) / Math.max(1 - this.cfg.efficiency, 1e-9), this.cfg.scoreWeights.efficiency),
      { value: 1 - 2 * clamp(f.flowFlipRate / this.cfg.maximumFlipRate, 0, 1), weight: this.cfg.scoreWeights.flipQuality },
    ]), -1, 1);
  }
  private opportunity(direction: Direction, f: DeterministicFeatures, score: number, persistence: number, expectedLatencyMs: number): { grossBps: number; uncertaintyBps: number } {
    const effectiveLatencyMs = Number.isFinite(expectedLatencyMs) && expectedLatencyMs >= 0 ? expectedLatencyMs : this.cfg.expectedLatencyMs;
    const horizonSec = (effectiveLatencyMs + this.cfg.holdHorizonMs) / 1_000;
    const latencySec = effectiveLatencyMs / 1_000;
    const sigmaHBps = 10_000 * Math.sqrt(Math.max(f.varianceRate * horizonSec, 1e-16));
    const sigmaLatencyBps = 10_000 * Math.sqrt(Math.max(f.varianceRate * latencySec, 1e-16));
    const micro = Math.max(0, direction * f.microEdgeBps);
    const kinematic = clamp(10_000 * direction * (f.velocity * horizonSec + .5 * f.acceleration * horizonSec * horizonSec), 0, this.cfg.kinematicSigmaCap * sigmaHBps);
    const flowStrength = clamp((direction * f.ofi / this.cfg.ofi + direction * f.tfi / this.cfg.tfi + direction * f.qiK / this.cfg.qiK) / 3, 0, 1);
    const flow = this.cfg.flowSigmaScale * sigmaHBps * flowStrength;
    const impulse = clamp(direction * f.impulseBps, 0, this.cfg.impulseSigmaCap * sigmaHBps);
    const raw = weightedAverage([
      { value: micro, weight: this.cfg.opportunityWeights.micro }, { value: kinematic, weight: this.cfg.opportunityWeights.kinematic },
      { value: flow, weight: this.cfg.opportunityWeights.flow }, { value: impulse, weight: this.cfg.opportunityWeights.impulse },
    ]);
    const scoreQuality = clamp((score - this.cfg.scoreReset) / Math.max(1 - this.cfg.scoreReset, 1e-9), 0, 1);
    const quality = Math.pow(clamp(f.efficiency, 0, 1), this.cfg.efficiencyExponent)
      * Math.pow(clamp(persistence, 0, 1), this.cfg.persistenceExponent) * scoreQuality;
    const latencyDecay = Math.exp(-effectiveLatencyMs / Math.max(this.cfg.ruleDecayTauMs, 1));
    const grossBps = latencyDecay * quality * Math.min(this.cfg.totalSigmaCap * sigmaHBps, raw);
    const disagreement = medianAbsoluteDeviation([micro, kinematic, flow, impulse]);
    const uncertaintyBps = this.cfg.disagreementPenalty * disagreement + this.cfg.latencyVolatilityPenalty * sigmaLatencyBps
      + this.cfg.spreadStressPenaltyBps * Math.max(0, f.spreadZ) + this.cfg.flipPenaltyBps * f.flowFlipRate
      + this.cfg.opposingAccelerationPenaltyBps * Math.max(0, -direction * f.accelerationZ);
    return { grossBps, uncertaintyBps };
  }
  private antiChase(direction: Direction, f: DeterministicFeatures, bestBid: number, bestAsk: number): { pass: boolean; chaseBps: number; impulseZ: number; anchorZ: number } {
    const chaseBps = direction === 1 ? 10_000 * (bestAsk - f.microprice) / f.mid : 10_000 * (f.microprice - bestBid) / f.mid;
    const impulseZ = direction * f.impulseBps / Math.max(f.sigmaImpulseBps, 1e-6);
    const anchorZ = direction * f.anchorDistanceBps / Math.max(f.sigmaHBps, 1e-6);
    return { pass: chaseBps <= this.cfg.maximumChaseBps && impulseZ <= this.cfg.maximumImpulseZ && anchorZ <= this.cfg.maximumAnchorZ,
      chaseBps, impulseZ, anchorZ };
  }
  private updatePhase(direction: Direction, nowMs: number, rawPass: boolean, score: number): { cooldownPass: boolean; phase: DirectionPhase } {
    const state = this.mustState(direction), resetCondition = !rawPass || score <= this.cfg.scoreReset;
    if (resetCondition) state.resetObservedMs ??= nowMs; else delete state.resetObservedMs;
    if (state.phase === "COOLDOWN") {
      const cooldownElapsed = nowMs - state.lastFireMs >= this.cfg.cooldownMs;
      const resetElapsed = state.resetObservedMs !== undefined && nowMs - state.resetObservedMs >= this.cfg.resetMs;
      if (cooldownElapsed && resetElapsed) state.phase = "IDLE";
    }
    if (state.phase === "IDLE" && rawPass) state.phase = "ARMED";
    if (state.phase === "ARMED" && resetCondition) state.phase = "IDLE";
    return { cooldownPass: state.phase === "ARMED", phase: state.phase };
  }
  private diagnostics(direction: Direction, context: EntryContext, score: number, oppositeScore: number, votes: RuleVotes,
    persistence: PersistenceResult, rawDirectionalPass: boolean, arbitrationPass: boolean,
    antiChase: { pass: boolean; chaseBps: number; impulseZ: number; anchorZ: number }): RuleDiagnostics {
    const f = context.features, cost = direction === 1 ? context.longCost : context.shortCost;
    const dynamicLiquidity = direction === 1 ? context.longLiquidity : context.shortLiquidity;
    const healthPass = this.healthPass(context.system);
    const liquidityPass = dynamicLiquidity?.pass ?? this.staticLiquidityPass(f, cost);
    const regimePass = this.regimeAllows(direction, context.regime);
    const phase = this.updatePhase(direction, context.nowMs, rawDirectionalPass, score);
    const opportunity = this.opportunity(direction, f, score, persistence.occupancy, context.expectedLatencyMs);
    const lowerBoundNetBps = opportunity.grossBps - opportunity.uncertaintyBps - this.cfg.costSafetyFactor * cost.roundTripBps;
    const exposurePass = context.system.noExistingPosition && context.system.noPendingEntry;
    const persistencePass = persistence.occupancy >= this.cfg.minimumPersistence && persistence.consecutiveMs >= this.cfg.minimumConfirmationMs
      && persistence.consecutiveEvents >= this.cfg.minimumConfirmationEvents;
    const scorePass = score >= this.cfg.scoreEnter;
    const candidatePass = rawDirectionalPass && persistencePass;
    const costPass = lowerBoundNetBps >= this.cfg.minimumNetEdgeBps;
    const reasons: string[] = [];
    if (!healthPass) reasons.push("HEALTH_GATE"); if (!liquidityPass) reasons.push("LIQUIDITY_GATE"); if (!regimePass) reasons.push("REGIME_GATE");
    if (!votes.quorum) reasons.push("RULE_QUORUM"); if (!scorePass) reasons.push("SCORE_GATE"); if (!persistencePass) reasons.push("PERSISTENCE_GATE");
    if (!antiChase.pass) reasons.push("ANTI_CHASE_GATE"); if (!exposurePass) reasons.push("EXPOSURE_GATE");
    if (!phase.cooldownPass) reasons.push("COOLDOWN_OR_RESET_GATE"); if (!costPass) reasons.push("COST_GATE"); if (!arbitrationPass) reasons.push("ARBITRATION_GATE");
    return { side: direction, phase: phase.phase, score, oppositeScore, scoreMargin: score - oppositeScore, votes,
      persistence: persistence.occupancy, confirmationMs: persistence.consecutiveMs, confirmationEvents: persistence.consecutiveEvents,
      grossOpportunityBps: opportunity.grossBps, uncertaintyReserveBps: opportunity.uncertaintyBps, roundTripCostBps: cost.roundTripBps,
      lowerBoundNetBps, chaseBps: antiChase.chaseBps, impulseZ: antiChase.impulseZ, anchorZ: antiChase.anchorZ,
      scorePass, rawDirectionalPass, candidatePass, healthPass, liquidityPass, regimePass, persistencePass,
      antiChasePass: antiChase.pass, exposurePass, cooldownPass: phase.cooldownPass, costPass, arbitrationPass,
      liquidityReasons: dynamicLiquidity?.reasons ?? (liquidityPass ? [] : ["STATIC_LIQUIDITY_LIMIT"]),
      tradeThresholdBps: dynamicLiquidity?.tradeThresholdBps ?? this.cfg.maximumSpreadBps,
      stressThresholdBps: dynamicLiquidity?.stressThresholdBps ?? this.cfg.maximumSpreadBps,
      reasons };
  }
  private directionalCandidate(context: EntryContext, selected: RuleDiagnostics): DeterministicDirectionalCandidate {
    return {
      source: "DETERMINISTIC", configurationVersion: this.cfg.configurationVersion,
      decisionId: `${context.symbol}:${context.sequence.toString()}:${selected.side}:${context.nowMs}`,
      symbol: context.symbol, sequence: context.sequence, createdMs: context.nowMs,
      side: selected.side, deterministicScore: selected.score, diagnostics: selected,
    };
  }
  private mustState(side: Direction): DirectionState { const state = this.states.get(side); if (!state) throw new Error("Missing deterministic direction state"); return state; }
}

export function validateDeterministicConfig(cfg: DeterministicSignalConfig): void {
  const fail = (message: string): never => { throw new Error(`Invalid deterministic configuration: ${message}`); };
  if (!cfg.configurationVersion) fail("configurationVersion is required");
  if (!["DETERMINISTIC_ONLY", "DETERMINISTIC_WITH_MODEL_VETO", "DETERMINISTIC_WITH_MODEL_RANKING"].includes(cfg.mode)) fail("unknown signal mode");
  const finite = flattenNumbers(cfg);
  if (finite.some((value) => !Number.isFinite(value))) fail("all numeric configuration values must be finite");
  if (!(cfg.scoreEnter > cfg.scoreReset)) fail("scoreEnter must be greater than scoreReset");
  if (cfg.scoreEnter < -1 || cfg.scoreEnter > 1 || cfg.scoreReset < -1 || cfg.scoreReset > 1) fail("score thresholds must be in [-1,1]");
  if (cfg.arbitrationMargin < 0 || cfg.arbitrationMargin > 2) fail("arbitrationMargin must be in [0,2]");
  if (cfg.minimumPersistence < 0 || cfg.minimumPersistence > 1) fail("minimumPersistence must be in [0,1]");
  if (cfg.efficiency < 0 || cfg.efficiency > 1 || cfg.maximumFlipRate <= 0 || cfg.maximumFlipRate > 1) fail("quality thresholds must be in [0,1]");
  if (!(cfg.costSafetyFactor >= 1)) fail("costSafetyFactor must be at least 1");
  if (!(cfg.minimumConfirmationMs >= 0) || !(cfg.cooldownMs >= cfg.minimumConfirmationMs)) fail("cooldown must cover confirmation time");
  if (!Number.isInteger(cfg.minimumConfirmationEvents) || cfg.minimumConfirmationEvents < 1) fail("minimumConfirmationEvents must be a positive integer");
  for (const [value, maximum, name] of [[cfg.minimumBookVotes, 3, "minimumBookVotes"], [cfg.minimumFlowVotes, 3, "minimumFlowVotes"], [cfg.minimumKinematicVotes, 5, "minimumKinematicVotes"]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`${name} is outside its evidence group`);
  }
  const opportunityWeights = Object.values(cfg.opportunityWeights);
  if (opportunityWeights.some((value) => value < 0) || Math.abs(opportunityWeights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) fail("opportunity weights must be nonnegative and sum to 1");
  const scoreWeights = Object.values(cfg.scoreWeights);
  if (scoreWeights.some((value) => value < 0) || !(scoreWeights.reduce((sum, value) => sum + value, 0) > 0)) fail("score weights must be nonnegative with positive total");
  const positive = [cfg.maximumProviderAgeMs, cfg.maximumSpreadBps, cfg.minimumDepthNotional, cfg.microEdgeBps, cfg.qi1, cfg.qiK,
    cfg.ofi, cfg.tfi, cfg.replenishment, cfg.velocityZ, cfg.efficiency, cfg.persistenceWindowMs, cfg.fullQualityEdgeBps];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)) fail("positive thresholds must be finite and positive");
  const nonnegative = [cfg.maximumSpreadZ, cfg.maximumImpactBps, cfg.maximumOpposingAccelerationZ, cfg.impulseBps, cfg.breakoutBps,
    cfg.cusum, cfg.minimumConfirmationMs, cfg.cooldownMs, cfg.resetMs, cfg.maximumImpulseZ, cfg.maximumChaseBps, cfg.maximumAnchorZ,
    cfg.expectedLatencyMs, cfg.holdHorizonMs, cfg.ruleDecayTauMs, cfg.kinematicSigmaCap, cfg.flowSigmaScale, cfg.impulseSigmaCap,
    cfg.totalSigmaCap, cfg.efficiencyExponent, cfg.persistenceExponent, cfg.disagreementPenalty, cfg.latencyVolatilityPenalty,
    cfg.spreadStressPenaltyBps, cfg.flipPenaltyBps, cfg.opposingAccelerationPenaltyBps];
  if (nonnegative.some((value) => value < 0)) fail("nonnegative thresholds cannot be negative");
}

function term(value: number, weight: number): { value: number; weight: number } { return { value: clamp(value, -1, 1), weight }; }
function weightedAverage(terms: ReadonlyArray<{ value: number; weight: number }>): number {
  let numerator = 0, denominator = 0;
  for (const item of terms) if (item.weight > 0) { numerator += item.value * item.weight; denominator += item.weight; }
  return denominator > 0 ? numerator / denominator : 0;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return 0; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function medianAbsoluteDeviation(values: readonly number[]): number { const center = median(values); return median(values.map((value) => Math.abs(value - center))); }
function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") return [value]; if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(flattenNumbers);
}
