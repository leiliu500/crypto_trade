import { CROSS_ASSET_SPEC, CrossAssetModel, type CrossAssetForecast, type CrossAssetQuote } from "./cross-asset-model.js";

export const CROSS_ASSET_REPLAY_SCENARIOS = [
  { id: "quotes-1s", latencyMs: 1_000, feeMultiplier: 1 },
  { id: "fees-1.5x", latencyMs: 1_000, feeMultiplier: 1.5 },
  { id: "latency-3s", latencyMs: 3_000, feeMultiplier: 1 },
] as const;
type Scenario = typeof CROSS_ASSET_REPLAY_SCENARIOS[number];
interface Attempt { forecast: CrossAssetForecast; scenario: Scenario; cap: number;
  entryAtMs: number | null; entryPrice: number | null }
export interface CrossAssetReplayOutcome {
  symbol: string; signalAtMs: number; scenario: string; side: 1 | -1; scoreBps: number;
  status: "FILLED" | "UNFILLED" | "INVALID"; reason: string;
  entryAtMs: number | null; exitAtMs: number | null; grossBps: number | null; netBps: number | null;
}

/** A coarse quote-screening replay. It cannot establish executable profits:
 * recorded market cards lack order-book depth and sub-second paths. */
export async function replayCrossAsset(quotes: AsyncIterable<CrossAssetQuote> | Iterable<CrossAssetQuote>,
  costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>) {
  const model = new CrossAssetModel(costs), latest = new Map<string, CrossAssetQuote>();
  const pending = new Map<string, Attempt>(), outcomes: CrossAssetReplayOutcome[] = [];
  const nextAttemptMs = new Map<string, number>();
  const reasons: Record<string, number> = {};
  let firstMs: number | null = null, lastMs: number | null = null, quoteCount = 0, invalidQuotes = 0;
  let forecasts = 0, eligibleForecasts = 0, peakConservativeNetBps: number | null = null;
  const lastForecasts = new Map<string, CrossAssetForecast>();
  const complete = (key: string, a: Attempt, status: CrossAssetReplayOutcome["status"], reason: string,
    exitAtMs: number | null = null, grossBps: number | null = null, netBps: number | null = null) => {
    outcomes.push({ symbol: a.forecast.symbol, signalAtMs: a.forecast.atMs, scenario: a.scenario.id,
      side: a.forecast.side, scoreBps: a.forecast.conservativeNetBps, status, reason,
      entryAtMs: a.entryAtMs, exitAtMs, grossBps, netBps });
    pending.delete(key);
  };
  for await (const q of quotes) {
    quoteCount++;
    if (!Number.isFinite(q.atMs) || lastMs !== null && q.atMs < lastMs) throw new Error("QUOTES_MUST_BE_CHRONOLOGICAL");
    firstMs ??= q.atMs; lastMs = q.atMs;
    const prior = latest.get(q.symbol);
    const valid = q.valid && [q.bid, q.ask].every(Number.isFinite) && q.bid > 0 && q.ask > q.bid;
    const gap = prior && q.atMs - prior.atMs > CROSS_ASSET_SPEC.maximumQuoteGapMs;
    if (!valid || gap) {
      invalidQuotes++;
      for (const [key, a] of pending) complete(key, a, "INVALID", "QUOTE_GAP_OR_INVALID");
      model.invalidate(); latest.clear();
    }
    if (!valid) continue;
    latest.set(q.symbol, q);
    for (const [key, a] of pending) {
      if (a.forecast.symbol !== q.symbol) continue;
      if (a.entryAtMs === null) {
        const due = a.forecast.atMs + a.scenario.latencyMs;
        if (q.atMs < due) continue;
        if (q.atMs > due + 1_100) { complete(key, a, "INVALID", "ENTRY_QUOTE_LATE"); continue; }
        const entry = a.forecast.side === 1 ? q.ask : q.bid;
        if (a.forecast.side * (entry - a.cap) > 1e-9) {
          complete(key, a, "UNFILLED", "ENTRY_CAP_MISSED", q.atMs, 0, 0); continue;
        }
        a.entryAtMs = q.atMs; a.entryPrice = entry;
      }
      const due = a.entryAtMs + CROSS_ASSET_SPEC.horizonMs + a.scenario.latencyMs;
      if (q.atMs < due) continue;
      if (q.atMs > due + 1_100) { complete(key, a, "INVALID", "EXIT_QUOTE_LATE"); continue; }
      const exit = a.forecast.side === 1 ? q.bid : q.ask;
      const gross = a.forecast.side * (exit / a.entryPrice! - 1) * 10_000;
      const cost = costs[q.symbol]!;
      const net = gross - cost.feeBps * a.scenario.feeMultiplier * (1 + exit / a.entryPrice!) - cost.reserveBps;
      complete(key, a, "FILLED", "FIXED_15M_QUOTE_EXIT", q.atMs, gross, net);
    }
    for (const f of model.observe(q)) {
      forecasts++; reasons[f.reason] = (reasons[f.reason] ?? 0) + 1; lastForecasts.set(f.symbol, f);
      peakConservativeNetBps = Math.max(peakConservativeNetBps ?? -Infinity, f.conservativeNetBps);
      if (!f.eligible) continue;
      eligibleForecasts++;
      if (f.atMs < (nextAttemptMs.get(f.symbol) ?? -Infinity)
        || [...pending.values()].some((a) => a.forecast.symbol === f.symbol)) continue;
      // Each stress receives the same candidate timestamps, even if its IOC
      // misses. A nonfill cannot give that scenario an extra later opportunity.
      nextAttemptMs.set(f.symbol, f.atMs + CROSS_ASSET_SPEC.horizonMs
        + 2 * Math.max(...CROSS_ASSET_REPLAY_SCENARIOS.map((s) => s.latencyMs)) + 1_100);
      for (const scenario of CROSS_ASSET_REPLAY_SCENARIOS) {
        const key = `${f.symbol}|${scenario.id}`;
        if (pending.has(key)) continue;
        const entryQuote = latest.get(f.symbol)!;
        pending.set(key, { forecast: f, scenario, cap: f.side === 1 ? entryQuote.ask : entryQuote.bid,
          entryAtMs: null, entryPrice: null });
      }
    }
  }
  for (const [key, a] of pending) complete(key, a, "INVALID", "REPLAY_END");
  const groups = [...new Set(outcomes.map((o) => `${o.symbol}|${o.scenario}`))].sort().map((key) => {
    const rows = outcomes.filter((o) => `${o.symbol}|${o.scenario}` === key), filled = rows.filter((o) => o.status === "FILLED");
    const complete = rows.filter((o) => o.status !== "INVALID");
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { key, attempts: rows.length, filled: filled.length, unfilled: complete.length - filled.length,
      invalid: rows.length - complete.length, wins: filled.filter((o) => o.netBps! > 0).length,
      meanNetBpsPerAttempt: mean(complete.map((o) => o.netBps!)), meanNetBpsPerFill: mean(filled.map((o) => o.netBps!)),
      meanGrossBpsPerFill: mean(filled.map((o) => o.grossBps!)) };
  });
  return { specification: CROSS_ASSET_SPEC, generatedAtMs: Date.now(), quality: { quoteCount, invalidQuotes, firstMs, lastMs },
    learning: model.stats(), forecasts, eligibleForecasts, reasons, peakConservativeNetBps,
    lastForecasts: [...lastForecasts.values()], scenarios: CROSS_ASSET_REPLAY_SCENARIOS, groups, outcomes,
    deploymentReady: false, limitations: ["Initial exploratory screening on reused market snapshots, not an untouched holdout",
      "Quote prices lack depth, queue and intraminute stop paths; these are hypothetical results, not broker fills",
      "Common candidate timestamps across stresses; one position per symbol/scenario; alternatives cannot be added",
      "Fixed 15-minute replay exit differs from the stop/target policies used by prospective shadow execution",
      "No trained model is installed; missing paths invalidate trades and training labels"] };
}
