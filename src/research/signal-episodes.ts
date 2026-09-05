import { randomUUID } from "node:crypto";
import type { BookState } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { PolicyObservation } from "./policy-collector.js";
import { policyCandidates, policyQuantity, TRADING_POLICIES, POLICY_VERSION } from "./trading-policy.js";
import { EXECUTION_SCENARIOS, ExecutionStressCase, stressObservation,
  type EpisodeContext, type EpisodeObservation } from "./execution-stress.js";

export const EPISODE_RULES = Object.freeze({ sampleMs: 5_000, quoteGapMs: 5_000,
  quietResetMs: 5_000, minimumSpacingMs: 60_000, confirmationMs: 2_000,
  minimumConfirmationQuotes: 3, minimumTrendEfficiency: .15, maximumPending: 256 });
export const EPISODE_HYPOTHESES = ["current-breakout", "range-5m-confirmed", "range-15m-confirmed", "breakout-retest"] as const;
interface Point { at: number; mid: number }
interface Arm { at: number; boundary: number; quotes: number }
interface Seen { lastSeenMs: number; lastCapturedMs: number }

/** Shadow research only. Uses fresh quotes before execution cooldown/exposure
 * gates; its candidates cannot reach the execution planner or model installer. */
export class SignalEpisodeCollector {
  private readonly cases = new Map<string, ExecutionStressCase>();
  private readonly seen = new Map<string, Seen>();
  private readonly arms = new Map<string, Arm>();
  private history: Point[] = [];
  private lastQuoteMs?: number;
  private lastSequence?: bigint;
  private counters = { episodes: 0, completed: 0, invalid: 0, capacityRejected: 0 };
  public constructor(private readonly configurationVersion: string, private readonly symbol: string,
    private readonly feeBps: number, private readonly reserveBps: number) {
    if (![feeBps, reserveBps].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Invalid episode costs");
  }
  public stats(): Record<string, number> { return { ...this.counters, pending: this.cases.size }; }

  public invalidate(now: number, reason: string): EpisodeObservation[] {
    const outcomes = [...this.cases.values()].flatMap((c) => c.invalidate(now, reason) ?? []);
    this.counters.invalid += outcomes.length;
    this.cases.clear(); this.arms.clear(); this.history = [];
    // Keep episode spacing across a feed gap; rebuilding history is mandatory.
    delete this.lastQuoteMs;
    delete this.lastSequence;
    return outcomes;
  }

  public observe(book: BookState, f: DeterministicFeatures, asset: AssetRules | undefined,
    contexts: { long: EpisodeContext; short: EpisodeContext }): EpisodeObservation[] {
    const now = book.receiveTsMs;
    if (book.symbol !== this.symbol) return [];
    if (!book.valid || f.stale || f.symbol !== this.symbol || !Number.isFinite(now) || now !== f.receiveTsMs || !book.bids[0] || !book.asks[0]
      || ![f.mid, f.spreadBps, f.trendFastBps, f.trendMediumBps, f.trendSlowBps, f.slowTrendEfficiency, f.ofi, f.tfi].every(Number.isFinite)
      || f.mid <= 0 || f.spreadBps < 0
      || book.bids[0].px >= book.asks[0].px || (this.lastQuoteMs !== undefined
        && (now < this.lastQuoteMs || now - this.lastQuoteMs > EPISODE_RULES.quoteGapMs))) {
      return this.invalidate(Number.isFinite(now) ? now : this.lastQuoteMs ?? 0, "RESEARCH_QUOTE_GAP");
    }
    const duplicateQuote = this.lastQuoteMs === now && this.lastSequence === book.sequence;
    this.lastQuoteMs = now;
    this.lastSequence = book.sequence;
    const events: EpisodeObservation[] = [];
    for (const [id, c] of this.cases) {
      const outcome = c.observe(book, f.stale);
      if (outcome) {
        events.push(outcome); this.cases.delete(id);
        if (outcome.status === "COMPLETE") this.counters.completed++; else this.counters.invalid++;
      }
    }
    if (duplicateQuote) return events;
    const candidates: Array<{ hypothesisId: string; side: 1 | -1; boundary?: number }> = [];
    if (f.retestCandidate) candidates.push({ hypothesisId: "breakout-retest", side: f.retestCandidate.side,
      boundary: f.retestCandidate.boundary });
    if (asset?.symbol === this.symbol && f.warmedUp && f.kinematicsReady && f.slowTrendReady) {
      const { retestCandidate: _retest, ...legacyFeatures } = f;
      for (const candidate of policyCandidates(legacyFeatures).filter((c) => c.family === "EARLY_BREAKOUT")) {
        candidates.push({ hypothesisId: "current-breakout", side: candidate.side });
      }
      for (const minutes of [5, 15]) for (const side of [1, -1] as const) {
        const hypothesisId = `range-${minutes}m-confirmed`, key = `${hypothesisId}:${side}`;
        const context = side === 1 ? contexts.long : contexts.short;
        const aligned = [f.trendFastBps, f.trendMediumBps, f.trendSlowBps].every((v) => side * v > 0)
          && f.slowTrendEfficiency >= EPISODE_RULES.minimumTrendEfficiency && side * f.ofi >= .3 && side * f.tfi >= .15
          && context.healthAllowed && context.liquidityPass;
        if (!aligned) { this.arms.delete(key); continue; }
        const arm = this.arms.get(key);
        if (arm) {
          if (side * (f.mid - arm.boundary) <= 0) { this.arms.delete(key); continue; }
          arm.quotes++;
          if (now - arm.at >= EPISODE_RULES.confirmationMs && arm.quotes >= EPISODE_RULES.minimumConfirmationQuotes) {
            candidates.push({ hypothesisId, side, boundary: arm.boundary });
          }
          continue;
        }
        const window = this.history.filter((p) => p.at >= now - minutes * 60_000 && p.at < now);
        if (!window.length || now - window[0]!.at < minutes * 60_000 - EPISODE_RULES.sampleMs) continue;
        const high = Math.max(...window.map((p) => p.mid)), low = Math.min(...window.map((p) => p.mid));
        // Range width is a causal opportunity filter, NOT a predicted return.
        if ((high - low) / f.mid * 10_000 < 2 * this.feeBps + this.reserveBps + f.spreadBps) continue;
        const boundary = side === 1 ? high : low;
        if (side * (f.mid - boundary) >= f.mid * Math.max(f.spreadBps, 1) / 10_000) {
          this.arms.set(key, { at: now, boundary, quotes: 1 });
        }
      }
    }
    // Only past samples may define a range. Never insert the current quote first.
    if (!this.history.length || now - this.history.at(-1)!.at >= EPISODE_RULES.sampleMs) {
      this.history.push({ at: now, mid: f.mid });
      this.history = this.history.filter((p) => p.at >= now - 15 * 60_000 - EPISODE_RULES.sampleMs);
    }
    for (const candidate of candidates) {
      const context = candidate.side === 1 ? contexts.long : contexts.short;
      if (!asset || (candidate.side === -1 && !asset.shortable) || !context.healthAllowed || !context.liquidityPass) continue;
      const key = `${candidate.hypothesisId}:${candidate.side}`, prior = this.seen.get(key);
      const quiet = !prior || now - prior.lastSeenMs >= EPISODE_RULES.quietResetMs;
      this.seen.set(key, { lastSeenMs: now, lastCapturedMs: prior?.lastCapturedMs ?? -Infinity });
      if (!quiet || (prior && now - prior.lastCapturedMs < EPISODE_RULES.minimumSpacingMs)) continue;
      const qty = policyQuantity(candidate.side === 1 ? book.asks[0].px : book.bids[0].px, asset);
      if (!(qty > 0)) continue;
      this.seen.get(key)!.lastCapturedMs = now;
      const episodeId = randomUUID();
      this.counters.episodes++;
      const family = candidate.hypothesisId === "breakout-retest" ? "BREAKOUT_RETEST" : "EARLY_BREAKOUT";
      const policies = TRADING_POLICIES.filter((p) => p.family === family);
      const capacity = this.cases.size + policies.length * EXECUTION_SCENARIOS.length <= EPISODE_RULES.maximumPending;
      for (const policy of policies) {
        const source: PolicyObservation = { id: randomUUID(), sampling: "EPISODE", configurationVersion: this.configurationVersion,
          policyVersion: POLICY_VERSION, symbol: this.symbol, family, side: candidate.side,
          regime: candidate.side === 1 ? "BREAKOUT_UP" : "BREAKOUT_DOWN", policyId: policy.id,
          signalAtMs: now, signalBid: book.bids[0].px, signalAsk: book.asks[0].px, spreadBps: f.spreadBps,
          qty, filledQty: 0, entryAtMs: null, exitAtMs: null, entryPrice: null, exitPrice: null,
          feeBps: this.feeBps, reserveBps: this.reserveBps, grossBps: null, netBps: null, status: "PENDING", reason: null,
          features: { impulseBps: f.impulseBps, breakoutUpBps: f.breakoutUpBps, breakoutDownBps: f.breakoutDownBps,
            trendFastBps: f.trendFastBps, trendMediumBps: f.trendMediumBps, trendSlowBps: f.trendSlowBps,
            slowTrendEfficiency: f.slowTrendEfficiency, ofi: f.ofi, tfi: f.tfi, velocityZ: f.velocityZ,
            ...(candidate.boundary === undefined ? {} : { rangeBoundary: candidate.boundary }),
            ...(family === "BREAKOUT_RETEST" && f.retestCandidate ? { invalidationPx: f.retestCandidate.invalidationPx,
              policyVolatilityBps: f.retestCandidate.volatilityBps } : {}) } };
        for (const scenario of EXECUTION_SCENARIOS) {
          const start = stressObservation(source, scenario, episodeId, candidate.hypothesisId, context);
          const c = new ExecutionStressCase(start);
          if (capacity) { this.cases.set(start.id, c); events.push(start); }
          else { events.push(c.invalidate(now, "RESEARCH_CAPACITY")!); this.counters.capacityRejected++; this.counters.invalid++; }
        }
      }
    }
    return events;
  }
}
