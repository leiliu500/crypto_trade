import { clamp } from "../core/market.js";
import type {
  Direction, SideTriggerDiagnostics, SmallFractionCandidate, SmallFractionFeatures,
  SmallFractionTriggerConfig, SmallFractionTriggerResult,
} from "./micro-fraction-types.js";
import { squash } from "./micro-fraction-types.js";
import { TimeEwmaSquare } from "./time-ewma-square.js";

interface DirectionState {
  lastMs?: number;
  occupancy: number;
  evidence: number;
  armed: boolean;
  firedInEpisode: boolean;
  firstSupportMs?: number;
  anchorMid?: number;
  consecutiveEvents: number;
  cooldownUntilMs: number;
}

interface SideInput {
  side: Direction;
  nowMs: number;
  mid: number;
  signedScore: number;
  microPressure: number;
  deltaMicroBps: number;
  sensorThresholdBps: number;
  microNoiseBps: number;
  features: SmallFractionFeatures;
}

/** Detects persistent, directionally coherent micro-moves without weakening downstream order gates. */
export class SmallFractionEntryTrigger {
  private previousMicroprice?: number;
  private readonly microNoise: TimeEwmaSquare;
  private readonly states = new Map<Direction, DirectionState>([
    [1, freshState()], [-1, freshState()],
  ]);

  public constructor(private readonly cfg: SmallFractionTriggerConfig) {
    validateSmallFractionTriggerConfig(cfg);
    this.microNoise = new TimeEwmaSquare(cfg.noiseTauMs);
  }

  public update(f: SmallFractionFeatures): SmallFractionTriggerResult {
    if (!f.bookReady || f.stale || !(f.bestBid < f.bestAsk) || !(f.mid > 0) || !(f.microprice > 0)) {
      return { long: invalidDiagnostics(1, "MARKET_STATE_INVALID"), short: invalidDiagnostics(-1, "MARKET_STATE_INVALID"), candidate: null };
    }
    const halfSpread = (f.bestAsk - f.bestBid) / 2;
    const microPressure = clamp((f.microprice - f.mid) / Math.max(halfSpread, 1e-12), -1, 1);
    const deltaMicroBps = this.previousMicroprice === undefined ? 0 : 10_000 * Math.log(f.microprice / this.previousMicroprice);
    // The current decision only sees the noise estimate from prior events.
    const microNoiseBps = this.microNoise.rms();
    const sensorThresholdBps = Math.max(this.cfg.minimumMicroMoveBps, this.cfg.noiseMovementMultiplier * microNoiseBps);
    const signedBreakoutBps = f.breakoutUpBps - f.breakoutDownBps;
    const signedScore =
      this.cfg.microWeight * squash(microPressure, this.cfg.microPressureScale)
      + this.cfg.qiKWeight * squash(f.qiK, this.cfg.qiKScale)
      + this.cfg.ofiWeight * squash(f.ofi, this.cfg.ofiScale)
      + this.cfg.tfiWeight * squash(f.tfi, this.cfg.tfiScale)
      + this.cfg.replenishmentWeight * squash(f.replenishmentPressure, this.cfg.replenishmentScale)
      + this.cfg.velocityWeight * squash(f.velocityZ, this.cfg.velocityScale)
      + this.cfg.breakoutWeight * squash(signedBreakoutBps, this.cfg.breakoutScaleBps);
    const shared = { nowMs: f.nowMs, mid: f.mid, signedScore, microPressure, deltaMicroBps, sensorThresholdBps, microNoiseBps, features: f };
    const long = this.evaluateSide({ ...shared, side: 1 });
    const short = this.evaluateSide({ ...shared, side: -1 });
    this.microNoise.update(deltaMicroBps, f.nowMs);
    this.previousMicroprice = f.microprice;
    return { long, short, candidate: this.arbitrate(f.symbol, f.nowMs, long, short) };
  }

  private evaluateSide(input: SideInput): SideTriggerDiagnostics {
    const { side, nowMs, mid, features: f } = input;
    const state = this.mustState(side);
    const score = side * input.signedScore;
    const bookPass = side * input.microPressure >= this.cfg.minimumMicroPressure || side * f.qiK >= this.cfg.minimumQiK;
    const flowPass = side * f.ofi >= this.cfg.minimumOfi || side * f.tfi >= this.cfg.minimumTfi
      || side * f.replenishmentPressure >= this.cfg.minimumReplenishment;
    const directionalBreakoutBps = side === 1 ? f.breakoutUpBps : f.breakoutDownBps;
    const directionalCusum = side === 1 ? f.cusumUp : -f.cusumDown;
    const motionPass = side * input.deltaMicroBps >= input.sensorThresholdBps || side * f.velocityZ >= this.cfg.minimumVelocityZ
      || directionalBreakoutBps >= this.cfg.minimumBreakoutBps || directionalCusum >= this.cfg.minimumCusum;
    const groupCount = Number(bookPass) + Number(flowPass) + Number(motionPass);
    const groupQuorum = groupCount >= 2 && motionPass;
    const rawGapMs = state.lastMs === undefined ? 0 : nowMs - state.lastMs;
    const eventGapExceeded = state.lastMs !== undefined && (rawGapMs < 0 || rawGapMs > this.cfg.maximumEventGapMs);
    const dtMs = state.lastMs === undefined || eventGapExceeded ? 0 : clamp(rawGapMs, 0, this.cfg.maximumEventGapMs);
    const dtSeconds = dtMs / 1_000;
    state.lastMs = nowMs;
    if (eventGapExceeded) this.resetEpisode(state);

    const support = groupQuorum && score >= this.cfg.armScore;
    const occupancyDecay = Math.exp(-dtMs / this.cfg.occupancyTauMs);
    state.occupancy = occupancyDecay * state.occupancy + (1 - occupancyDecay) * Number(support);
    const evidenceDecay = Math.exp(-dtMs / this.cfg.evidenceTauMs);
    const evidenceIncrement = score - this.cfg.evidenceDriftAllowance
      - this.cfg.opposingEvidencePenalty * Math.max(0, -score);
    state.evidence = Math.max(0, evidenceDecay * state.evidence + dtSeconds * evidenceIncrement);

    if (support) {
      if (!state.armed) {
        state.armed = true;
        state.firedInEpisode = false;
        state.firstSupportMs = nowMs;
        state.anchorMid = mid;
        state.consecutiveEvents = 1;
      } else state.consecutiveEvents += 1;
    } else if (score <= this.cfg.releaseScore) this.resetEpisode(state);

    const confirmationMs = state.firstSupportMs === undefined ? 0 : nowMs - state.firstSupportMs;
    const chaseBps = state.anchorMid === undefined ? 0 : 10_000 * side * Math.log(mid / state.anchorMid);
    const strong = score >= this.cfg.strongScore;
    const requiredTimeMs = strong ? this.cfg.strongConfirmationMs : this.cfg.minimumConfirmationMs;
    const requiredEvents = strong ? this.cfg.strongConfirmationEvents : this.cfg.minimumConfirmationEvents;
    const reasons: string[] = [];
    if (!bookPass) reasons.push("BOOK_GROUP_FALSE");
    if (!flowPass) reasons.push("FLOW_GROUP_FALSE");
    if (!motionPass) reasons.push("MOTION_GROUP_FALSE");
    if (!groupQuorum) reasons.push("GROUP_QUORUM_FALSE");
    if (score < this.cfg.armScore) reasons.push("ARM_SCORE_FALSE");
    if (state.occupancy < this.cfg.minimumOccupancy) reasons.push("OCCUPANCY_FALSE");
    if (state.evidence < this.cfg.fireEvidenceScoreSeconds) reasons.push("EVIDENCE_FALSE");
    if (confirmationMs < requiredTimeMs) reasons.push("CONFIRMATION_TIME_FALSE");
    if (state.consecutiveEvents < requiredEvents) reasons.push("CONFIRMATION_EVENTS_FALSE");
    if (chaseBps > this.cfg.maximumChaseBps) reasons.push("MAXIMUM_CHASE_EXCEEDED");
    if (nowMs < state.cooldownUntilMs) reasons.push("COOLDOWN_ACTIVE");
    if (state.firedInEpisode) reasons.push("ALREADY_FIRED_IN_EPISODE");
    if (eventGapExceeded) reasons.push("EVENT_GAP_RESET");
    const fire = state.armed && !state.firedInEpisode && groupQuorum && score >= this.cfg.armScore
      && state.occupancy >= this.cfg.minimumOccupancy && state.evidence >= this.cfg.fireEvidenceScoreSeconds
      && confirmationMs >= requiredTimeMs && state.consecutiveEvents >= requiredEvents
      && chaseBps <= this.cfg.maximumChaseBps && nowMs >= state.cooldownUntilMs;
    return {
      side, score, microPressure: input.microPressure, bookPass, flowPass, motionPass, groupCount, groupQuorum,
      sensorThresholdBps: input.sensorThresholdBps, deltaMicroBps: input.deltaMicroBps, microNoiseBps: input.microNoiseBps,
      occupancy: state.occupancy, evidence: state.evidence, confirmationMs, consecutiveEvents: state.consecutiveEvents,
      chaseBps, armed: state.armed, strong, fire, reasons,
    };
  }

  private arbitrate(symbol: string, nowMs: number, long: SideTriggerDiagnostics, short: SideTriggerDiagnostics): SmallFractionCandidate | null {
    let selected: SideTriggerDiagnostics | undefined;
    if (long.fire && !short.fire) selected = long;
    else if (short.fire && !long.fire) selected = short;
    else if (long.fire && short.fire) {
      if (Math.abs(long.score - short.score) < this.cfg.arbitrationMargin) return null;
      selected = long.score > short.score ? long : short;
    }
    if (!selected) return null;
    const state = this.mustState(selected.side);
    state.firedInEpisode = true;
    state.cooldownUntilMs = nowMs + this.cfg.cooldownMs;
    return {
      source: "DETERMINISTIC_MICRO", symbol, side: selected.side, createdMs: nowMs, score: selected.score,
      occupancy: selected.occupancy, evidence: selected.evidence, confirmationMs: selected.confirmationMs,
      consecutiveEvents: selected.consecutiveEvents, deltaMicroBps: selected.deltaMicroBps,
      sensorThresholdBps: selected.sensorThresholdBps, chaseBps: selected.chaseBps,
    };
  }

  private resetEpisode(state: DirectionState): void {
    state.occupancy = 0;
    state.evidence = 0;
    state.armed = false;
    state.firedInEpisode = false;
    delete state.firstSupportMs;
    delete state.anchorMid;
    state.consecutiveEvents = 0;
  }

  private mustState(side: Direction): DirectionState {
    const state = this.states.get(side);
    if (!state) throw new Error(`Missing micro-trigger state for side ${side}`);
    return state;
  }
}

function freshState(): DirectionState {
  return { occupancy: 0, evidence: 0, armed: false, firedInEpisode: false, consecutiveEvents: 0, cooldownUntilMs: 0 };
}

function invalidDiagnostics(side: Direction, reason: string): SideTriggerDiagnostics {
  return {
    side, score: 0, microPressure: 0, bookPass: false, flowPass: false, motionPass: false,
    groupCount: 0, groupQuorum: false, sensorThresholdBps: 0, deltaMicroBps: 0, microNoiseBps: 0,
    occupancy: 0, evidence: 0, confirmationMs: 0, consecutiveEvents: 0, chaseBps: 0,
    armed: false, strong: false, fire: false, reasons: [reason],
  };
}

export function validateSmallFractionTriggerConfig(cfg: SmallFractionTriggerConfig): void {
  const values = Object.values(cfg);
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Micro-trigger configuration values must be finite");
  const total = cfg.microWeight + cfg.qiKWeight + cfg.ofiWeight + cfg.tfiWeight
    + cfg.replenishmentWeight + cfg.velocityWeight + cfg.breakoutWeight;
  const weights = [cfg.microWeight, cfg.qiKWeight, cfg.ofiWeight, cfg.tfiWeight,
    cfg.replenishmentWeight, cfg.velocityWeight, cfg.breakoutWeight];
  if (weights.some((value) => value < 0)) throw new Error("Micro-trigger weights cannot be negative");
  if (Math.abs(total - 1) > 1e-6) throw new Error(`Micro-trigger weights must sum to 1; received ${total}`);
  if (!(cfg.releaseScore < cfg.armScore && cfg.armScore < cfg.strongScore)) {
    throw new Error("Micro trigger requires releaseScore < armScore < strongScore");
  }
  if (cfg.releaseScore < -1 || cfg.strongScore > 1 || cfg.arbitrationMargin > 2) {
    throw new Error("Micro-trigger scores must remain inside their bounded score range");
  }
  if (cfg.minimumOccupancy < 0 || cfg.minimumOccupancy > 1) throw new Error("Micro-trigger occupancy must be in [0,1]");
  const positive = [cfg.noiseTauMs, cfg.microPressureScale, cfg.qiKScale, cfg.ofiScale, cfg.tfiScale,
    cfg.replenishmentScale, cfg.velocityScale, cfg.breakoutScaleBps, cfg.evidenceTauMs, cfg.occupancyTauMs,
    cfg.minimumConfirmationEvents, cfg.strongConfirmationEvents, cfg.maximumEventGapMs];
  if (positive.some((value) => value <= 0)) throw new Error("Micro-trigger scales, taus, event counts, and maximum gap must be positive");
  if (!Number.isInteger(cfg.minimumConfirmationEvents) || !Number.isInteger(cfg.strongConfirmationEvents)) {
    throw new Error("Micro-trigger confirmation event counts must be integers");
  }
  const nonnegative = [cfg.minimumMicroPressure, cfg.minimumQiK, cfg.minimumOfi, cfg.minimumTfi, cfg.minimumReplenishment,
    cfg.minimumVelocityZ, cfg.minimumBreakoutBps, cfg.minimumCusum, cfg.minimumMicroMoveBps, cfg.noiseMovementMultiplier,
    cfg.evidenceDriftAllowance, cfg.opposingEvidencePenalty, cfg.fireEvidenceScoreSeconds, cfg.minimumConfirmationMs,
    cfg.strongConfirmationMs, cfg.maximumChaseBps, cfg.arbitrationMargin, cfg.cooldownMs];
  if (nonnegative.some((value) => value < 0)) throw new Error("Micro-trigger nonnegative thresholds cannot be negative");
}
