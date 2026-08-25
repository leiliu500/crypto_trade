import type { SlowTrendObservation } from "../strategy/deterministic-features.js";
import type { AlpacaBar, AlpacaOrderbook, AlpacaSnapshot } from "./types.js";
import type { AlpacaRestClient } from "./rest.js";

type MarketHistoryRestClient = Pick<AlpacaRestClient, "bars" | "latestOrderbooks" | "snapshots">;

interface BarsPayload {
  bars?: Record<string, AlpacaBar[]>;
}

/**
 * Loads completed one-minute closes and anchors them to a current venue midpoint.
 * The L2 book is preferred and a snapshot quote/trade is the fallback, so stale
 * bars alone can never make restored structural features pass the freshness gate.
 */
export async function loadVenueSlowTrendHistory(rest: MarketHistoryRestClient, symbols: readonly string[],
  sinceMs: number, asOfMs: number): Promise<ReadonlyMap<string, readonly SlowTrendObservation[]>> {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(asOfMs) || sinceMs > asOfMs) {
    throw new Error("Invalid venue market-history interval");
  }
  const requested = [...new Set(symbols.filter((symbol) => symbol.trim().length > 0))];
  if (requested.length === 0) return new Map();
  const [historicalResult, orderbooksResult, snapshotsResult] = await Promise.allSettled([
    rest.bars({ symbols: requested.join(","), start: new Date(sinceMs).toISOString(),
      end: new Date(asOfMs).toISOString(), timeframe: "1Min", limit: 10_000, sort: "asc" }),
    rest.latestOrderbooks(requested), rest.snapshots(requested),
  ]);
  if (historicalResult.status === "rejected") throw historicalResult.reason;
  if (orderbooksResult.status === "rejected" && snapshotsResult.status === "rejected") {
    throw new AggregateError([orderbooksResult.reason, snapshotsResult.reason], "Alpaca current market anchors were unavailable");
  }
  // The current midpoint can legitimately be newer than the historical query
  // boundary because it was received causally while startup requests were in flight.
  const receivedAtMs = Date.now();
  const bars = historicalResult.value.data as BarsPayload;
  if (!bars || typeof bars !== "object" || !bars.bars || typeof bars.bars !== "object") {
    throw new Error("Alpaca historical bars response did not contain bars");
  }
  const orderbooks = orderbooksResult.status === "fulfilled" ? orderbooksResult.value.data.orderbooks : {};
  const snapshots = snapshotsResult.status === "fulfilled" ? snapshotsResult.value.data.snapshots : {};
  const result = new Map<string, readonly SlowTrendObservation[]>();
  for (const symbol of requested) {
    const observations: SlowTrendObservation[] = [];
    for (const bar of bars.bars[symbol] ?? []) {
      const openedAtMs = Date.parse(bar.t);
      const knownAtMs = openedAtMs + 60_000;
      if (Number.isFinite(openedAtMs) && knownAtMs >= sinceMs && knownAtMs <= asOfMs
        && Number.isFinite(bar.c) && bar.c > 0) observations.push({ atMs: knownAtMs, mid: bar.c });
    }
    const latest = orderbookObservation(orderbooks[symbol], receivedAtMs)
      ?? snapshotObservation(snapshots[symbol], receivedAtMs);
    if (latest && latest.atMs >= sinceMs) observations.push(latest);
    observations.sort((left, right) => left.atMs - right.atMs);
    const deduplicated = observations.filter((point, index) => index === observations.length - 1
      || point.atMs !== observations[index + 1]!.atMs);
    result.set(symbol, deduplicated);
  }
  return result;
}

function orderbookObservation(book: AlpacaOrderbook | undefined, receivedAtMs: number): SlowTrendObservation | undefined {
  const atMs = book ? Date.parse(book.t) : NaN;
  if (!book || !Number.isFinite(atMs) || atMs > receivedAtMs) return undefined;
  const bids = book.b.filter((level) => Number.isFinite(level.p) && level.p > 0 && Number.isFinite(level.s) && level.s > 0);
  const asks = book.a.filter((level) => Number.isFinite(level.p) && level.p > 0 && Number.isFinite(level.s) && level.s > 0);
  const bid = bids.reduce((best, level) => Math.max(best, level.p), Number.NEGATIVE_INFINITY);
  const ask = asks.reduce((best, level) => Math.min(best, level.p), Number.POSITIVE_INFINITY);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid < ask ? { atMs, mid: (bid + ask) / 2 } : undefined;
}

function snapshotObservation(snapshot: AlpacaSnapshot | undefined, asOfMs: number): SlowTrendObservation | undefined {
  const quote = snapshot?.latestQuote;
  const quoteAtMs = quote ? Date.parse(quote.t) : NaN;
  if (quote && Number.isFinite(quoteAtMs) && quoteAtMs <= asOfMs
    && Number.isFinite(quote.bp) && Number.isFinite(quote.ap) && quote.bp > 0 && quote.ap > quote.bp) {
    return { atMs: quoteAtMs, mid: (quote.bp + quote.ap) / 2 };
  }
  const trade = snapshot?.latestTrade;
  const tradeAtMs = trade ? Date.parse(trade.t) : NaN;
  return trade && Number.isFinite(tradeAtMs) && tradeAtMs <= asOfMs && Number.isFinite(trade.p) && trade.p > 0
    ? { atMs: tradeAtMs, mid: trade.p } : undefined;
}
