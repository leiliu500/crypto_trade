import type { Direction, Features } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { EntryFamily, ExecutionPath } from "../economics/types.js";
import { findPolicy, policyExit, policyProtection, validPositionPolicy, type PolicyPositionSpec } from "../research/trading-policy.js";
import { netLiquidation, requiredNetExecutionPrice, type LinearLedger, type NetProtection } from "../economics/net-liquidation.js";

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
  policy?: PolicyPositionSpec;
  ledger?: LinearLedger;
  netProtection?: NetProtection;
  netLiquidationUsd?: number;
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
  earlyBreakoutMinimumHoldMs?: number;
  earlyBreakoutUnproductiveExitMs?: number;
  earlyBreakoutMaximumHoldMs?: number;
  earlyBreakoutEvidenceConfirmationMs?: number;
  earlyBreakoutProfitActivationCostMultiple?: number;
  earlyBreakoutMinimumProgressR?: number;
  earlyBreakoutTrailActivationR?: number;
}
export type PositionDecision =
  | { action: "HOLD"; floorPx: number; stopPx: number; signedMovePx: number }
  | { action: "REDUCE"; fraction: number; reason: string; floorPx: number }
  | { action: "EXIT"; reason: string };

export class PositionManager {
  public constructor(private readonly cfg: PositionConfig) {}
  public update(p: Position, executableExitPx: number, nowMs: number, f: Features, holdLowerBoundBps: number,
    reversalProbability: number, reductionBenefitBps = 0, holdExitEvidence?: boolean): PositionDecision {
    if (!Number.isFinite(executableExitPx) || !(executableExitPx > 0)) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "EXIT_DEPTH_UNAVAILABLE" };
    }
    const u = p.side * (executableExitPx - p.entryPx);
    const risk = p.initialRiskPx;
    if (!(risk > 0)) return { action: "EXIT", reason: "INVALID_INITIAL_RISK" };
    p.mfePx = Math.max(p.mfePx, u);
    p.maePx = Math.max(p.maePx, -u);
    if (f.stale) { p.phase = "EXITING"; return { action: "EXIT", reason: "DATA_INVALID" }; }
    if (p.policy) {
      if (!validPositionPolicy(p.policy)) { p.phase = "EXITING"; return { action: "EXIT", reason: "INVALID_POLICY" }; }
      const policy = findPolicy(p.policy.id)!;
      const grossBps = u / p.entryPx * 10_000;
      let netBps = grossBps - p.policy.feeBps * (1 + executableExitPx / p.entryPx) - p.policy.reserveBps;
      if (policy.family === "BREAKOUT_RETEST") {
        if (p.phase === "EXITING") return { action: "EXIT", reason: "POLICY_EXIT_LATCHED" };
        if (!p.ledger || Math.abs(p.ledger.remainingQty - p.qty) > 1e-8) {
          p.phase = "EXITING"; return { action: "EXIT", reason: "POLICY_LEDGER_UNCERTAIN" };
        }
        const reserve = p.ledger.entryNotional * p.policy.reserveBps / 10_000;
        p.netLiquidationUsd = netLiquidation(p.ledger, executableExitPx, p.policy.feeBps, reserve);
        p.netProtection ??= policyProtection(policy, p.policy.feeBps, p.policy.reserveBps, p.ledger.entryNotional);
        netBps = p.netLiquidationUsd / p.netProtection.entryNotional * 10_000;
        // Restarted positions keep the persisted floor; partial exits retain
        // the original lifecycle's P&L and risk basis.
        if (p.policy.invalidationPx !== undefined && p.side * (f.mid - p.policy.invalidationPx) < 0) {
          p.phase = "EXITING"; return { action: "EXIT", reason: "POLICY_STRUCTURE_INVALID" };
        }
      }
      const reason = policyExit(policy, grossBps, netBps, nowMs - p.openedMs, p.netProtection, p.policy.volatilityBps ?? 0);
      if (reason) { p.phase = "EXITING"; return { action: "EXIT", reason }; }
      if (p.netProtection && p.ledger) {
        const price = requiredNetExecutionPrice(p.ledger, p.netProtection.floorUsd,
          p.policy.feeBps, p.ledger.entryNotional * p.policy.reserveBps / 10_000);
        if (price === null) { p.phase = "EXITING"; return { action: "EXIT", reason: "INVALID_NET_FLOOR" }; }
        p.floorPx = p.side * (price - p.entryPx);
        p.phase = p.netProtection.activated ? "PROTECTED" : p.netProtection.recovered ? "RECOVERY" : "OPEN";
        return { action: "HOLD", floorPx: p.floorPx, stopPx: price, signedMovePx: u };
      }
      // A policy has one fixed stop and one unconditional deadline. The legacy
      // micro hold forecast must not silently substitute another exit policy.
      p.floorPx = -p.entryPx * policy.stopLossBps / 10_000;
      if (u <= -risk) { p.phase = "EXITING"; return { action: "EXIT", reason: "HARD_STOP" }; }
      return { action: "HOLD", floorPx: p.floorPx, stopPx: p.entryPx + p.side * p.floorPx, signedMovePx: u };
    }
    if (u <= -risk) { p.phase = "EXITING"; return { action: "EXIT", reason: "HARD_STOP" }; }
    const elapsedMs = nowMs - p.openedMs;
    const earlyBreakout = p.entryFamily === "EARLY_BREAKOUT";
    const minimumHoldMs = earlyBreakout ? this.cfg.earlyBreakoutMinimumHoldMs ?? this.cfg.minimumHoldMs : this.cfg.minimumHoldMs;
    const unproductiveExitMs = earlyBreakout
      ? this.cfg.earlyBreakoutUnproductiveExitMs ?? this.cfg.unproductiveExitMs : this.cfg.unproductiveExitMs;
    const evidenceConfirmationMs = earlyBreakout
      ? this.cfg.earlyBreakoutEvidenceConfirmationMs ?? this.cfg.evidenceConfirmationMs : this.cfg.evidenceConfirmationMs;
    const profitActivationCostMultiple = earlyBreakout
      ? this.cfg.earlyBreakoutProfitActivationCostMultiple ?? this.cfg.profitActivationCostMultiple
      : this.cfg.profitActivationCostMultiple;
    const minimumProgressR = earlyBreakout
      ? this.cfg.earlyBreakoutMinimumProgressR ?? this.cfg.minimumProgressR : this.cfg.minimumProgressR;
    const trailActivationR = earlyBreakout
      ? this.cfg.earlyBreakoutTrailActivationR ?? this.cfg.trailActivationR : this.cfg.trailActivationR;
    const hasRecovered = p.maePx >= this.cfg.recoveryArmR * risk && u >= p.roundTripCostPx;
    if (hasRecovered && !p.breakEvenArmed) {
      p.phase = "RECOVERY";
      if (holdLowerBoundBps <= 0) { p.phase = "EXITING"; return { action: "EXIT", reason: "RECOVERY_NO_EDGE" }; }
      p.breakEvenArmed = true;
    }
    const costBasedActivation = p.roundTripCostPx > 0
      ? profitActivationCostMultiple * p.roundTripCostPx : 0;
    const breakEvenActivationPx = Math.max(minimumProgressR * risk, costBasedActivation);
    if (p.mfePx >= breakEvenActivationPx) p.breakEvenArmed = true;
    // Require both a meaningful fraction of initial risk and sufficient cost
    // coverage before trailing. The old min() activated at one cost unit and
    // repeatedly converted valid trends into tiny winners.
    const protectionActivationPx = Math.max(trailActivationR * risk, costBasedActivation);
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
      const maturity = 1 - Math.exp(-this.cfg.lockMaturityRate * Math.max(0, p.mfePx / risk - trailActivationR));
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
      ? p.roundTripCostPx : minimumProgressR * risk;
    if (elapsedMs >= minimumHoldMs && p.mfePx < meaningfulProgressPx
      && u <= -minimumProgressR * risk) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "EARLY_ADVERSE_STOP" };
    }
    if (elapsedMs >= unproductiveExitMs && p.mfePx < meaningfulProgressPx) {
      p.phase = "EXITING"; return { action: "EXIT", reason: "UNPRODUCTIVE_TIME_STOP" };
    }

    // The hold engine intentionally combines weak continuation, reversal
    // quorum, and negative incremental edge with OR semantics. Requiring a
    // negative LCB and a reversal quorum here discarded most valid exits.
    const adverseEvidence = holdExitEvidence ?? (holdLowerBoundBps <= 0 || reversalProbability >= .55);
    if (adverseEvidence) {
      p.adverseEvidenceSinceMs ??= nowMs;
      if (elapsedMs >= minimumHoldMs && nowMs - p.adverseEvidenceSinceMs >= evidenceConfirmationMs) {
        p.phase = "EXITING"; return { action: "EXIT", reason: "EVIDENCE_EXIT" };
      }
    } else delete p.adverseEvidenceSinceMs;
    const configuredMaximumHoldMs = earlyBreakout
      ? this.cfg.earlyBreakoutMaximumHoldMs ?? this.cfg.maximumHoldMs : this.cfg.maximumHoldMs;
    const maximumHoldMs = Math.min(configuredMaximumHoldMs, p.selectedHorizonMs ?? configuredMaximumHoldMs);
    if (elapsedMs >= maximumHoldMs && p.mfePx < minimumProgressR * risk) {
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
