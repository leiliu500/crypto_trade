import { EPISODE_VERSION, EXECUTION_SCENARIOS, type EpisodeObservation } from "./execution-stress.js";
import { evaluatePolicyCohort, validPolicyOutcome, type PolicyEvaluation } from "./policy-validation.js";
import { TRADING_POLICIES } from "./trading-policy.js";

const DAY = 86_400_000;
function declaredScenario(row: EpisodeObservation) {
  return EXECUTION_SCENARIOS.find((s) => s.id === row.scenario?.id && s.latencyMs === row.scenario.latencyMs
    && s.feeMultiplier === row.scenario.feeMultiplier && s.depthMultiplier === row.scenario.depthMultiplier);
}
function baseFee(row: EpisodeObservation): number {
  const scenario = declaredScenario(row);
  return scenario ? row.feeBps / scenario.feeMultiplier : NaN;
}
export function episodeStatistics(rows: readonly EpisodeObservation[]) {
  const complete = rows.filter((o) => declaredScenario(o) && validPolicyOutcome(o, o.scenario.latencyMs));
  const filled = complete.filter((o) => o.filledQty > 0);
  return { attempts: rows.length, complete: complete.length,
    invalid: rows.filter((o) => o.status === "INVALID" || (o.status === "COMPLETE" && !complete.includes(o))).length,
    pending: rows.filter((o) => o.status === "PENDING").length,
    filled: filled.length, partialFills: filled.filter((o) => o.filledQty < o.qty - 1e-12).length,
    unfilled: complete.filter((o) => o.filledQty === 0).length,
    wins: filled.filter((o) => o.netBps! > 0).length,
    meanNetBpsPerAttempt: complete.length ? complete.reduce((s, o) => s + o.netBps!, 0) / complete.length : null,
    meanNetBpsPerFill: filled.length ? filled.reduce((s, o) => s + o.netBps! * o.qty / o.filledQty, 0) / filled.length : null };
}

/** Descriptive intraday statistics are separate from fixed UTC-day validation.
 * The baseline alone selects a holding policy; stresses cannot pick new winners.
 * A research pass NEVER installs a model or authorizes an order. */
export function buildEpisodeReport(rows: readonly EpisodeObservation[], now = Date.now()) {
  const evidenceEndMs = Math.floor(now / DAY) * DAY;
  const groups = new Map<string, EpisodeObservation[]>();
  let excluded = 0;
  for (const row of rows) {
    if (row.sampling !== "EPISODE" || row.policyVersion !== EPISODE_VERSION || !row.episodeId || !row.hypothesisId
      || !Number.isFinite(row.signalAtMs) || row.signalAtMs < evidenceEndMs - 14 * DAY || row.signalAtMs > now) {
      excluded++; continue;
    }
    const key = [row.configurationVersion, row.policyVersion, row.symbol, row.family, row.side, row.regime,
      row.hypothesisId, row.reserveBps].join("|");
    const values = groups.get(key) ?? []; values.push(row); groups.set(key, values);
  }
  const cohorts = [...groups].map(([key, values]) => {
    const declared = TRADING_POLICIES.filter((p) => p.family === values[0]!.family);
    const expected = declared.flatMap((p) => EXECUTION_SCENARIOS.map((s) => `${p.id}|${s.id}`));
    const episodes = new Map<string, EpisodeObservation[]>();
    for (const value of values) { const e = episodes.get(value.episodeId) ?? []; e.push(value); episodes.set(value.episodeId, e); }
    const qualityReasons = new Set<string>();
    for (const episode of episodes.values()) {
      const keys = episode.map((o) => `${o.policyId}|${o.scenario?.id}`);
      if (keys.length !== expected.length || new Set(keys).size !== expected.length
        || expected.some((k) => !keys.includes(k))) qualityReasons.add("UNPAIRED_SCENARIOS_OR_POLICIES");
      const first = episode[0]!;
      for (const row of episode) {
        if (!declaredScenario(row)) qualityReasons.add("UNKNOWN_EXECUTION_ASSUMPTIONS");
        if (row.signalAtMs !== first.signalAtMs || row.signalBid !== first.signalBid || row.signalAsk !== first.signalAsk
          || row.qty !== first.qty || row.spreadBps !== first.spreadBps
          || !Number.isFinite(baseFee(row)) || !Number.isFinite(baseFee(first))
          || Math.abs(baseFee(row) - baseFee(first)) > 1e-9) {
          qualityReasons.add("CANDIDATE_OR_COST_MISMATCH");
        }
        if (!row.context?.healthAllowed || !row.context?.liquidityPass) qualityReasons.add("INELIGIBLE_CANDIDATES");
      }
    }
    // A fee change starts a different cohort rather than pooling incompatible costs.
    if (new Set(values.map(baseFee)).size !== 1) qualityReasons.add("MIXED_FEE_REGIMES");
    const dailyRows = values.filter((o) => o.signalAtMs < evidenceEndMs);
    let selectedPolicyId: string | undefined;
    const scenarios = EXECUTION_SCENARIOS.map((scenario, index) => {
      const current = values.filter((o) => o.scenario?.id === scenario.id);
      const eligible = dailyRows.filter((o) => o.scenario?.id === scenario.id);
      let evaluation: Omit<PolicyEvaluation, "model" | "folds"> | null = null;
      if (eligible.length) {
        const { model: _model, folds: _folds, ...audit } = evaluatePolicyCohort(`${key}|${scenario.id}`, eligible,
          evidenceEndMs, scenario.latencyMs, index === 0 ? undefined : selectedPolicyId, 1_000);
        evaluation = audit;
        if (index === 0) selectedPolicyId = audit.selectedPolicyId ?? undefined;
      }
      return { scenario: { ...scenario }, evaluation,
        policies: declared.map((p) => ({ policyId: p.id, ...episodeStatistics(current.filter((o) => o.policyId === p.id)) })) };
    });
    const contexts = [...episodes.values()].map((e) => e[0]!.context);
    return { key, symbol: values[0]!.symbol, side: values[0]!.side, hypothesisId: values[0]!.hypothesisId,
      episodes: episodes.size, selectedPolicyId: selectedPolicyId ?? null, qualityReasons: [...qualityReasons], scenarios,
      contexts: { duringCooldown: contexts.filter((c) => c?.cooldownRemainingMs > 0).length,
        duringPosition: contexts.filter((c) => c?.positionOpen).length, duringPendingOrder: contexts.filter((c) => c?.pendingOrder).length,
        venueNotionalOnly: contexts.filter((c) => c?.sizing === "VENUE_NOTIONAL_ONLY").length },
      researchQualified: qualityReasons.size === 0 && !!selectedPolicyId
        && scenarios.every((s) => s.evaluation !== null && s.evaluation.selectedPolicyId === selectedPolicyId && s.evaluation.reasons.length === 0),
      deploymentReady: false as const };
  });
  return { version: EPISODE_VERSION, generatedAtMs: now, evidenceEndMs,
    observations: rows.length, excluded, episodes: new Set([...groups.values()].flatMap((values) => values.map((o) => o.episodeId))).size,
    assumptions: EXECUTION_SCENARIOS, requirements: { independentSamples: 100, observedDays: 7, holdoutSamples: 30,
      validation: "14-day daily origin: 7d training / 3.5d selection / 3.5d untouched holdout; purged folds and day-clustered bounds" },
    deploymentReady: false as const, authorization: "RESEARCH_ONLY: no model installation, order dispatch, or size changes",
    cohorts };
}
