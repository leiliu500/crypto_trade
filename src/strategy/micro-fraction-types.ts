import type { Direction } from "../core/market.js";

export type { Direction };

export interface SmallFractionFeatures {
  readonly symbol: string;
  readonly nowMs: number;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly mid: number;
  readonly microprice: number;
  readonly qiK: number;
  readonly ofi: number;
  readonly tfi: number;
  readonly replenishmentPressure: number;
  readonly velocityZ: number;
  readonly accelerationZ: number;
  readonly breakoutUpBps: number;
  readonly breakoutDownBps: number;
  readonly cusumUp: number;
  readonly cusumDown: number;
  readonly efficiency: number;
  readonly flowFlipRate: number;
  readonly varianceRate: number;
  readonly providerAgeMs: number;
  readonly stale: boolean;
  readonly bookReady: boolean;
}

export interface SmallFractionTriggerConfig {
  readonly noiseTauMs: number;
  readonly microPressureScale: number;
  readonly qiKScale: number;
  readonly ofiScale: number;
  readonly tfiScale: number;
  readonly replenishmentScale: number;
  readonly velocityScale: number;
  readonly breakoutScaleBps: number;
  readonly microWeight: number;
  readonly qiKWeight: number;
  readonly ofiWeight: number;
  readonly tfiWeight: number;
  readonly replenishmentWeight: number;
  readonly velocityWeight: number;
  readonly breakoutWeight: number;
  readonly minimumMicroPressure: number;
  readonly minimumQiK: number;
  readonly minimumOfi: number;
  readonly minimumTfi: number;
  readonly minimumReplenishment: number;
  readonly minimumVelocityZ: number;
  readonly minimumBreakoutBps: number;
  readonly minimumCusum: number;
  readonly minimumMicroMoveBps: number;
  readonly noiseMovementMultiplier: number;
  readonly armScore: number;
  readonly strongScore: number;
  readonly releaseScore: number;
  readonly evidenceDriftAllowance: number;
  readonly opposingEvidencePenalty: number;
  readonly evidenceTauMs: number;
  readonly fireEvidenceScoreSeconds: number;
  readonly occupancyTauMs: number;
  readonly minimumOccupancy: number;
  readonly minimumConfirmationMs: number;
  readonly strongConfirmationMs: number;
  readonly minimumConfirmationEvents: number;
  readonly strongConfirmationEvents: number;
  readonly maximumChaseBps: number;
  readonly arbitrationMargin: number;
  /** Minimum delay before a downstream-rejected episode may propose a stronger candidate. */
  readonly candidateRetryMs: number;
  readonly cooldownMs: number;
  readonly maximumEventGapMs: number;
}

export interface SideTriggerDiagnostics {
  readonly side: Direction;
  readonly score: number;
  readonly microPressure: number;
  readonly bookPass: boolean;
  readonly flowPass: boolean;
  readonly motionPass: boolean;
  readonly groupCount: number;
  readonly groupQuorum: boolean;
  readonly sensorThresholdBps: number;
  readonly deltaMicroBps: number;
  readonly microNoiseBps: number;
  readonly occupancy: number;
  readonly evidence: number;
  readonly confirmationMs: number;
  readonly consecutiveEvents: number;
  readonly chaseBps: number;
  readonly armed: boolean;
  readonly strong: boolean;
  readonly fire: boolean;
  readonly reasons: readonly string[];
}

export interface SmallFractionCandidate {
  readonly source: "DETERMINISTIC_MICRO";
  readonly symbol: string;
  readonly side: Direction;
  readonly createdMs: number;
  readonly score: number;
  readonly occupancy: number;
  readonly evidence: number;
  readonly confirmationMs: number;
  readonly consecutiveEvents: number;
  readonly deltaMicroBps: number;
  readonly sensorThresholdBps: number;
  readonly chaseBps: number;
}

export interface SmallFractionTriggerResult {
  readonly long: SideTriggerDiagnostics;
  readonly short: SideTriggerDiagnostics;
  readonly candidate: SmallFractionCandidate | null;
}

export function squash(value: number, scale: number): number {
  return Math.tanh(value / Math.max(scale, 1e-9));
}
