import { randomUUID } from "node:crypto";
import type { BookState } from "../core/market.js";
import { estimateSweep } from "../execution/book-walk.js";
import type { PolicyObservation } from "./policy-collector.js";
import { findPolicy, policyExit, POLICY_MAX_ENTRY_DELAY_MS, POLICY_MAX_QUOTE_GAP_MS } from "./trading-policy.js";

export const EPISODE_VERSION = "after-cost-episodes-v1";
export interface ExecutionScenario { id: string; latencyMs: number; feeMultiplier: number; depthMultiplier: number }
// Predeclared sensitivity assumptions, not measured live-venue latency.
export const EXECUTION_SCENARIOS: readonly ExecutionScenario[] = Object.freeze([
  { id: "base-250ms", latencyMs: 250, feeMultiplier: 1, depthMultiplier: 1 },
  { id: "latency-500ms", latencyMs: 500, feeMultiplier: 1, depthMultiplier: 1 },
  { id: "latency-1000ms", latencyMs: 1_000, feeMultiplier: 1, depthMultiplier: 1 },
  { id: "fees-1.5x", latencyMs: 250, feeMultiplier: 1.5, depthMultiplier: 1 },
  { id: "depth-50pct", latencyMs: 500, feeMultiplier: 1, depthMultiplier: .5 },
].map((scenario) => Object.freeze(scenario)));

export interface EpisodeContext {
  healthAllowed: boolean;
  healthReasons: string[];
  liquidityPass: boolean;
  liquidityReasons: string[];
  positionOpen: boolean;
  pendingOrder: boolean;
  cooldownRemainingMs: number;
  sizing: "VENUE_NOTIONAL_ONLY" | "ACTUAL_ORDER_QUANTITY";
}
export interface EpisodeObservation extends PolicyObservation {
  sampling: "EPISODE";
  policyVersion: typeof EPISODE_VERSION;
  episodeId: string;
  hypothesisId: string;
  scenario: ExecutionScenario;
  context: EpisodeContext;
}

export function stressObservation(source: PolicyObservation, scenario: ExecutionScenario,
  episodeId: string, hypothesisId: string, context: EpisodeContext): EpisodeObservation {
  if (!findPolicy(source.policyId) || ![1, -1].includes(source.side)
    || ![source.qty, source.signalAsk, source.signalBid].every((n) => Number.isFinite(n) && n > 0)
    || source.signalAsk <= source.signalBid || !Number.isFinite(source.signalAtMs)
    || ![source.feeBps, source.reserveBps].every((n) => Number.isFinite(n) && n >= 0)
    || !Number.isFinite(scenario.latencyMs) || scenario.latencyMs < 1 || scenario.latencyMs > 1_000
    || ![scenario.feeMultiplier, scenario.depthMultiplier].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("Invalid execution stress input");
  }
  return { ...source, id: randomUUID(), policyVersion: EPISODE_VERSION, sampling: "EPISODE",
    episodeId, hypothesisId, scenario: { ...scenario }, context: structuredClone(context),
    feeBps: source.feeBps * scenario.feeMultiplier, features: { ...source.features },
    status: "PENDING", reason: null, filledQty: 0, entryAtMs: null, entryPrice: null,
    exitAtMs: null, exitPrice: null, grossBps: null, netBps: null };
}

/** One independent hypothetical IOC. No gateway, timers, account mutation, or
 * shared consumption of liquidity between mutually exclusive scenarios. */
export class ExecutionStressCase {
  private readonly value: EpisodeObservation;
  private lastQuoteMs: number;
  private exitDueMs?: number;
  private exitReason?: string;
  public constructor(start: EpisodeObservation) {
    this.value = structuredClone(start);
    this.lastQuoteMs = start.signalAtMs;
  }
  public snapshot(): EpisodeObservation { return structuredClone(this.value); }
  public get pending(): boolean { return this.value.status === "PENDING"; }
  public invalidate(now: number, reason: string): EpisodeObservation | null {
    if (!this.pending) return null;
    Object.assign(this.value, { status: "INVALID", exitAtMs: now, reason });
    return this.snapshot();
  }
  public observe(book: BookState, stale = false): EpisodeObservation | null {
    const o = this.value, now = book.receiveTsMs;
    if (!this.pending || book.symbol !== o.symbol) return null;
    if (!Number.isFinite(now) || !book.valid || stale || !book.bids[0] || !book.asks[0]
      || book.asks[0].px <= book.bids[0].px || now < this.lastQuoteMs
      || now - this.lastQuoteMs > POLICY_MAX_QUOTE_GAP_MS
      || ![...book.bids, ...book.asks].every((l) => Number.isFinite(l.px) && l.px > 0 && Number.isFinite(l.qty) && l.qty >= 0)) {
      return this.invalidate(Number.isFinite(now) ? now : this.lastQuoteMs, "QUOTE_GAP_OR_INVALID");
    }
    this.lastQuoteMs = now;
    const depth = (levels: BookState["bids"]): BookState["bids"] => o.scenario.depthMultiplier === 1
      ? levels : levels.map((l) => ({ ...l, qty: l.qty * o.scenario.depthMultiplier }));
    if (o.entryAtMs === null) {
      if (now < o.signalAtMs + o.scenario.latencyMs) return null;
      if (now > o.signalAtMs + o.scenario.latencyMs + POLICY_MAX_ENTRY_DELAY_MS) {
        return this.invalidate(now, "ENTRY_NOT_EXECUTABLE");
      }
      const cap = o.side === 1 ? o.signalAsk : o.signalBid;
      const levels = depth(o.side === 1 ? book.asks : book.bids).filter((l) => o.side * (l.px - cap) <= 1e-9);
      const qty = Math.min(o.qty, levels.reduce((sum, l) => sum + l.qty, 0));
      const entry = estimateSweep(levels, qty);
      if (!entry) {
        Object.assign(o, { status: "COMPLETE", exitAtMs: now, grossBps: 0, netBps: 0, reason: "ENTRY_NOT_FILLED" });
        return this.snapshot();
      }
      o.entryAtMs = now; o.entryPrice = entry.vwap; o.filledQty = qty;
    }
    const exit = estimateSweep(depth(o.side === 1 ? book.bids : book.asks), o.filledQty);
    // Insufficient exit depth is missing evidence, never a free/zero-return exit.
    if (!exit) return this.invalidate(now, "EXIT_DEPTH_UNAVAILABLE");
    const gross = o.side * (exit.vwap - o.entryPrice!) / o.entryPrice! * 10_000;
    const net = gross - o.feeBps * (1 + exit.vwap / o.entryPrice!) - o.reserveBps;
    if (this.exitDueMs === undefined) {
      const reason = policyExit(findPolicy(o.policyId)!, gross, net, now - o.entryAtMs);
      if (reason) { this.exitReason = reason; this.exitDueMs = now + o.scenario.latencyMs; }
    }
    if (this.exitDueMs !== undefined && now >= this.exitDueMs) {
      const fraction = o.filledQty / o.qty;
      Object.assign(o, { status: "COMPLETE", exitAtMs: now, exitPrice: exit.vwap,
        grossBps: gross * fraction, netBps: net * fraction, reason: this.exitReason });
      return this.snapshot();
    }
    return null;
  }
}
