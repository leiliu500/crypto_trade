import { randomUUID } from "node:crypto";
import type { BookState } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import { estimateSweep } from "../execution/book-walk.js";
import type { AssetRules } from "../execution/planner.js";
import { findPolicy, policyCandidates, policyExit, POLICY_VERSION, POLICY_SAMPLE_MS,
  POLICY_ENTRY_LATENCY_MS, POLICY_MAX_ENTRY_DELAY_MS, POLICY_MAX_QUOTE_GAP_MS, POLICY_NOTIONAL,
  TRADING_POLICIES, policyQuantity, policyProtection, type PolicyCandidate } from "./trading-policy.js";
import type { NetProtection } from "../economics/net-liquidation.js";

export interface PolicyObservation extends PolicyCandidate {
  sampling: "PERIODIC" | "ENTRY" | "EPISODE";
  id: string;
  configurationVersion: string;
  policyVersion: string;
  symbol: string;
  policyId: string;
  signalAtMs: number;
  entryAtMs: number | null;
  exitAtMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  qty: number;
  filledQty: number;
  signalBid: number;
  signalAsk: number;
  spreadBps: number;
  feeBps: number;
  reserveBps: number;
  grossBps: number | null;
  netBps: number | null;
  status: "PENDING" | "COMPLETE" | "INVALID";
  reason: string | null;
  features: Record<string, number>;
}

interface Pending { observation: PolicyObservation; lastQuoteMs: number; exitReason?: string; exitDueMs?: number; protection?: NetProtection }

export class PolicyCollector {
  private readonly pending = new Map<string, Pending>();
  private lastSampleMs = Number.NEGATIVE_INFINITY;
  public lastSampleAtMs(): number { return this.lastSampleMs; }
  public constructor(private readonly configurationVersion: string, private readonly symbol: string,
    private readonly feeBps: number, private readonly reserveBps: number) {
    if (![feeBps, reserveBps].every((x) => Number.isFinite(x) && x >= 0)) throw new Error("Invalid policy costs");
  }

  public observe(book: BookState, features: DeterministicFeatures, asset?: AssetRules): PolicyObservation[] {
    const events: PolicyObservation[] = [];
    const now = features.receiveTsMs;
    const valid = book.valid && !features.stale && book.bids[0] && book.asks[0]
      && book.asks[0].px > book.bids[0].px && book.receiveTsMs === now;
    for (const [id, pending] of this.pending) {
      const o = pending.observation;
      if (!valid || now < pending.lastQuoteMs || now - pending.lastQuoteMs > POLICY_MAX_QUOTE_GAP_MS) {
        events.push({ ...o, status: "INVALID", exitAtMs: now, reason: "QUOTE_GAP" });
        this.pending.delete(id);
        continue;
      }
      pending.lastQuoteMs = now;
      if (o.entryAtMs === null) {
        if (now < o.signalAtMs + POLICY_ENTRY_LATENCY_MS) continue;
        const entryCap = o.side === 1 ? o.signalAsk : o.signalBid;
        const levels = (o.side === 1 ? book.asks : book.bids).filter((level) => o.side * (level.px - entryCap) <= 1e-9);
        const filledQty = Math.min(o.qty, levels.reduce((sum, level) => sum + level.qty, 0));
        const entry = estimateSweep(levels, filledQty);
        if (now > o.signalAtMs + POLICY_ENTRY_LATENCY_MS + POLICY_MAX_ENTRY_DELAY_MS) {
          events.push({ ...o, status: "INVALID", exitAtMs: now, reason: "ENTRY_NOT_EXECUTABLE" });
          this.pending.delete(id);
          continue;
        }
        if (!entry || o.side * (entry.worstPx - entryCap) > 1e-9) {
          // A timely observed IOC non-fill is a zero-return attempt, not a
          // missing label. Keep it in evaluation to avoid conditioning on fills.
          events.push({ ...o, status: "COMPLETE", exitAtMs: now, grossBps: 0, netBps: 0,
            reason: "ENTRY_NOT_FILLED" });
          this.pending.delete(id);
          continue;
        }
        o.entryAtMs = now;
        o.entryPrice = entry.vwap;
        o.filledQty = filledQty;
      }
      const exit = estimateSweep(o.side === 1 ? book.bids : book.asks, o.filledQty);
      if (!exit) {
        events.push({ ...o, status: "INVALID", exitAtMs: now, reason: "EXIT_DEPTH_UNAVAILABLE" });
        this.pending.delete(id);
        continue;
      }
      const grossBps = o.side * (exit.vwap - o.entryPrice!) / o.entryPrice! * 10_000;
      const netBps = grossBps - o.feeBps * (1 + exit.vwap / o.entryPrice!) - o.reserveBps;
      if (!pending.exitReason) {
        const policy = findPolicy(o.policyId)!;
        if (policy.family === "BREAKOUT_RETEST") pending.protection ??= policyProtection(policy, o.feeBps, o.reserveBps);
        const broken = Number.isFinite(o.features.invalidationPx)
          && o.side * ((book.bids[0]!.px + book.asks[0]!.px) / 2 - o.features.invalidationPx!) < 0;
        const reason = broken ? "POLICY_STRUCTURE_INVALID"
          : policyExit(policy, grossBps, netBps, now - o.entryAtMs, pending.protection, o.features.policyVolatilityBps ?? 0);
        if (reason) { pending.exitReason = reason; pending.exitDueMs = now + POLICY_ENTRY_LATENCY_MS; }
      }
      if (pending.exitDueMs !== undefined && now >= pending.exitDueMs) {
        events.push({ ...o, status: "COMPLETE", exitAtMs: now, exitPrice: exit.vwap,
          grossBps: grossBps * o.filledQty / o.qty, netBps: netBps * o.filledQty / o.qty, reason: pending.exitReason! });
        this.pending.delete(id);
      }
    }
    if (!valid || !asset || now - this.lastSampleMs < POLICY_SAMPLE_MS) return events;
    this.lastSampleMs = now;
    for (const candidate of policyCandidates(features)) {
      if (candidate.side === -1 && !asset.shortable) continue;
      for (const policy of TRADING_POLICIES.filter((p) => p.family === candidate.family)) {
        if (this.pending.size >= 256) break;
        const signalAsk = book.asks[0]!.px, signalBid = book.bids[0]!.px;
        const qty = policyQuantity(candidate.side === 1 ? signalAsk : signalBid, asset);
        if (!(qty > 0)) continue;
        const observation: PolicyObservation = {
          sampling: "PERIODIC",
          ...candidate, id: randomUUID(), configurationVersion: this.configurationVersion,
          policyVersion: POLICY_VERSION, symbol: this.symbol, policyId: policy.id, signalAtMs: now,
          entryAtMs: null, exitAtMs: null, entryPrice: null, exitPrice: null,
          qty, filledQty: 0, signalBid, signalAsk,
          spreadBps: features.spreadBps, feeBps: this.feeBps, reserveBps: this.reserveBps,
          grossBps: null, netBps: null, status: "PENDING", reason: null,
          features: { trendFastBps: features.trendFastBps, trendMediumBps: features.trendMediumBps,
            trendSlowBps: features.trendSlowBps, slowTrendEfficiency: features.slowTrendEfficiency,
            ofi: features.ofi, tfi: features.tfi, velocityZ: features.velocityZ,
            ...(features.retestCandidate ? { invalidationPx: features.retestCandidate.invalidationPx,
              policyVolatilityBps: features.retestCandidate.volatilityBps } : {}) },
        };
        this.pending.set(observation.id, { observation, lastQuoteMs: now });
        events.push({ ...observation });
      }
    }
    return events;
  }

  /** Capture paired exits at the actual entry decision's quote and risk-sized
   * quantity. This never advances or waits for the periodic research clock. */
  public captureEntry(book: BookState, features: DeterministicFeatures, asset: AssetRules,
    candidate: PolicyCandidate, qty: number): PolicyObservation[] {
    if (!book.valid || features.stale || book.symbol !== this.symbol
      || book.receiveTsMs !== features.receiveTsMs || !book.bids[0] || !book.asks[0]
      || book.asks[0].px <= book.bids[0].px || (candidate.side === -1 && !asset.shortable)
      || !policyCandidates(features).some((c) => c.family === candidate.family && c.side === candidate.side && c.regime === candidate.regime)) return [];
    const policies = TRADING_POLICIES.filter((p) => p.family === candidate.family);
    const price = candidate.side === 1 ? book.asks[0].px : book.bids[0].px;
    if (!Number.isFinite(qty) || !(qty > 0) || !(asset.minTradeIncrement > 0)
      || qty < asset.minOrderSize || qty > policyQuantity(price, asset) + 1e-12
      || Math.abs(qty / asset.minTradeIncrement - Math.round(qty / asset.minTradeIncrement)) > 1e-8
      || this.pending.size + policies.length > 264) return [];
    const events = policies.map((policy): PolicyObservation => ({
      ...candidate, sampling: "ENTRY", id: randomUUID(), configurationVersion: this.configurationVersion,
      policyVersion: POLICY_VERSION, symbol: this.symbol, policyId: policy.id, signalAtMs: features.receiveTsMs,
      entryAtMs: null, exitAtMs: null, entryPrice: null, exitPrice: null, qty, filledQty: 0,
      signalBid: book.bids[0]!.px, signalAsk: book.asks[0]!.px, spreadBps: features.spreadBps,
      feeBps: this.feeBps, reserveBps: this.reserveBps, grossBps: null, netBps: null, status: "PENDING", reason: null,
      features: { trendFastBps: features.trendFastBps, trendMediumBps: features.trendMediumBps,
        trendSlowBps: features.trendSlowBps, slowTrendEfficiency: features.slowTrendEfficiency,
        ofi: features.ofi, tfi: features.tfi, velocityZ: features.velocityZ,
        ...(features.retestCandidate ? { invalidationPx: features.retestCandidate.invalidationPx,
          policyVolatilityBps: features.retestCandidate.volatilityBps } : {}) },
    }));
    for (const observation of events) this.pending.set(observation.id,
      { observation: { ...observation }, lastQuoteMs: features.receiveTsMs });
    return events;
  }

  public invalidate(now: number, reason: string): PolicyObservation[] {
    const observations = [...this.pending.values()].map(({ observation }) =>
      ({ ...observation, status: "INVALID" as const, exitAtMs: now, reason }));
    this.pending.clear();
    return observations;
  }
}
