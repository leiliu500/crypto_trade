import type { PolicyObservation } from "./policy-collector.js";
import { EPISODE_VERSION, EXECUTION_SCENARIOS, type EpisodeObservation } from "./execution-stress.js";
import { validPolicyOutcome } from "./policy-validation.js";
import { findPolicy, POLICY_VERSION, TRADING_POLICIES } from "./trading-policy.js";

// A fixed research specification, never tuned against the reported outcomes.
export const CONDITIONAL_EDGE_SPEC = Object.freeze({ version: "conditional-net-edge-v1",
  minimumTrainingSamples: 24, ridgePenalty: 10, uncertaintyMultiplier: 1.96,
  tailLossWeight: .1, maximumStandardizedFeature: 6 });
const DAY = 86_400_000;
type Observation = PolicyObservation | EpisodeObservation;
type Example = { row: Observation; x: number[]; embargoMs: number };
export interface EdgeForecast {
  id: string; signalAtMs: number; trainingSamples: number; trainingLastExitMs: number;
  predictedNetBps: number; meanUncertaintyBps: number; tailLossBps: number;
  conservativeScoreBps: number; outOfDomain: boolean; preferred: boolean; actualNetBps: number;
}

/** Frozen features available at the entry quote. The target already includes
 * executable fills, both fees and the reserve; do not subtract costs twice. */
function featureVector(row: Observation): number[] | null {
  const f = row.features;
  const names = ["trendFastBps", "trendMediumBps", "trendSlowBps", "slowTrendEfficiency", "ofi", "tfi", "velocityZ"];
  if (!names.every((name) => Number.isFinite(f[name]))) return null;
  const hurdle = Math.max(1, 2 * row.feeBps + row.reserveBps + row.spreadBps);
  const aligned = (name: string) => row.side * f[name]!;
  const vector = [aligned("trendFastBps") / hurdle, aligned("trendMediumBps") / hurdle,
    aligned("trendSlowBps") / hurdle, f.slowTrendEfficiency!,
    Math.tanh(aligned("ofi")), Math.tanh(aligned("tfi")), Math.tanh(aligned("velocityZ") / 4),
    aligned("trendSlowBps") * f.slowTrendEfficiency! / hurdle];
  return vector.every(Number.isFinite) ? vector : null;
}

function scope(row: Observation): { key: string; latencyMs: number } | null {
  let hypothesis = "actual-entry", scenario = "entry-250ms", latencyMs = 250;
  if (row.sampling === "EPISODE" && row.policyVersion === EPISODE_VERSION) {
    const e = row as EpisodeObservation;
    const declared = EXECUTION_SCENARIOS.find((s) => s.id === e.scenario?.id
      && s.latencyMs === e.scenario.latencyMs && s.depthMultiplier === e.scenario.depthMultiplier
      && s.feeMultiplier === e.scenario.feeMultiplier);
    if (!declared || !e.episodeId || !e.hypothesisId) return null;
    hypothesis = e.hypothesisId; scenario = declared.id; latencyMs = declared.latencyMs;
  } else if (row.sampling !== "ENTRY" || row.policyVersion !== POLICY_VERSION) return null;
  return { key: [row.configurationVersion, row.policyVersion, row.sampling, row.symbol, row.side,
    row.family, row.regime, row.policyId, row.feeBps, row.reserveBps, hypothesis, scenario].join("|"), latencyMs };
}

/** Read-only prequential experiment. Every prediction is fitted before its
 * target is visible. Reports cannot promote models or modify order submission. */
export function analyzeConditionalEdge(rows: readonly Observation[], now = Date.now()) {
  const groups = new Map<string, { examples: Example[]; invalid: number; pending: number }>();
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const row of rows) { if (seen.has(row.id)) duplicateIds.add(row.id); seen.add(row.id); }
  let excluded = 0;
  for (const row of rows) {
    const s = scope(row), policy = findPolicy(row.policyId);
    if (!s || !policy || policy.family !== row.family || duplicateIds.has(row.id)
      || !Number.isFinite(row.signalAtMs) || row.signalAtMs > now || row.signalAtMs < now - 14 * DAY
      || !Number.isFinite(row.spreadBps) || row.spreadBps < 0) { excluded++; continue; }
    const group = groups.get(s.key) ?? { examples: [], invalid: 0, pending: 0 };
    groups.set(s.key, group);
    const x = featureVector(row);
    if (row.status === "PENDING" || (row.exitAtMs !== null && row.exitAtMs > now)) { group.pending++; continue; }
    if (!x || !validPolicyOutcome(row, s.latencyMs)) { group.invalid++; continue; }
    // Same spacing for both exits and every stress; selected duration cannot
    // manufacture extra independent observations. This is not proof of independence.
    const embargoMs = Math.max(...TRADING_POLICIES.filter((p) => p.family === row.family).map((p) => p.horizonMs)) + 13_000;
    group.examples.push({ row, x, embargoMs });
  }
  const cohorts = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const independent: Example[] = [];
    for (const e of group.examples.sort((a, b) => a.row.signalAtMs - b.row.signalAtMs || a.row.id.localeCompare(b.row.id))) {
      const previous = independent.at(-1);
      if (!previous || e.row.signalAtMs > previous.row.signalAtMs + previous.embargoMs) independent.push(e);
    }
    const forecasts: EdgeForecast[] = [];
    for (let i = CONDITIONAL_EDGE_SPEC.minimumTrainingSamples; i < independent.length; i++) {
      const target = independent[i]!;
      const training = independent.slice(0, i).filter((e) => e.row.exitAtMs! < target.row.signalAtMs
        && e.row.signalAtMs + e.embargoMs < target.row.signalAtMs);
      if (training.length < CONDITIONAL_EDGE_SPEC.minimumTrainingSamples) continue;
      const result = predict(training, target.x);
      forecasts.push({ id: target.row.id, signalAtMs: target.row.signalAtMs, trainingSamples: training.length,
        trainingLastExitMs: Math.max(...training.map((e) => e.row.exitAtMs!)), ...result,
        actualNetBps: target.row.netBps! });
    }
    const selected = forecasts.filter((f) => f.preferred);
    const actual = forecasts.map((f) => f.actualNetBps);
    const conditional = forecasts.map((f) => f.preferred ? f.actualNetBps : 0);
    const days = new Set(forecasts.map((f) => Math.floor(f.signalAtMs / DAY))).size;
    return { key, validAttempts: group.examples.length, invalid: group.invalid, pending: group.pending,
      nonOverlappingSamples: independent.length, overlapExcluded: group.examples.length - independent.length,
      evaluatedAttempts: forecasts.length, evaluatedDays: days, preferredAttempts: selected.length,
      baselineMeanNetBps: average(actual), conditionalMeanNetBpsPerOpportunity: average(conditional),
      preferredMeanNetBps: average(selected.map((f) => f.actualNetBps)),
      meanSquaredPredictionError: average(forecasts.map((f) => (f.predictedNetBps - f.actualNetBps) ** 2)),
      positivePreferredOutcomes: selected.filter((f) => f.actualNetBps > 0).length,
      status: forecasts.length === 0 ? "INSUFFICIENT_TRAINING_DATA"
        : selected.length === 0 ? "NO_POSITIVE_CONSERVATIVE_FORECAST"
          : "EXPLORATORY_FORWARD_RESULTS_REQUIRE_NEW_HOLDOUT",
      forecasts };
  });
  return { specification: CONDITIONAL_EDGE_SPEC, generatedAtMs: now, observations: rows.length, excluded,
    deploymentReady: false, orderSubmissionChanged: false,
    limitations: ["Research predictions only; no automatic promotion or order gating",
      "Gaussian ridge uncertainty is model-dependent, not a calibrated coverage guarantee",
      "Non-overlap does not remove serial or cross-symbol dependence",
      "Skipped attempts score zero; avoided losses are not trading profits",
      "No winner selection across cohorts; require fresh multi-day holdout and paired execution stress validation"], cohorts };
}

function predict(training: Example[], target: number[]) {
  const n = training.length, p = target.length + 1;
  const means = target.map((_, j) => average(training.map((e) => e.x[j]!))!);
  const scales = means.map((m, j) => Math.max(1e-6, Math.sqrt(training.reduce((s, e) => s + (e.x[j]! - m) ** 2, 0) / n)));
  const transform = (x: number[]) => [1, ...x.map((v, j) => (v - means[j]!) / scales[j]!)];
  const design = training.map((e) => transform(e.x));
  const x = transform(target);
  const matrix = Array.from({ length: p }, (_, j) => Array.from({ length: p }, (_, k) =>
    design.reduce((s, r) => s + r[j]! * r[k]!, 0) + (j === k && j > 0 ? CONDITIONAL_EDGE_SPEC.ridgePenalty : 0)));
  const rhs = Array.from({ length: p }, (_, j) => training.reduce((s, e, i) => s + design[i]![j]! * e.row.netBps!, 0));
  const coefficients = solve(matrix, rhs);
  const predictedNetBps = dot(x, coefficients);
  const residualVariance = training.reduce((s, e, i) => s + (e.row.netBps! - dot(design[i]!, coefficients)) ** 2, 0) / (n - p);
  // A one-basis-point residual floor prevents constant outcomes from producing
  // fictional certainty. Slopes shrink toward zero; the intercept is unpenalized.
  const meanUncertaintyBps = Math.sqrt(Math.max(1, residualVariance) * Math.max(0, dot(x, solve(matrix, x))));
  const losses = training.map((e) => Math.max(0, -e.row.netBps!)).sort((a, b) => b - a);
  const tailLossBps = average(losses.slice(0, Math.max(1, Math.ceil(n * .1))))!;
  const conservativeScoreBps = predictedNetBps - CONDITIONAL_EDGE_SPEC.uncertaintyMultiplier * meanUncertaintyBps
    - CONDITIONAL_EDGE_SPEC.tailLossWeight * tailLossBps;
  const outOfDomain = x.slice(1).some((v) => Math.abs(v) > CONDITIONAL_EDGE_SPEC.maximumStandardizedFeature);
  return { predictedNetBps, meanUncertaintyBps, tailLossBps, conservativeScoreBps, outOfDomain,
    preferred: !outOfDomain && conservativeScoreBps > 0 };
}

function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length, a = matrix.map((r, i) => [...r, rhs[i]!]);
  for (let j = 0; j < n; j++) {
    let pivot = j;
    for (let i = j + 1; i < n; i++) if (Math.abs(a[i]![j]!) > Math.abs(a[pivot]![j]!)) pivot = i;
    [a[j], a[pivot]] = [a[pivot]!, a[j]!];
    const denominator = a[j]![j]!;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) throw new Error("Invalid ridge system");
    for (let k = j; k <= n; k++) a[j]![k] = a[j]![k]! / denominator;
    for (let i = 0; i < n; i++) if (i !== j) {
      const factor = a[i]![j]!;
      for (let k = j; k <= n; k++) a[i]![k] = a[i]![k]! - factor * a[j]![k]!;
    }
  }
  return a.map((r) => r[n]!);
}
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const average = (values: number[]): number | null => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
