import type { BookState, MarketTrade } from "../core/market.js";
import { DISTRIBUTION_SPEC } from "./spec.js";

export const DISTRIBUTION_LOOKBACK_MS = 30 * 60_000;
export const DISTRIBUTION_PRICE_SAMPLE_MS = 10_000;
export const DISTRIBUTION_MAXIMUM_PRICE_GAP_MS = 90_000;
export const DISTRIBUTION_FLOW_WARM_MS = 30_000;
export const DISTRIBUTION_MARKET_HISTORY_VERSION = "btc-eth-market-history-v1";
const LOOKBACK_MS = DISTRIBUTION_LOOKBACK_MS, SAMPLE_MS = DISTRIBUTION_PRICE_SAMPLE_MS, FLOW_DECAY_MS = 30_000;
const MAXIMUM_PRICE_GAP_MS = DISTRIBUTION_MAXIMUM_PRICE_GAP_MS, FLOW_WARM_MS = DISTRIBUTION_FLOW_WARM_MS;
const MAXIMUM_PRICE_SAMPLES = Math.ceil(LOOKBACK_MS / SAMPLE_MS) + 2;
const bound = (n: number): number => Math.max(-1, Math.min(1, n));
const supported = (symbol: string): boolean => DISTRIBUTION_SPEC.symbols.some(s => s === symbol);

/** Fixed scales, specified before fitting. Returns are simple returns in basis points;
 * volatility is a 30-minute variance-rate proxy from actual elapsed-time log returns.
 * Both flow measures use a 30-second exponential time constant, not event counts. */
export const DISTRIBUTION_FEATURES = Object.freeze([
  "top5_quantity_imbalance", "ofi_30s_over_absolute_flow_and_top_depth",
  "aggressor_30s_over_trade_quantity_and_top_depth", "microprice_minus_mid_over_half_spread",
  "log1p_top5_usd_depth_over_log1p_10million", "elapsed_time_volatility_proxy_30m_over_100bps",
  "return_5m_over_50bps", "return_15m_over_100bps", "return_30m_over_150bps",
  "peer_return_15m_over_100bps", "own_minus_peer_return_15m_over_100bps", "signed_efficiency_30m",
] as const);

/** Validation is shared by the market state and executable outcome simulator. */
export function distributionBookReason(book: BookState): string | null {
  if (!supported(book.symbol)) return "UNSUPPORTED_SYMBOL";
  // Kraken emits a complete depth snapshot for each normal buffered book.
  // sourceReset describes image replacement, not a disconnect or bad book.
  if (!book.valid) return "BOOK_INVALID";
  if (!Number.isFinite(book.receiveTsMs) || !Number.isFinite(book.exchangeTsMs)
    || book.receiveTsMs < 0 || book.exchangeTsMs < 0) return "INVALID_TIMESTAMP";
  const age = book.receiveTsMs - book.exchangeTsMs;
  if (age < 0 || age > DISTRIBUTION_SPEC.maximumQuoteAgeMs) return "STALE_PROVIDER_QUOTE";
  if (typeof book.sequence !== "bigint" || book.sequence < 0n) return "INVALID_SEQUENCE";
  if (!book.bids.length || !book.asks.length) return "EMPTY_DEPTH";
  for (const [levels, ascending] of [[book.bids, false], [book.asks, true]] as const) {
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      if (!Number.isFinite(level.px) || level.px <= 0 || !Number.isFinite(level.qty) || level.qty <= 0
        || !Number.isFinite(level.px * level.qty)) return "INVALID_DEPTH";
      if (i > 0 && (ascending ? levels[i - 1]!.px >= level.px : levels[i - 1]!.px <= level.px)) return "UNORDERED_DEPTH";
    }
  }
  return book.bids[0]!.px >= book.asks[0]!.px ? "CROSSED_BOOK" : null;
}

export interface DistributionPriceSample { atMs: number; mid: number }
type PriceSample = DistributionPriceSample;
/** Only observed price endpoints are portable. Quotes and flow always restart live. */
export interface DistributionMarketHistory {
  version: typeof DISTRIBUTION_MARKET_HISTORY_VERSION;
  symbols: Array<{ symbol: string; lastBookAtMs: number; samples: DistributionPriceSample[] }>;
}
export interface DistributionMarketRestoreResult {
  restoredSymbols: string[]; restoredSamples: number;
  rejectedSymbols: Array<{ symbol: string; reason: string }>;
}
export interface DistributionMarketHistoryStats {
  sampleCount: number; restoredSampleCount: number; oldestAtMs: number | null; latestAtMs: number | null;
  coverageMs: number; remainingMs: number; flowCoverageMs: number; flowRemainingMs: number;
  ready: boolean; reason: string;
}
interface SymbolState {
  book: BookState | null; samples: PriceSample[];
  ofi: number; absoluteOfi: number; ofiAtMs: number | null;
  tradeFlow: number; tradeVolume: number; tradeAtMs: number | null;
  lastTradeAtMs: number | null; tradeIds: Map<string, number>;
  lastCleanBookAtMs: number | null; flowStartedAtMs: number | null;
  restoredUntilMs: number | null;
}
export interface DistributionMarketSnapshot {
  symbol: string; atMs: number; features: number[]; ready: boolean; reason: string;
}
const emptyState = (): SymbolState => ({ book: null, samples: [], ofi: 0, absoluteOfi: 0,
  ofiAtMs: null, tradeFlow: 0, tradeVolume: 0, tradeAtMs: null, lastTradeAtMs: null, tradeIds: new Map(),
  lastCleanBookAtMs: null, flowStartedAtMs: null, restoredUntilMs: null });

export class DistributionMarket {
  private readonly states = new Map<string, SymbolState>();

  exportHistory(): DistributionMarketHistory {
    return { version: DISTRIBUTION_MARKET_HISTORY_VERSION, symbols: DISTRIBUTION_SPEC.symbols.flatMap(symbol => {
      const state = this.states.get(symbol);
      return state?.samples.length && state.lastCleanBookAtMs !== null
        ? [{ symbol, lastBookAtMs: state.lastCleanBookAtMs, samples: state.samples.map(sample => ({ ...sample })) }] : [];
    }) };
  }

  /** Validate the entire document before changing state. Stale symbols are reported
   * and skipped; corrupt/future data reject the document without any mutation. */
  restoreHistory(value: unknown, cutoffMs: number): DistributionMarketRestoreResult {
    const fail = (reason: string): never => { throw new Error(`Invalid distribution market history: ${reason}`); };
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) fail("cutoff timestamp");
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("document");
    const document = value as Record<string, unknown>;
    if (document.version !== DISTRIBUTION_MARKET_HISTORY_VERSION || !Array.isArray(document.symbols)
      || document.symbols.length > DISTRIBUTION_SPEC.symbols.length) fail("version or symbols");
    const staged = new Map<string, SymbolState>();
    const result: DistributionMarketRestoreResult = { restoredSymbols: [], restoredSamples: 0, rejectedSymbols: [] };
    const seen = new Set<string>();
    for (const entry of document.symbols as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("symbol entry");
      const row = entry as Record<string, unknown>;
      if (typeof row.symbol !== "string" || !supported(row.symbol) || seen.has(row.symbol)) fail("unsupported or duplicate symbol");
      const symbol = row.symbol as string; seen.add(symbol);
      if (typeof row.lastBookAtMs !== "number" || !Number.isSafeInteger(row.lastBookAtMs) || row.lastBookAtMs < 0
        || row.lastBookAtMs > cutoffMs) fail(`${symbol} future or invalid book timestamp`);
      const lastBookAtMs = row.lastBookAtMs as number;
      if (!Array.isArray(row.samples) || !row.samples.length || row.samples.length > MAXIMUM_PRICE_SAMPLES) fail(`${symbol} sample count`);
      const samples: PriceSample[] = [];
      for (const point of row.samples as unknown[]) {
        if (!point || typeof point !== "object" || Array.isArray(point)) fail(`${symbol} sample`);
        const sample = point as Record<string, unknown>;
        if (typeof sample.atMs !== "number" || !Number.isSafeInteger(sample.atMs) || sample.atMs < 0
          || sample.atMs > lastBookAtMs || typeof sample.mid !== "number" || !Number.isFinite(sample.mid) || sample.mid <= 0)
          fail(`${symbol} future or invalid sample`);
        const atMs = sample.atMs as number, mid = sample.mid as number, prior = samples.at(-1);
        // A valid 90-second book gap can start up to 9,999 ms after the previous
        // sampled price. Preserve those actual endpoints without inventing data.
        if (prior && (atMs - prior.atMs < SAMPLE_MS || atMs - prior.atMs >= MAXIMUM_PRICE_GAP_MS + SAMPLE_MS))
          fail(`${symbol} sample spacing`);
        samples.push({ atMs, mid });
      }
      if (lastBookAtMs - samples.at(-1)!.atMs >= SAMPLE_MS) fail(`${symbol} missing latest sample`);
      // The live sampler retains exactly one predecessor of the lookback boundary.
      if (samples.length > 1 && samples[1]!.atMs <= samples.at(-1)!.atMs - LOOKBACK_MS) fail(`${symbol} excess history`);
      if (samples.at(-1)!.atMs - samples[0]!.atMs >= LOOKBACK_MS + MAXIMUM_PRICE_GAP_MS + SAMPLE_MS) fail(`${symbol} history span`);
      if (cutoffMs - lastBookAtMs > MAXIMUM_PRICE_GAP_MS) {
        result.rejectedSymbols.push({ symbol, reason: "HISTORY_STALE" }); continue;
      }
      staged.set(symbol, { ...emptyState(), samples, lastCleanBookAtMs: lastBookAtMs, restoredUntilMs: samples.at(-1)!.atMs });
      result.restoredSymbols.push(symbol); result.restoredSamples += samples.length;
    }
    for (const [symbol, state] of staged) this.states.set(symbol, state);
    return result;
  }

  /** Cheap progress telemetry: no feature calculation and no synthetic prices. */
  historyStats(symbol: string, nowMs: number): DistributionMarketHistoryStats {
    const state = this.states.get(symbol), oldestAtMs = state?.samples[0]?.atMs ?? null;
    const latestAtMs = state?.samples.at(-1)?.atMs ?? null;
    const observedAtMs = Math.min(Number.isFinite(nowMs) ? nowMs : 0, state?.lastCleanBookAtMs ?? 0);
    const coverageMs = oldestAtMs === null ? 0 : Math.max(0, Math.min(LOOKBACK_MS, observedAtMs - oldestAtMs));
    const flowCoverageMs = state?.flowStartedAtMs == null ? 0 : Math.max(0, Math.min(FLOW_WARM_MS, observedAtMs - state.flowStartedAtMs));
    const reason = this.readinessReason(symbol, nowMs);
    return { sampleCount: state?.samples.length ?? 0,
      restoredSampleCount: state?.restoredUntilMs == null ? 0 : state.samples.filter(sample => sample.atMs <= state.restoredUntilMs!).length,
      oldestAtMs, latestAtMs, coverageMs, remainingMs: LOOKBACK_MS - coverageMs,
      flowCoverageMs, flowRemainingMs: FLOW_WARM_MS - flowCoverageMs, ready: reason === "READY", reason };
  }

  invalidate(symbol?: string): void {
    if (symbol === undefined) this.states.clear();
    else this.states.delete(symbol);
  }

  /** A transport disconnect invalidates executable quotes and live flow, not
   * recently observed price endpoints. Repeated disconnects cannot extend their
   * age; the first returning book rechecks the gap from the last clean book. */
  onDisconnect(atMs: number): void {
    for (const [symbol, state] of this.states) {
      if (!Number.isSafeInteger(atMs) || state.lastCleanBookAtMs === null
        || atMs < state.lastCleanBookAtMs || atMs - state.lastCleanBookAtMs > MAXIMUM_PRICE_GAP_MS) {
        this.states.delete(symbol);
        continue;
      }
      this.states.set(symbol, { ...emptyState(), samples: state.samples,
        lastCleanBookAtMs: state.lastCleanBookAtMs, restoredUntilMs: state.restoredUntilMs });
    }
  }

  onBook(book: BookState, calculateFeatures = true): DistributionMarketSnapshot | null {
    if (!supported(book.symbol)) return null;
    const invalid = distributionBookReason(book);
    if (invalid) {
      const prior = this.states.get(book.symbol);
      // A brief interruption leaves observed endpoints useful for return features,
      // but it never leaves a quote or order-flow state usable for a decision.
      if (prior && Number.isFinite(book.receiveTsMs) && prior.lastCleanBookAtMs !== null
        && book.receiveTsMs >= prior.lastCleanBookAtMs && book.receiveTsMs - prior.lastCleanBookAtMs <= MAXIMUM_PRICE_GAP_MS)
        this.states.set(book.symbol, { ...emptyState(), samples: prior.samples, lastCleanBookAtMs: prior.lastCleanBookAtMs,
          restoredUntilMs: prior.restoredUntilMs });
      else this.invalidate(book.symbol);
      return this.notReady(book.symbol, book.receiveTsMs, invalid);
    }
    let state = this.states.get(book.symbol) ?? emptyState();
    const previous = state.book;
    if (previous && (book.receiveTsMs < previous.receiveTsMs || book.exchangeTsMs < previous.exchangeTsMs
      || book.sequence < previous.sequence)) {
      this.invalidate(book.symbol); return this.notReady(book.symbol, book.receiveTsMs, "REVERSED_BOOK");
    }
    if (previous && book.sequence === previous.sequence) {
      // Repeated snapshots cannot refresh provider time or extend price history.
      return calculateFeatures ? this.snapshot(book.symbol, book.receiveTsMs) : null;
    }
    if (state.lastCleanBookAtMs !== null && book.receiveTsMs < state.lastCleanBookAtMs) {
      this.invalidate(book.symbol); return this.notReady(book.symbol, book.receiveTsMs, "REVERSED_BOOK");
    }
    const gap = state.lastCleanBookAtMs === null ? 0 : book.receiveTsMs - state.lastCleanBookAtMs;
    if (gap > MAXIMUM_PRICE_GAP_MS) state = emptyState();
    else if (gap > DISTRIBUTION_SPEC.maximumQuoteGapMs) state = { ...emptyState(), samples: state.samples, restoredUntilMs: state.restoredUntilMs };
    const prior = state.book;
    if (prior) {
      const bid = book.bids[0]!, ask = book.asks[0]!, oldBid = prior.bids[0]!, oldAsk = prior.asks[0]!;
      const ofi = (bid.px >= oldBid.px ? bid.qty : 0) - (bid.px <= oldBid.px ? oldBid.qty : 0)
        - (ask.px <= oldAsk.px ? ask.qty : 0) + (ask.px >= oldAsk.px ? oldAsk.qty : 0);
      const decay = Math.exp(-(book.receiveTsMs - (state.ofiAtMs ?? book.receiveTsMs)) / FLOW_DECAY_MS);
      state.ofi = state.ofi * decay + ofi; state.absoluteOfi = state.absoluteOfi * decay + Math.abs(ofi);
    }
    state.ofiAtMs = book.receiveTsMs;
    state.lastCleanBookAtMs = book.receiveTsMs; state.flowStartedAtMs ??= book.receiveTsMs;
    // Full incoming depth was validated above; private feature state only uses
    // top five levels (OFI uses top one). Execution keeps the original full book.
    // Copy these levels because adapters may subsequently reuse their arrays.
    state.book = { ...book, bids: book.bids.slice(0, 5).map(l => ({ ...l })), asks: book.asks.slice(0, 5).map(l => ({ ...l })) };
    const lastSample = state.samples.at(-1);
    if (!lastSample || book.receiveTsMs - lastSample.atMs >= SAMPLE_MS) {
      state.samples.push({ atMs: book.receiveTsMs, mid: (book.bids[0]!.px + book.asks[0]!.px) / 2 });
      // Preserve the latest predecessor of the 30-minute boundary, without interpolation.
      while (state.samples.length > 1 && state.samples[1]!.atMs <= book.receiveTsMs - LOOKBACK_MS) state.samples.shift();
    }
    this.states.set(book.symbol, state);
    return calculateFeatures ? this.snapshot(book.symbol, book.receiveTsMs) : null;
  }

  onTrade(trade: MarketTrade): void {
    if (!supported(trade.symbol)) return;
    const state = this.states.get(trade.symbol);
    if (!state?.book || !Number.isFinite(trade.px) || trade.px <= 0 || !Number.isFinite(trade.qty) || trade.qty <= 0
      || !Number.isFinite(trade.receiveTsMs) || !Number.isFinite(trade.exchangeTsMs)
      || trade.exchangeTsMs > trade.receiveTsMs || trade.receiveTsMs - trade.exchangeTsMs > DISTRIBUTION_SPEC.maximumQuoteAgeMs
      || trade.receiveTsMs < state.book.receiveTsMs || (trade.aggressor !== 1 && trade.aggressor !== -1)
      || !trade.id || (state.lastTradeAtMs !== null && trade.receiveTsMs < state.lastTradeAtMs)) return;
    if (state.tradeIds.has(trade.id)) return;
    // Accepted trade timestamps are monotonic; Map insertion order therefore
    // places all expired identifiers before the first retained identifier.
    for (const [id, atMs] of state.tradeIds) {
      if (trade.receiveTsMs - atMs <= 5 * FLOW_DECAY_MS) break;
      state.tradeIds.delete(id);
    }
    // A bounded deduplication window prevents repeated feed messages inflating flow.
    if (state.tradeIds.size >= 4096) state.tradeIds.delete(state.tradeIds.keys().next().value!);
    state.tradeIds.set(trade.id, trade.receiveTsMs);
    const decay = Math.exp(-(trade.receiveTsMs - (state.tradeAtMs ?? trade.receiveTsMs)) / FLOW_DECAY_MS);
    state.tradeFlow = state.tradeFlow * decay + trade.qty * trade.aggressor;
    state.tradeVolume = state.tradeVolume * decay + trade.qty;
    state.tradeAtMs = trade.receiveTsMs; state.lastTradeAtMs = trade.receiveTsMs;
  }

  snapshot(symbol: string, nowMs: number): DistributionMarketSnapshot | null {
    if (!supported(symbol)) return null;
    const reason = this.readinessReason(symbol, nowMs);
    if (reason !== "READY") return this.notReady(symbol, nowMs, reason);
    const state = this.states.get(symbol)!, peerSymbol = symbol === "BTC/USD" ? "ETH/USD" : "BTC/USD";
    const peer = this.states.get(peerSymbol)!;
    const book = state.book!, bid = book.bids[0]!, ask = book.asks[0]!;
    const mid = (bid.px + ask.px) / 2, peerMid = (peer.book!.bids[0]!.px + peer.book!.asks[0]!.px) / 2;
    const bidQty = book.bids.slice(0, 5).reduce((sum, l) => sum + l.qty, 0);
    const askQty = book.asks.slice(0, 5).reduce((sum, l) => sum + l.qty, 0);
    const usdDepth = [...book.bids.slice(0, 5), ...book.asks.slice(0, 5)].reduce((sum, l) => sum + l.px * l.qty, 0);
    const ret = (s: SymbolState, price: number, minutes: number): number => (price / this.previous(s, nowMs - minutes * 60_000)!.mid - 1) * 10_000;
    const own15 = ret(state, mid, 15), peer15 = ret(peer, peerMid, 15);
    const path = state.samples.filter(p => p.atMs >= nowMs - LOOKBACK_MS);
    if (state.samples.at(-1)!.atMs !== nowMs) path.push({ atMs: nowMs, mid });
    let squared = 0, absolute = 0, total = 0;
    for (let i = 1; i < path.length; i++) {
      const change = Math.log(path[i]!.mid / path[i - 1]!.mid), elapsed = path[i]!.atMs - path[i - 1]!.atMs;
      squared += change * change / elapsed; absolute += Math.abs(change); total += change;
    }
    const ofiDecay = Math.exp(-(nowMs - (state.ofiAtMs ?? nowMs)) / FLOW_DECAY_MS);
    const tradeDecay = Math.exp(-(nowMs - (state.tradeAtMs ?? nowMs)) / FLOW_DECAY_MS);
    // The depth anchor makes old, unrefreshed trade information decay toward zero.
    const topDepth = bid.qty + ask.qty;
    const raw = [
      (bidQty - askQty) / (bidQty + askQty), state.ofi * ofiDecay / (state.absoluteOfi * ofiDecay + topDepth),
      state.tradeFlow * tradeDecay / (state.tradeVolume * tradeDecay + topDepth),
      (((ask.px * bid.qty + bid.px * ask.qty) / topDepth) - mid) / ((ask.px - bid.px) / 2),
      Math.log1p(usdDepth) / Math.log1p(10_000_000), Math.sqrt(squared / Math.max(1, path.length - 1) * LOOKBACK_MS) * 10_000 / 100,
      ret(state, mid, 5) / 50, own15 / 100, ret(state, mid, 30) / 150,
      peer15 / 100, (own15 - peer15) / 100, absolute > 0 ? total / absolute : 0,
    ];
    if (!raw.every(Number.isFinite)) return this.notReady(symbol, nowMs, "NON_FINITE_FEATURES");
    const features = raw.map(bound);
    return { symbol, atMs: nowMs, features, ready: true, reason: "READY" };
  }

  private readinessReason(symbol: string, nowMs: number): string {
    if (!supported(symbol)) return "UNSUPPORTED_SYMBOL";
    const state = this.states.get(symbol), peer = this.states.get(symbol === "BTC/USD" ? "ETH/USD" : "BTC/USD");
    if (!Number.isFinite(nowMs) || !state?.book) return "BOOK_NOT_READY";
    if (nowMs < state.book.receiveTsMs || (state.lastTradeAtMs !== null && nowMs < state.lastTradeAtMs)
      || nowMs - state.book.exchangeTsMs > DISTRIBUTION_SPEC.maximumQuoteAgeMs) return "STALE_BOOK";
    if (!peer?.book || nowMs < peer.book.receiveTsMs || nowMs - peer.book.exchangeTsMs > DISTRIBUTION_SPEC.maximumPeerAgeMs)
      return "PEER_NOT_SYNCHRONIZED";
    if (!this.previous(state, nowMs - LOOKBACK_MS) || !this.previous(peer, nowMs - LOOKBACK_MS)) return "WARMING_30_MINUTES";
    if (state.flowStartedAtMs === null || nowMs - state.flowStartedAtMs < FLOW_WARM_MS
      || peer.flowStartedAtMs === null || nowMs - peer.flowStartedAtMs < FLOW_WARM_MS) return "WARMING_FLOW_30_SECONDS";
    return "READY";
  }

  private previous(state: SymbolState, atMs: number): PriceSample | undefined {
    for (let i = state.samples.length - 1; i >= 0; i--) if (state.samples[i]!.atMs <= atMs) return state.samples[i];
    return undefined;
  }
  private notReady(symbol: string, atMs: number, reason: string): DistributionMarketSnapshot {
    return { symbol, atMs, features: [], ready: false, reason };
  }
}
