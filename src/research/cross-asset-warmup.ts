import { CrossAssetModel, CROSS_ASSET_SPEC, CROSS_ASSET_SYMBOLS, type CrossAssetQuote } from "./cross-asset-model.js";

export interface CrossAssetHistoryBootstrap {
  source: "POSTGRES_MARKET_SNAPSHOTS";
  cutoffMs: number; completedAtMs: number; firstQuoteMs: number | null; lastQuoteMs: number | null;
  quotesRead: number; invalidQuotes: number; labelsPerSymbol: number; trainedThroughMs: number | null;
  trainingReady: boolean; historyRetained: boolean; priceHistoryReady: boolean; discardedIncompleteInterval: boolean;
}

/** Fit an isolated candidate; no engine, broker, planner or historical forecast
 * is exposed to this replay. Installation is atomic after the full read succeeds. */
export async function warmCrossAssetHistory(quotes: AsyncIterable<CrossAssetQuote> | Iterable<CrossAssetQuote>,
  costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>, cutoffMs: number, now: () => number = Date.now) {
  if (!Number.isFinite(cutoffMs) || cutoffMs > now()) throw new Error("INVALID_HISTORY_CUTOFF");
  const model = new CrossAssetModel(costs);
  let firstQuoteMs: number | null = null, lastQuoteMs: number | null = null, quotesRead = 0, invalidQuotes = 0;
  for await (const q of quotes) {
    if (!Number.isFinite(q.atMs) || q.atMs >= cutoffMs || lastQuoteMs !== null && q.atMs < lastQuoteMs) {
      throw new Error("HISTORY_MUST_BE_CHRONOLOGICAL_AND_BEFORE_CUTOFF");
    }
    if (!(CROSS_ASSET_SYMBOLS as readonly string[]).includes(q.symbol)) throw new Error("HISTORY_SYMBOL_OUT_OF_SCOPE");
    firstQuoteMs ??= q.atMs; lastQuoteMs = q.atMs; quotesRead++;
    if (q.valid !== true || ![q.bid, q.ask].every(Number.isFinite) || q.bid <= 0 || q.ask <= q.bid) invalidQuotes++;
    model.observeHistorical({ ...q, valid: q.valid === true });
  }
  const completedAtMs = now();
  if (!Number.isFinite(completedAtMs) || completedAtMs < cutoffMs) throw new Error("INVALID_HISTORY_HANDOFF_TIME");
  const handoff = model.prepareForLive(completedAtMs), stats = model.stats();
  const bootstrap: CrossAssetHistoryBootstrap = { source: "POSTGRES_MARKET_SNAPSHOTS", cutoffMs, completedAtMs,
    firstQuoteMs, lastQuoteMs, quotesRead, invalidQuotes, labelsPerSymbol: stats.labelsPerSymbol,
    trainedThroughMs: stats.trainedThroughMs, trainingReady: stats.labelsPerSymbol >= CROSS_ASSET_SPEC.minimumLabels, ...handoff };
  return { model, bootstrap };
}
