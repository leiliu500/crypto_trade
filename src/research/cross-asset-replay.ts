import { CROSS_ASSET_SPEC, CrossAssetModel, crossAssetPaperCandidate, crossAssetEntryGrossBps, type CrossAssetForecast, type CrossAssetQuote } from "./cross-asset-model.js";
import { findPolicy, policyExit, POLICY_RESEARCH_COOLDOWN_MS } from "./trading-policy.js";

export const CROSS_ASSET_REPLAY_SCENARIOS = [
  { id: "quotes-1s", latencyMs: 1_000, feeMultiplier: 1 },
  { id: "fees-1.5x", latencyMs: 1_000, feeMultiplier: 1.5 },
  { id: "latency-3s", latencyMs: 3_000, feeMultiplier: 1 },
] as const;
type Scenario = typeof CROSS_ASSET_REPLAY_SCENARIOS[number];
interface Attempt { forecast: CrossAssetForecast; scenario: Scenario; cap: number;
  entryAtMs: number | null; entryPrice: number | null; exitTriggerMs: number | null; exitReason: string | null }
export interface CrossAssetReplayOutcome {
  symbol: string; signalAtMs: number; scenario: string; side: 1 | -1; scoreBps: number;
  status: "FILLED" | "UNFILLED" | "SKIPPED" | "INVALID"; reason: string;
  entryAtMs: number | null; exitAtMs: number | null; grossBps: number | null; netBps: number | null;
  costCovered: boolean; forecastQualified: boolean;
  entryPriceDirectional: boolean;
}

export interface CrossAssetReplayOptions {
  paperEvaluation?: boolean;
  /** Earlier quotes train the model, but cannot create scored attempts. */
  entryStartMs?: number;
  /** Research control for the old submitting planner; never changes live flags. */
  legacyMidpointEntry?: boolean;
}

/** A coarse quote-screening replay. It cannot establish executable profits:
 * recorded market cards lack order-book depth and sub-second paths. */
export async function replayCrossAsset(quotes: AsyncIterable<CrossAssetQuote> | Iterable<CrossAssetQuote>,
  costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>, options: CrossAssetReplayOptions = {}) {
  if (options.entryStartMs !== undefined && !Number.isFinite(options.entryStartMs)) throw new Error("INVALID_ENTRY_START");
  const evaluation = options.paperEvaluation === true;
  const policy = evaluation ? findPolicy("trend-15m")! : null;
  const model = new CrossAssetModel(costs), latest = new Map<string, CrossAssetQuote>();
  const pending = new Map<string, Attempt>(), outcomes: CrossAssetReplayOutcome[] = [];
  const nextAttemptMs = new Map<string, number>();
  const reasons: Record<string, number> = {};
  let priceRebaseRejections = 0;
  let firstMs: number | null = null, lastMs: number | null = null, quoteCount = 0, invalidQuotes = 0;
  let forecasts = 0, eligibleForecasts = 0, peakConservativeNetBps: number | null = null;
  const lastForecasts = new Map<string, CrossAssetForecast>();
  const complete = (key: string, a: Attempt, status: CrossAssetReplayOutcome["status"], reason: string,
    exitAtMs: number | null = null, grossBps: number | null = null, netBps: number | null = null) => {
    outcomes.push({ symbol: a.forecast.symbol, signalAtMs: a.forecast.atMs, scenario: a.scenario.id,
      side: a.forecast.side, scoreBps: a.forecast.conservativeNetBps, status, reason,
      entryAtMs: a.entryAtMs, exitAtMs, grossBps, netBps,
      costCovered: Math.abs(a.forecast.predictedGrossBps) > a.forecast.costHurdleBps,
      forecastQualified: a.forecast.eligible,
      entryPriceDirectional: (crossAssetEntryGrossBps(a.forecast, a.cap) ?? -Infinity) > 0 });
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
      model.invalidate(q.atMs); latest.clear();
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
      const exit = a.forecast.side === 1 ? q.bid : q.ask;
      const gross = a.forecast.side * (exit / a.entryPrice! - 1) * 10_000;
      const cost = costs[q.symbol]!;
      const net = gross - cost.feeBps * a.scenario.feeMultiplier * (1 + exit / a.entryPrice!) - cost.reserveBps;
      if (policy && a.exitTriggerMs === null) {
        a.exitReason = policyExit(policy, gross, net, q.atMs - a.entryAtMs);
        if (a.exitReason) a.exitTriggerMs = q.atMs;
      }
      if (policy && a.exitTriggerMs === null) continue;
      const due = (policy ? a.exitTriggerMs! : a.entryAtMs + CROSS_ASSET_SPEC.horizonMs) + a.scenario.latencyMs;
      if (q.atMs < due) continue;
      if (q.atMs > due + 1_100) { complete(key, a, "INVALID", "EXIT_QUOTE_LATE"); continue; }
      complete(key, a, "FILLED", a.exitReason ?? "FIXED_15M_QUOTE_EXIT", q.atMs, gross, net);
    }
    for (const f of model.observe(q)) {
      forecasts++; reasons[f.reason] = (reasons[f.reason] ?? 0) + 1; lastForecasts.set(f.symbol, f);
      peakConservativeNetBps = Math.max(peakConservativeNetBps ?? -Infinity, f.conservativeNetBps);
      if (f.eligible) eligibleForecasts++;
      if (f.atMs < (options.entryStartMs ?? -Infinity)
        || (evaluation ? !crossAssetPaperCandidate(f, f.symbol, f.atMs, true) : !f.eligible)) continue;
      if (f.atMs < (nextAttemptMs.get(f.symbol) ?? -Infinity)
        || [...pending.values()].some((a) => a.forecast.symbol === f.symbol)) continue;
      const entryQuote = latest.get(f.symbol)!;
      const cap = f.side === 1 ? entryQuote.ask : entryQuote.bid;
      // Reserve the proposal interval before screening. Rejected proposals
      // remain zero-return attempts instead of admitting replacement trades.
      nextAttemptMs.set(f.symbol, f.atMs + (evaluation ? POLICY_RESEARCH_COOLDOWN_MS : CROSS_ASSET_SPEC.horizonMs
        + 2 * Math.max(...CROSS_ASSET_REPLAY_SCENARIOS.map((s) => s.latencyMs)) + 1_100));
      // The old live planner only checked the current midpoint. The default
      // now shares the executable-entry direction check with the planner.
      const directionPrice = options.legacyMidpointEntry ? (entryQuote.bid + entryQuote.ask) / 2 : cap;
      if (evaluation && (crossAssetEntryGrossBps(f, directionPrice) ?? -Infinity) <= 0) {
        priceRebaseRejections++;
        for (const scenario of CROSS_ASSET_REPLAY_SCENARIOS) complete(`${f.symbol}|${scenario.id}`,
          { forecast: f, scenario, cap, entryAtMs: null, entryPrice: null, exitTriggerMs: null, exitReason: null },
          "SKIPPED", "FORECAST_TARGET_EXHAUSTED", f.atMs, 0, 0);
        continue;
      }
      // Each stress receives the same candidate timestamps, even if its IOC
      // misses. A nonfill cannot give that scenario an extra later opportunity.
      for (const scenario of CROSS_ASSET_REPLAY_SCENARIOS) {
        const key = `${f.symbol}|${scenario.id}`;
        if (pending.has(key)) continue;
        pending.set(key, { forecast: f, scenario, cap,
          entryAtMs: null, entryPrice: null, exitTriggerMs: null, exitReason: null });
      }
    }
  }
  for (const [key, a] of pending) complete(key, a, "INVALID", "REPLAY_END");
  const groups = [...new Set(outcomes.map((o) => `${o.symbol}|${o.scenario}`))].sort().map((key) => {
    const rows = outcomes.filter((o) => `${o.symbol}|${o.scenario}` === key), filled = rows.filter((o) => o.status === "FILLED");
    const complete = rows.filter((o) => o.status !== "INVALID");
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { key, attempts: rows.length, filled: filled.length, unfilled: rows.filter(o => o.status === "UNFILLED").length,
      skipped: rows.filter(o => o.status === "SKIPPED").length,
      invalid: rows.length - complete.length, wins: filled.filter((o) => o.netBps! > 0).length,
      meanNetBpsPerAttempt: mean(complete.map((o) => o.netBps!)), meanNetBpsPerFill: mean(filled.map((o) => o.netBps!)),
      meanGrossBpsPerFill: mean(filled.map((o) => o.grossBps!)) };
  });
  // A whole opportunity must survive every execution stress. Filtering each
  // alternative's surviving rows separately would reward missing adverse paths.
  const opportunities = new Map<string, CrossAssetReplayOutcome[]>();
  for (const row of outcomes) {
    const key = `${row.symbol}|${row.signalAtMs}`, rows = opportunities.get(key) ?? [];
    rows.push(row); opportunities.set(key, rows);
  }
  const paired = [...opportunities.values()].filter(rows => rows.length === CROSS_ASSET_REPLAY_SCENARIOS.length
    && rows.every(r => r.status !== "INVALID"));
  const entryScreenComparison = {
    opportunities: opportunities.size, completeAcrossStresses: paired.length,
    excludedOpportunities: opportunities.size - paired.length,
    groups: [...new Set(outcomes.map(o => o.symbol))].sort().flatMap(symbol =>
      CROSS_ASSET_REPLAY_SCENARIOS.flatMap(scenario => {
        const panel = paired.flat().filter(o => o.symbol === symbol && o.scenario === scenario.id);
        const baseline = evaluation ? "EVALUATION" : "QUALIFIED";
        return [baseline, "DIRECTIONAL_ENTRY", "COST_COVERED", "CONSERVATIVE"].map(screen => {
          const accepted = panel.filter(o => o.status !== "SKIPPED" && (screen === baseline || (screen === "DIRECTIONAL_ENTRY" ? o.entryPriceDirectional
            : screen === "COST_COVERED" ? o.costCovered : o.forecastQualified)));
          return { symbol, scenario: scenario.id, screen, panelAttempts: panel.length,
            acceptedAttempts: accepted.length, filled: accepted.filter(o => o.status === "FILLED").length,
            meanNetBpsPerOriginalAttempt: panel.length ? accepted.reduce((s, o) => s + o.netBps!, 0) / panel.length : null };
        });
      })) };
  return { replayVersion: "cross-asset-quote-screen-v3", specification: CROSS_ASSET_SPEC, costs,
    generatedAtMs: Date.now(), quality: { quoteCount, invalidQuotes, firstMs, lastMs },
    entryMode: evaluation ? "PAPER_EVALUATION" : "QUALIFIED", entryStartMs: options.entryStartMs ?? firstMs,
    entryDirectionBasis: options.legacyMidpointEntry ? "LEGACY_MIDPOINT" : "ENTRY_QUOTE",
    exhaustedForecastCooldownMs: evaluation ? POLICY_RESEARCH_COOLDOWN_MS : null,
    exitPolicy: policy?.id ?? "FIXED_15M", entryScreenComparison,
    learning: model.stats(), forecasts, eligibleForecasts, reasons, priceRebaseRejections, peakConservativeNetBps,
    lastForecasts: [...lastForecasts.values()], scenarios: CROSS_ASSET_REPLAY_SCENARIOS, groups, outcomes,
    deploymentReady: false, limitations: ["Initial exploratory screening on reused market snapshots, not an untouched holdout",
      "Quote prices lack depth, queue and intraminute stop paths; these are hypothetical results, not broker fills",
      "Common candidate timestamps across stresses; one position per symbol/scenario; alternatives cannot be added",
      policy ? "Policy stop/target/deadline logic uses recorded quotes; intrasecond hits and exact live execution are not reconstructed"
        : "Fixed 15-minute replay exit differs from the stop/target policies used by prospective shadow execution",
      "Quote latency scenarios allow a 1.1-second sampling tolerance and do not reconstruct the live one-second order expiry",
      "Entry screen comparisons share original opportunities; skipped attempts do not create replacement trades",
      "Earlier quotes train the model causally; an entry start cutoff alone does not make reused history an untouched holdout",
      "No trained model is installed; missing paths invalidate trades and training labels"] };
}
