import type { PolicyObservation } from "./policy-collector.js";
import { EPISODE_VERSION, EXECUTION_SCENARIOS, type EpisodeObservation } from "./execution-stress.js";
import { blockExpectancy } from "./block-expectancy.js";
import { validPolicyOutcome } from "./policy-validation.js";
import { POLICY_VERSION, POLICY_ENTRY_LATENCY_MS, POLICY_MAX_ENTRY_DELAY_MS,
  POLICY_MAX_QUOTE_GAP_MS, TRADING_POLICIES } from "./trading-policy.js";

/** Descriptive paired comparisons, never model selection. Every holding policy
 * uses the same entry and denominator. Missing longer paths cannot make a
 * shorter horizon appear better by changing the set of entries being compared. */
export function comparePolicyExits(rows: readonly PolicyObservation[], now = Date.now()) {
  const groups = new Map<string, PolicyObservation[]>();
  let excludedObservations = 0;
  for (const row of rows) {
    const episode = row as EpisodeObservation;
    const scenario = row.sampling === "EPISODE" ? EXECUTION_SCENARIOS.find((s) =>
      s.id === episode.scenario?.id && s.latencyMs === episode.scenario.latencyMs
      && s.feeMultiplier === episode.scenario.feeMultiplier && s.depthMultiplier === episode.scenario.depthMultiplier) : undefined;
    if (!Number.isFinite(row.signalAtMs) || row.signalAtMs > now || ![1, -1].includes(row.side)
      || ![row.feeBps, row.reserveBps].every((v) => Number.isFinite(v) && v >= 0)
      || !TRADING_POLICIES.some((p) => p.id === row.policyId && p.family === row.family)
      || !(row.sampling === "ENTRY" && row.policyVersion === POLICY_VERSION
        && (row.executionSource === undefined || (row.executionSource === "OBSERVED_PAPER" && row.entryClientOrderId))
        || row.sampling === "EPISODE" && row.policyVersion === EPISODE_VERSION
        && scenario && episode.episodeId && episode.hypothesisId && row.executionSource === undefined)) {
      excludedObservations++; continue;
    }
    const key = JSON.stringify([row.configurationVersion, row.policyVersion, row.sampling, row.executionSource ?? "SIMULATED",
      row.symbol, row.family, row.side, row.regime, row.feeBps, row.reserveBps,
      episode.hypothesisId ?? null, scenario?.id ?? null]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const cohorts = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const first = values[0]!, episode = first as EpisodeObservation;
    const latencyMs = first.sampling === "EPISODE" ? episode.scenario.latencyMs : POLICY_ENTRY_LATENCY_MS;
    const policies = TRADING_POLICIES.filter((p) => p.family === first.family).sort((a, b) => a.horizonMs - b.horizonMs);
    const baselinePolicyId = policies[0]!.id;
    const opportunities = new Map<string, PolicyObservation[]>();
    for (const row of values) {
      const id = row.sampling === "EPISODE" ? (row as EpisodeObservation).episodeId
        : row.entryClientOrderId ?? String(row.signalAtMs);
      const group = opportunities.get(id) ?? []; group.push(row); opportunities.set(id, group);
    }
    const exclusions = { missingOrDuplicatePolicies: 0, invalidOrPendingOutcomes: 0, entryMismatch: 0 };
    const complete: PolicyObservation[][] = [], nonOverlapping: PolicyObservation[][] = [];
    const embargoMs = Math.max(...policies.map((p) => p.horizonMs)) + 2 * latencyMs
      + POLICY_MAX_ENTRY_DELAY_MS + 2 * POLICY_MAX_QUOTE_GAP_MS;
    let nextEligibleMs = -Infinity;
    for (const [id, observations] of [...opportunities].sort(([a, left], [b, right]) =>
      left[0]!.signalAtMs - right[0]!.signalAtMs || a.localeCompare(b))) {
      // Reserve the interval even when its outcome is invalid, preventing a
      // surviving later opportunity from replacing a missing earlier one.
      const separated = observations[0]!.signalAtMs > nextEligibleMs;
      if (separated) nextEligibleMs = observations[0]!.signalAtMs + embargoMs;
      if (observations.length !== policies.length || policies.some((p) => observations.filter((o) => o.policyId === p.id).length !== 1)) {
        exclusions.missingOrDuplicatePolicies++; continue;
      }
      if (observations.some((o) => !validPolicyOutcome(o, latencyMs) || o.exitAtMs! > now
        || o.sampling === "EPISODE" && (!(o as EpisodeObservation).context?.healthAllowed
          || !(o as EpisodeObservation).context?.liquidityPass))) {
        exclusions.invalidOrPendingOutcomes++; continue;
      }
      const anchor = observations[0]!;
      if (observations.some((o) => !sameEntry(anchor, o))) { exclusions.entryMismatch++; continue; }
      const ordered = policies.map((p) => observations.find((o) => o.policyId === p.id)!);
      complete.push(ordered);
      if (separated) nonOverlapping.push(ordered);
    }
    return { key, configurationVersion: first.configurationVersion, symbol: first.symbol, side: first.side,
      family: first.family, sampling: first.sampling, executionSource: first.executionSource ?? "SIMULATED",
      hypothesisId: episode.hypothesisId ?? null, scenarioId: episode.scenario?.id ?? null,
      baselinePolicyId, opportunities: opportunities.size, completePairs: complete.length,
      nonOverlappingPairs: nonOverlapping.length, embargoMs, exclusions,
      policies: policies.map((p, index) => ({ policyId: p.id,
        allPairs: statistics(complete, index), nonOverlappingPairs: statistics(nonOverlapping, index) })) };
  });
  return { generatedAtMs: now, observations: rows.length, excludedObservations, deploymentReady: false as const,
    limitations: ["Hypothetical exits, including those anchored to observed paper entries, are not realized broker P&L",
      "All policies share a complete-entry panel; excluded outcomes remain visible and may bias descriptive means",
      "Non-overlap uses the longest declared horizon; cross-symbol and market-day dependence remain",
      "Day-block bounds require seven observed days; they are exploratory, without multiple-comparison correction",
      "No policy selection or promotion; profitability still requires fresh chronological holdout and execution stresses"], cohorts };
}

function sameEntry(a: PolicyObservation, b: PolicyObservation): boolean {
  const fields = ["signalAtMs", "signalBid", "signalAsk", "spreadBps", "qty", "filledQty", "entryAtMs", "entryPrice",
    "executionSource", "entryClientOrderId", "decisionAtMs"] as const;
  return fields.every((field) => a[field] === b[field])
    && a.features.invalidationPx === b.features.invalidationPx
    && a.features.policyVolatilityBps === b.features.policyVolatilityBps;
}

function statistics(pairs: readonly PolicyObservation[][], index: number) {
  const rows = pairs.map((p) => p[index]!), filled = rows.filter((o) => o.filledQty > 0);
  const deltas = pairs.map((p) => p[index]!.netBps! - p[0]!.netBps!);
  const days = new Set(rows.map((o) => Math.floor(o.signalAtMs / 86_400_000))).size;
  const lower = (values: number[]) => days >= 7 ? blockExpectancy(values.map((netBps, i) =>
    ({ atMs: rows[i]!.signalAtMs, netBps })), undefined, 0).lower95 : null;
  return { attempts: rows.length, filled: filled.length, unfilled: rows.length - filled.length,
    partialFills: filled.filter((o) => o.filledQty < o.qty - 1e-12).length,
    wins: filled.filter((o) => o.netBps! > 0).length, observedDays: days,
    meanNetBpsPerAttempt: mean(rows.map((o) => o.netBps!)),
    meanNetBpsPerFill: mean(filled.map((o) => o.netBps! * o.qty / o.filledQty)),
    meanGrossBpsPerFill: mean(filled.map((o) => o.grossBps! * o.qty / o.filledQty)),
    meanDeltaVsBaselineBps: mean(deltas), lower95NetBps: lower(rows.map((o) => o.netBps!)),
    lower95DeltaVsBaselineBps: lower(deltas) };
}
function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
