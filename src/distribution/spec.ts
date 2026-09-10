import type { Direction } from "../core/market.js";

export const DISTRIBUTION_SPEC = Object.freeze({
  version: "btc-eth-distributional-control-v1", symbols: ["BTC/USD", "ETH/USD"] as const,
  selectionPolicyVersion: "btc-eth-selected-policy-v3", evaluationIntervalMs: 1_000,
  proposalIntervalMs: 1_860_000, maximumQuoteAgeMs: 1_000, maximumQuoteGapMs: 5_000,
  maximumPeerAgeMs: 2_000, maximumSamples: 1_024, minimumSamples: 48,
  minimumEffectiveSamples: 32, minimumDays: 7, memoryHalfLifeMs: 7 * 86_400_000,
  maximumTrainingAgeMs: 86_400_000, featureDimension: 12, kernelBandwidth: 1,
  priorWeight: 16, uncertaintyMultiplier: 2.58, tailFraction: .1, tailPenalty: .1,
  minimumScoreBps: 1, maximumNotional: 12,
  minimumValidationSelections: 20,
});
export type DistributionEntryMode = "VALIDATED" | "PAPER_TRIAL";
export interface DistributionEntryProfile {
  entryMode: DistributionEntryMode; selectionPolicyVersion: string;
  minimumTrainingDays: number; requiresProspectiveValidation: boolean;
}
/** Entry permission is versioned separately from historical training labels.
 * The opt-in trial changes only the date gate and prospective-order gate. */
export const DISTRIBUTION_ENTRY_PROFILES = Object.freeze({
  VALIDATED: Object.freeze({ entryMode: "VALIDATED", selectionPolicyVersion: DISTRIBUTION_SPEC.selectionPolicyVersion,
    minimumTrainingDays: DISTRIBUTION_SPEC.minimumDays, requiresProspectiveValidation: true } as const),
  PAPER_TRIAL: Object.freeze({ entryMode: "PAPER_TRIAL", selectionPolicyVersion: "btc-eth-selected-policy-paper-trial-3d-v2",
    minimumTrainingDays: 3, requiresProspectiveValidation: false } as const),
  PAPER_TRIAL_EFFICIENT: Object.freeze({ entryMode: "PAPER_TRIAL",
    selectionPolicyVersion: "btc-eth-selected-policy-paper-trial-3d-efficient-v1",
    minimumTrainingDays: 3, requiresProspectiveValidation: false } as const),
  PAPER_TRIAL_REGIME: Object.freeze({ entryMode: "PAPER_TRIAL",
    selectionPolicyVersion: "btc-eth-selected-policy-paper-trial-regime-tree-v1",
    minimumTrainingDays: 3, requiresProspectiveValidation: false } as const),
});
export function distributionEntryProfile(paperTrialEnabled = false, efficientTraining = false, regimeModel = false): Readonly<DistributionEntryProfile> {
  if (regimeModel && (!paperTrialEnabled || !efficientTraining)) throw new Error("REGIME_MODEL_REQUIRES_EFFICIENT_PAPER_TRIAL");
  if (efficientTraining && !paperTrialEnabled) throw new Error("EFFICIENT_TRAINING_REQUIRES_PAPER_TRIAL");
  if (regimeModel) return DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_REGIME;
  if (efficientTraining) return DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT;
  return paperTrialEnabled ? DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL : DISTRIBUTION_ENTRY_PROFILES.VALIDATED;
}
export function isDistributionEntryProfile(value: unknown): value is DistributionEntryProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as DistributionEntryProfile;
  if (candidate.entryMode !== "VALIDATED" && candidate.entryMode !== "PAPER_TRIAL") return false;
  return Object.values(DISTRIBUTION_ENTRY_PROFILES).some(fixed => candidate.entryMode === fixed.entryMode
    && Object.keys(candidate).length === Object.keys(fixed).length
    && candidate.selectionPolicyVersion === fixed.selectionPolicyVersion
    && candidate.minimumTrainingDays === fixed.minimumTrainingDays
    && candidate.requiresProspectiveValidation === fixed.requiresProspectiveValidation);
}
export const DISTRIBUTION_ACTIONS = [5, 15, 30].flatMap(minutes => ([1, -1] as const).map(side => ({
  id: `${side === 1 ? "long" : "short"}-${minutes}m`, side,
  policyId: `distribution-${minutes}m`, horizonMs: minutes * 60_000,
  stopLossBps: minutes === 5 ? 25 : minutes === 15 ? 40 : 60,
  takeProfitNetBps: minutes === 5 ? 40 : minutes === 15 ? 65 : 90,
})));
export const DISTRIBUTION_SCENARIOS = [
  { id: "base-250ms", latencyMs: 250, feeMultiplier: 1, depthMultiplier: 1 },
  { id: "fees-1.5x", latencyMs: 250, feeMultiplier: 1.5, depthMultiplier: 1 },
  { id: "latency-750ms-depth-half", latencyMs: 750, feeMultiplier: 1, depthMultiplier: .5 },
] as const;
export interface DistributionAction { id: string; side: Direction; policyId: string; horizonMs: number;
  stopLossBps: number; takeProfitNetBps: number }
export interface DistributionOutcome {
  scenario: string; status: "FILLED" | "UNFILLED" | "INVALID";
  netBps: number | null; grossBps: number | null; filledFraction: number;
  entryAtMs: number | null; exitAtMs: number; reason: string;
}
export interface DistributionSample {
  sizingPolicyId?: string;
  id: string; symbol: string; actionId: string; signalAtMs: number; completedAtMs: number;
  features: number[]; outcomes: DistributionOutcome[];
}
export interface DistributionEstimate {
  actionId: string; samples: number; effectiveSamples: number; observedDays: number;
  meanNetBps: number | null; lowerMeanNetBps: number | null; tailLossBps: number | null;
  scoreBps: number | null; fillProbability: number; reason: string; eligible: boolean;
}
export interface DistributionDecision {
  sizingPolicyId?: string;
  version: string; symbol: string; atMs: number; quoteSequence: string;
  selectionPolicyVersion?: string;
  entryMode?: DistributionEntryMode;
  referenceBid: number; referenceAsk: number; requestedQty: number;
  feeBps: number; reserveBps: number; features: number[];
  estimates: DistributionEstimate[]; actionId: string | null; reason: string;
  paperReady: boolean;
  validation: { selections: number; observedDays: number; lowerNetBps: number | null; ready: boolean };
}
