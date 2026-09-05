import type { BookState } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { PolicyModel } from "./policy-validation.js";
import type { LiquidityDecision } from "../strategy/dynamic-liquidity.js";
import { policyCandidates, POLICY_NOTIONAL, POLICY_SAMPLE_MS, POLICY_VERSION, TRADING_POLICIES,
  type PolicyCandidate } from "./trading-policy.js";

export interface PolicySampleState {
  atMs: number;
  candidates: Array<{ policyId: string; side: number }>;
}
export interface PolicyEntryEvaluationState {
  atMs: number;
  quoteAtMs?: number;
  policyId: string;
  side: number;
  reason: string;
  modelKey: string | null;
}
export interface PolicyEntryCounters {
  quoteChecks: number;
  signalMatches: number;
  liquidityRejected: number;
  planningRejected: number;
  plansApproved: number;
}
export interface PolicyMarketPulse {
  setup?: { version: string; phase: string; boundary: number | null; samples: number; volatilityBps: number; shift: string | null };
  research?: { version: string; hypotheses: string[]; counters: Record<string, number> };
  version: string;
  mode: "PAPER_RESEARCH" | "CALIBRATED_PAPER" | "SHADOW" | "RECORD";
  status: "DATA_GATED" | "WARMING" | "RISK_BLOCKED" | "POSITION_OPEN" | "ORDER_PENDING"
    | "COOLDOWN" | "WAITING_FOR_SIGNAL" | "AWAITING_VALIDATION" | "WAITING_FOR_QUOTE"
    | "LIQUIDITY_BLOCKED" | "ENTRY_BLOCKED";
  reasons: string[];
  candidates: PolicyCandidate[];
  families: Array<{ family: string; horizonsMs: number[]; longSignal: boolean; shortSignal: boolean }>;
  promotedModels: Array<{ policyId: string; side: number; regime: string; lowerNetBps: number; expiresAtMs: number }>;
  maximumNotional: number;
  sampleIntervalMs: number;
  cooldownRemainingMs: number;
  nextSampleAtMs: number | null;
  lastSample: PolicySampleState | null;
  lastEvaluation: PolicyEntryEvaluationState | null;
  lastRejection: { atMs: number; stage: string; reason: string } | null;
  activePolicyId: string | null;
  entryEvaluationMode: "FRESH_QUOTE";
  entryCounters: PolicyEntryCounters;
  liquidityReasons: string[];
}

/** Read-only diagnostics. A matching signal is never called an approved order:
 * exact sizing, economics and portfolio checks run on fresh quotes, not the
 * independent periodic research timer. */
export function policyMarketPulse(input: {
  nowMs: number; book: BookState; features: DeterministicFeatures | undefined;
  mode: PolicyMarketPulse["mode"]; shortable: boolean; models: readonly PolicyModel[];
  riskAllowed: boolean; riskReasons: readonly string[]; positionOpen: boolean; pendingOrder: boolean;
  cooldownUntilMs: number; activePolicyId: string | null;
  lastSample: PolicySampleState | undefined; lastEvaluation: PolicyEntryEvaluationState | undefined;
  lastRejection: PolicyMarketPulse["lastRejection"];
  liquidity?: { long: LiquidityDecision; short: LiquidityDecision } | undefined;
  entryCounters?: PolicyEntryCounters;
}): PolicyMarketPulse {
  const f = input.features;
  const dataValid = input.book.valid && f && !f.stale;
  const candidates = dataValid ? policyCandidates(f).filter((c) => c.side === 1 || input.shortable) : [];
  const cooldownRemainingMs = Math.max(0, input.cooldownUntilMs - input.nowMs);
  const matchingModel = input.models.some((m) => candidates.some((c) =>
    m.family === c.family && m.side === c.side && m.regime === c.regime)
    && f !== undefined && f.spreadBps <= m.maximumSpreadBps);
  const sides = candidates.length ? candidates.map((c) => c.side) : [1, -1];
  const liquidityReasons = [...new Set(sides.flatMap((side) => {
    const decision = side === 1 ? input.liquidity?.long : input.liquidity?.short;
    return decision?.pass ? [] : decision?.reasons ?? ["LIQUIDITY_UNAVAILABLE"];
  }))];
  const anyLiquidCandidate = candidates.some((c) => (c.side === 1 ? input.liquidity?.long : input.liquidity?.short)?.pass);
  let status: PolicyMarketPulse["status"];
  let reasons: string[] = [];
  if (!dataValid) { status = "DATA_GATED"; reasons = [f?.staleReason ?? "BOOK_OR_FEATURES_UNAVAILABLE"]; }
  else if (input.pendingOrder) status = "ORDER_PENDING";
  else if (input.positionOpen) status = "POSITION_OPEN";
  else if (!f.warmedUp || (f.retestCandidate === undefined && (!f.slowTrendReady || !f.kinematicsReady))) {
    status = "WARMING";
    reasons = [!f.warmedUp ? "FEATURE_WARMUP" : !f.slowTrendReady ? "SLOW_TREND_WARMUP" : "KINEMATICS_NOT_READY"];
  } else if (!input.riskAllowed) { status = "RISK_BLOCKED"; reasons = [...input.riskReasons]; }
  else if (cooldownRemainingMs > 0) status = "COOLDOWN";
  else if (!candidates.length) status = "WAITING_FOR_SIGNAL";
  else if (!anyLiquidCandidate) { status = "LIQUIDITY_BLOCKED"; reasons = liquidityReasons; }
  else if (!matchingModel && input.mode !== "PAPER_RESEARCH") status = "AWAITING_VALIDATION";
  else if (input.lastEvaluation?.quoteAtMs === f.receiveTsMs
    && !["POLICY_PAPER_EXPERIMENT", "POLICY_PROMOTED_PAPER"].includes(input.lastEvaluation.reason)) {
    status = "ENTRY_BLOCKED"; reasons = [input.lastEvaluation.reason];
  } else status = "WAITING_FOR_QUOTE";
  return { version: POLICY_VERSION, mode: input.mode, status, reasons, candidates,
    families: [...new Set(TRADING_POLICIES.filter((p) => f?.retestCandidate === undefined || p.family === "BREAKOUT_RETEST")
      .map((p) => p.family))].map((family) => ({
      family, horizonsMs: TRADING_POLICIES.filter((p) => p.family === family).map((p) => p.horizonMs),
      longSignal: candidates.some((c) => c.family === family && c.side === 1),
      shortSignal: candidates.some((c) => c.family === family && c.side === -1),
    })),
    promotedModels: input.models.map(({ policyId, side, regime, lowerNetBps, expiresAtMs }) =>
      ({ policyId, side, regime, lowerNetBps, expiresAtMs })),
    maximumNotional: POLICY_NOTIONAL, sampleIntervalMs: POLICY_SAMPLE_MS, cooldownRemainingMs,
    nextSampleAtMs: input.lastSample ? input.lastSample.atMs + POLICY_SAMPLE_MS : null,
    lastSample: input.lastSample ? { ...input.lastSample, candidates: input.lastSample.candidates.map((c) => ({ ...c })) } : null,
    lastEvaluation: input.lastEvaluation ? { ...input.lastEvaluation } : null,
    lastRejection: input.lastRejection ? { ...input.lastRejection } : null, activePolicyId: input.activePolicyId,
    entryEvaluationMode: "FRESH_QUOTE", liquidityReasons,
    entryCounters: { ...(input.entryCounters ?? { quoteChecks: 0, signalMatches: 0, liquidityRejected: 0, planningRejected: 0, plansApproved: 0 }) },
  };
}
