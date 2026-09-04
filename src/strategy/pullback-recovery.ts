import type { Direction } from "../core/market.js";
import { clamp } from "../core/market.js";
import type { ConservativeEdge } from "../economics/types.js";
import type { DeterministicFeatures, PullbackRecoveryState } from "./deterministic-features.js";

export interface PullbackRecoveryConfig {
  enabled: boolean;
  horizonMs: number;
  minimumStructuralMoveBps: number;
  minimumPullbackDepthBps: number;
  minimumRecoveryBps: number;
  minimumRetainedTrendBps: number;
  minimumRemainingRoomBps: number;
  maximumRecoveryFraction: number;
  /** Maximum age of the counter-extreme that defines the recovery episode. */
  maximumReversalAgeMs: number;
  captureFraction: number;
  baseUncertaintyBps: number;
  roomUncertaintyFraction: number;
  maximumGrossBps: number;
}

export function pullbackState(side: Direction, features: DeterministicFeatures): PullbackRecoveryState {
  return side === 1 ? features.longPullback : features.shortPullback;
}

/** Structural eligibility is independent of the continuation thresholds it is designed to complement. */
export function pullbackRecoveryPass(side: Direction, features: DeterministicFeatures,
  cfg: PullbackRecoveryConfig): boolean {
  if (!cfg.enabled) return false;
  const state = pullbackState(side, features);
  const recoveryFraction = state.recoveryBps / Math.max(state.pullbackDepthBps, 1e-9);
  const retainedTrendBps = state.structuralMoveBps - state.remainingRoomBps;
  return state.ready
    && state.structuralMoveBps >= cfg.minimumStructuralMoveBps
    && state.pullbackDepthBps >= cfg.minimumPullbackDepthBps
    && state.recoveryBps >= cfg.minimumRecoveryBps
    && retainedTrendBps >= cfg.minimumRetainedTrendBps
    && state.remainingRoomBps >= cfg.minimumRemainingRoomBps
    && state.reversalExtremeAgeMs <= cfg.maximumReversalAgeMs
    && recoveryFraction <= cfg.maximumRecoveryFraction;
}

/**
 * Values only the still-unrealized distance back toward the prior structural extreme.
 * Realized rebound and prior trend are confirmation features, never counted as future gross edge.
 */
export function pullbackRecoveryEdges(side: Direction, features: DeterministicFeatures,
  confirmationQuality: number, cfg: PullbackRecoveryConfig): ConservativeEdge[] {
  if (!pullbackRecoveryPass(side, features, cfg)) return [];
  const state = pullbackState(side, features);
  const structuralQuality = clamp(state.structuralMoveBps / cfg.minimumStructuralMoveBps, 0, 1);
  const depthQuality = clamp(state.pullbackDepthBps / cfg.minimumPullbackDepthBps, 0, 1);
  const recoveryQuality = clamp(state.recoveryBps / Math.max(.25 * state.pullbackDepthBps, cfg.minimumRecoveryBps), 0, 1);
  const quality = clamp(.25 * structuralQuality + .25 * depthQuality + .25 * recoveryQuality
    + .25 * clamp(confirmationQuality, 0, 1), 0, 1);
  const grossBeforeUncertaintyBps = Math.min(cfg.maximumGrossBps,
    cfg.captureFraction * quality * state.remainingRoomBps);
  const signalUncertaintyBps = cfg.baseUncertaintyBps
    + cfg.roomUncertaintyFraction * (1 - quality) * state.remainingRoomBps;
  return [{
    source: "ANALYTIC", family: "PULLBACK_RECOVERY", side, horizonMs: cfg.horizonMs,
    grossBeforeUncertaintyBps, signalUncertaintyBps,
    conservativeGrossBps: Math.max(0, grossBeforeUncertaintyBps - signalUncertaintyBps),
    quality, effectiveSampleCount: 0,
  }];
}

export function validatePullbackRecoveryConfig(cfg: PullbackRecoveryConfig): void {
  const positive = [cfg.horizonMs, cfg.maximumReversalAgeMs, cfg.minimumStructuralMoveBps, cfg.minimumPullbackDepthBps,
    cfg.minimumRecoveryBps, cfg.minimumRemainingRoomBps, cfg.captureFraction, cfg.maximumGrossBps];
  const nonnegative = [cfg.minimumRetainedTrendBps, cfg.baseUncertaintyBps, cfg.roomUncertaintyFraction];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0)
    || nonnegative.some((value) => !Number.isFinite(value) || value < 0)
    || !(cfg.maximumRecoveryFraction > 0 && cfg.maximumRecoveryFraction < 1)
    || cfg.captureFraction > 1) throw new Error("Invalid pullback-recovery configuration");
}
