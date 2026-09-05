import type { Direction } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { EntryFamily } from "../economics/types.js";
import type { AssetRules } from "../execution/planner.js";

// Changing a signal, exit, or execution assumption requires a new version.
export const POLICY_VERSION = "executable-policy-v2";
export const POLICY_SAMPLE_MS = 60_000;
export const POLICY_ENTRY_LATENCY_MS = 250;
export const POLICY_MAX_QUOTE_GAP_MS = 5_000;
export const POLICY_MAX_ENTRY_DELAY_MS = 1_000;
export const POLICY_NOTIONAL = 12;
export const POLICY_RESEARCH_COOLDOWN_MS = 1_800_000;

export function policyQuantity(price: number, asset: AssetRules): number {
  if (!(price > 0) || !(asset.minTradeIncrement > 0)) return 0;
  const qty = Math.floor(POLICY_NOTIONAL / price / asset.minTradeIncrement + 1e-12) * asset.minTradeIncrement;
  return qty >= asset.minOrderSize && qty <= asset.maximumOrderQty ? qty : 0;
}

export interface TradingPolicy {
  id: string;
  family: EntryFamily;
  horizonMs: number;
  stopLossBps: number;
  takeProfitNetBps: number;
}

// A small, declared research menu. These are hypotheses, not expected returns.
export const TRADING_POLICIES: readonly TradingPolicy[] = [
  { id: "trend-15m", family: "CONTINUATION", horizonMs: 900_000, stopLossBps: 30, takeProfitNetBps: 45 },
  { id: "trend-30m", family: "CONTINUATION", horizonMs: 1_800_000, stopLossBps: 40, takeProfitNetBps: 65 },
  { id: "breakout-1m", family: "EARLY_BREAKOUT", horizonMs: 60_000, stopLossBps: 15, takeProfitNetBps: 20 },
  { id: "breakout-3m", family: "EARLY_BREAKOUT", horizonMs: 180_000, stopLossBps: 20, takeProfitNetBps: 30 },
  { id: "recovery-5m", family: "PULLBACK_RECOVERY", horizonMs: 300_000, stopLossBps: 20, takeProfitNetBps: 30 },
  { id: "recovery-15m", family: "PULLBACK_RECOVERY", horizonMs: 900_000, stopLossBps: 30, takeProfitNetBps: 45 },
];

export interface PolicyCandidate { family: EntryFamily; side: Direction; regime: string }

/** The same causal predicates are used for collection and model-driven entries. */
export function policyCandidates(f: DeterministicFeatures): PolicyCandidate[] {
  if (f.stale || !f.warmedUp || !f.kinematicsReady || !f.slowTrendReady
    || ![f.spreadBps, f.trendFastBps, f.trendMediumBps, f.trendSlowBps,
      f.slowTrendEfficiency, f.ofi, f.tfi, f.velocityZ, f.anchorDistanceBps, f.sigmaHBps].every(Number.isFinite)
    || f.spreadBps < 0 || f.spreadBps > 10) return [];
  const candidates: PolicyCandidate[] = [];
  for (const side of [1, -1] as const) {
    if (side * f.trendFastBps > 0 && side * f.trendMediumBps > 0
      && side * f.trendSlowBps >= 10 && f.slowTrendEfficiency >= .25
      && side * f.ofi >= 0 && side * f.tfi >= 0) {
      candidates.push({ family: "CONTINUATION", side, regime: side === 1 ? "TREND_UP" : "TREND_DOWN" });
    }
    if (side * f.velocityZ >= .5 && side * f.ofi >= .3 && side * f.tfi >= .15
      && Math.max(side === 1 ? f.breakoutUpBps : f.breakoutDownBps, side * f.impulseBps) >= 1
      && side * f.trendMediumBps >= 0 && side * f.trendSlowBps >= 0) {
      candidates.push({ family: "EARLY_BREAKOUT", side, regime: side === 1 ? "BREAKOUT_UP" : "BREAKOUT_DOWN" });
    }
    const pullback = side === 1 ? f.longPullback : f.shortPullback;
    if (pullback.ready && pullback.pullbackDepthBps >= 30 && pullback.recoveryBps >= 5
      && pullback.remainingRoomBps >= 25 && pullback.reversalExtremeAgeMs <= 300_000
      && side * f.trendSlowBps >= 0 && side * f.ofi > 0 && side * f.tfi > 0) {
      candidates.push({ family: "PULLBACK_RECOVERY", side, regime: side === 1 ? "REVERSAL_UP" : "REVERSAL_DOWN" });
    }
  }
  return candidates;
}

export function findPolicy(id: string): TradingPolicy | undefined { return TRADING_POLICIES.find((p) => p.id === id); }

export function policyExit(policy: TradingPolicy, grossBps: number, netBps: number,
  elapsedMs: number): "POLICY_STOP" | "POLICY_TARGET" | "POLICY_DEADLINE" | null {
  if (![grossBps, netBps, elapsedMs].every(Number.isFinite)) return "POLICY_STOP";
  if (grossBps <= -policy.stopLossBps) return "POLICY_STOP";
  if (netBps >= policy.takeProfitNetBps) return "POLICY_TARGET";
  if (elapsedMs >= policy.horizonMs) return "POLICY_DEADLINE";
  return null;
}

export interface PolicyPositionSpec {
  version: string;
  id: string;
  feeBps: number;
  reserveBps: number;
}

export function validPositionPolicy(value: unknown): value is PolicyPositionSpec {
  if (!value || typeof value !== "object") return false;
  const p = value as PolicyPositionSpec;
  // Entry timing changed in v2; v1 positions still use identical protective exits.
  return [POLICY_VERSION, "executable-policy-v1"].includes(p.version) && !!findPolicy(p.id)
    && [p.feeBps, p.reserveBps].every((x) => Number.isFinite(x) && x >= 0);
}
