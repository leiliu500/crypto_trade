import type { Direction, Features } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { EntryFamily, ExecutionPath } from "../economics/types.js";

export type PositionPhase = "OPEN" | "RECOVERY" | "PROTECTED" | "TREND_HOLD" | "EXITING";
export interface Position {
  symbol: string;
  side: Direction;
  qty: number;
  entryPx: number;
  openedMs: number;
  initialRiskPx: number;
  roundTripCostPx: number;
  mfePx: number;
  maePx: number;
  floorPx: number;
  breakEvenArmed: boolean;
  phase: PositionPhase;
  entryFamily?: EntryFamily;
  selectedHorizonMs?: number;
  executionPath?: ExecutionPath;
  adverseEvidenceSinceMs?: number;
  lastReductionProbability?: number;
}
export interface PositionConfig {
  recoveryArmR: number;
  trailActivationR: number;
  minimumProgressR: number;
  minimumHoldMs: number;
  unproductiveExitMs: number;
  maximumHoldMs: number;
  reentryCooldownMs: number;
  makerExitTtlMs: number;
  evidenceConfirmationMs: number;
  profitActivationCostMultiple: number;
  lockMin: number;
  lockMax: number;
  lockMaturityRate: number;
  lockReversalWeight: number;
  lockTrendDiscount: number;
  baseVolatilityMultiple: number;
  trendVolatilityBonus: number;
  reversalVolatilityPenalty: number;
  minimumVolatilityMultiple: number;
  maximumVolatilityMultiple: number;
  partialExitThreshold: number;
  maximumPartialExitFraction: number;
  minimumPartialExitBenefitBps: number;
}
export type PositionDecision =
  | { action: "HOLD"; floorPx: number; stopPx: number; signedMovePx: number }
  | { action: "REDUCE"; fraction: number; reason: string; floorPx: number }
  | { action: "EXIT"; reason: string };

export class PositionManager {
  public constructor(private readonly cfg: PositionConfig) {}
  public update(p: Position, executableExitPx: number, nowMs: number, f: Features, holdLowerBoundBps: number,
    reversalProbability: number, reductionBenefitBps = 0, holdExitEvidence?: boolean): PositionDecision {
    const u = p.side * (executableExitPx - p.entryPx);
    const risk = p.initialRiskPx;
    if (!(risk > 0)) return { action: "EXIT", reason: "INVALID_INITIAL_RISK" };
    p.mfePx = Math.max(p.mfePx, u);
    p.maePx = Math.max(p.maePx, -u);
    if (f.stale) { p.phase = "EXITING"; return { action: "EXIT", reason: "DATA_INVALID" }; }
    if (u <= -risk) { p.phase = "EXITING"; return { action: "EXIT", reason: "HARD_STOP" }; }
    const elapsedMs = nowMs - p.openedMs;
    const hasRecovered = p.maePx >= this.cfg.recoveryArmR * risk && u >= p.roundTripCostPx;
    if (hasRecovered && !p.breakEvenArmed) {
      p.phase = "RECOVERY";
      if (holdLowerBoundBps <= 0) { p.phase = "EXITING"; return { action: "EXIT", reason: "RECOVERY_NO_EDGE" }; }
      p.breakEvenArmed = true;
    }
    const costBasedActivation = p.roundTripCostPx > 0
      ? this.cfg.profitActivationCostMultiple * p.roundTripCostPx : 0;
    const breakEvenActivationPx = Math.max(this.cfg.minimumProgressR * risk, costBasedActivation);
    if (p.mfePx >= breakEvenActivationPx) p.breakEvenArmed = true;
    // Require both a meaningful fraction of initial risk and sufficient cost
    // coverage before trailing. The old min() activated at one cost unit and
    // repeatedly converted valid trends into tiny winners.
    const protectionActivationPx = Math.max(this.cfg.trailActivationR * risk, costBasedActivation);
    const protectedTrade = p.mfePx >= protectionActivationPx;
    let candidateFloor = -risk;
    if (p.breakEvenArmed) {
      // Once a move has cleared both the risk-progress and cost-coverage
      // thresholds, retain a small part of the maximum net profit even before
      // the full volatility trail activates. This prevents a legitimate
      // winner from reverting all the way to break-even while preserving most
      // of its room to trend.
      const earlyProfitFloor = p.roundTripCostPx
        + this.cfg.lockMin * Math.max(0, p.mfePx - p.roundTripCostPx);
      candidateFloor = Math.max(candidateFloor, earlyProfitFloor);
    }
    if (protectedTrade) {
      p.phase = f.efficiency >= .65 && holdLowerBoundBps > 0 ? "TREND_HOLD" : "PROTECTED";
      const maturity = 1 - Math.exp(-this.cfg.lockMaturityRate * Math.max(0, p.mfePx / risk - this.cfg.trailActivationR));
      const lockFraction = clamp(
        this.cfg.lockMin + (this.cfg.lockMax - this.cfg.lockMin) * maturity
          + this.cfg.lockReversalWeight * reversalProbability - this.cfg.lockTrendDiscount * f.efficiency,
        this.cfg.lockMin, this.cfg.lockMax,
      );
      const profitLockFloor = p.roundTripCostPx + lockFraction * Math.max(0, p.mfePx - p.roundTripCostPx);
      const volatilityMultiple = clamp(
        this.cfg.baseVolatilityMultiple + this.cfg.trendVolatilityBonus * f.efficiency - this.cfg.reversalVolatilityPenalty * reversalProbability,
        this.cfg.minimumVolatilityMultiple, this.cfg.maximumVolatilityMultiple,
      );
      const volatilityFloor = p.mfePx - volatilityMultiple * executableExitPx * f.sigmaHBps / 10_000;
      candidateFloor = Math.max(candidateFloor, profitLockFloor, volatilityFloor);
    }
    const previousFloor = p.floorPx;
    p.floorPx = Math.max(p.floorPx, candidateFloor);
    if (p.floorPx < previousFloor) throw new Error("PROFIT_FLOOR_LOOSENED");
    if (u <= p.floorPx) { p.phase = "EXITING"; return { action: "EXIT", reason: "PROFIT_FLOOR" }; }

    const meaningfulProgressPx = p.roundTripCostPx > 0
      ? p.roundTripCostPx : this.cfg.minimumProgressR * risk;
    if (elapsedMs >= this.cfg.minimumHoldMs && p.mfePx < meaningfulProgressPx
      && u <= -this.cfg.minimumProgressR * risk) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "EARLY_ADVERSE_STOP" };
    }
    if (elapsedMs >= this.cfg.unproductiveExitMs && p.mfePx < meaningfulProgressPx) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "UNPRODUCTIVE_TIME_STOP" };
    }

    // The hold engine intentionally combines weak continuation, reversal
    // quorum, and negative incremental edge with OR semantics. Requiring a
    // negative LCB and a reversal quorum here discarded most valid exits.
    const adverseEvidence = holdExitEvidence ?? (holdLowerBoundBps <= 0 || reversalProbability >= .55);
    if (adverseEvidence) {
      p.adverseEvidenceSinceMs ??= nowMs;
      if (elapsedMs >= this.cfg.minimumHoldMs && nowMs - p.adverseEvidenceSinceMs >= this.cfg.evidenceConfirmationMs) {
        p.phase = "EXITING"; return { action: "EXIT", reason: "EVIDENCE_EXIT" };
      }
    } else delete p.adverseEvidenceSinceMs;
    const maximumHoldMs = Math.min(this.cfg.maximumHoldMs, p.selectedHorizonMs ?? this.cfg.maximumHoldMs);
    if (elapsedMs >= maximumHoldMs && p.mfePx < this.cfg.minimumProgressR * risk) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "TIME_STOP" };
    }
    if (protectedTrade && reversalProbability > this.cfg.partialExitThreshold
      && reductionBenefitBps >= this.cfg.minimumPartialExitBenefitBps
      && reversalProbability > (p.lastReductionProbability ?? this.cfg.partialExitThreshold)) {
      const fraction = this.cfg.maximumPartialExitFraction * clamp(
        (reversalProbability - this.cfg.partialExitThreshold) / (1 - this.cfg.partialExitThreshold), 0, 1,
      );
      p.lastReductionProbability = reversalProbability;
      if (fraction > 0) return { action: "REDUCE", fraction, reason: "REVERSAL_RISK", floorPx: p.floorPx };
    }
    return { action: "HOLD", floorPx: p.floorPx, stopPx: p.entryPx + p.side * p.floorPx, signedMovePx: u };
  }
}
