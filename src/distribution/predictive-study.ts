import { createHash } from "node:crypto";
import { CostAwareRidgeModel, COST_AWARE_RIDGE_SPEC } from "./cost-aware-model.js";
import { ConditionalDistributionModel } from "./model.js";
import { loadPredictiveAuditData } from "./predictive-audit-data.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS,
  DISTRIBUTION_SPEC as S, type DistributionOutcome, type DistributionSample } from "./spec.js";

export const PREDICTIVE_MODELS = ["conditional", "unconditional", "cost-only", "cost-aware-ridge"] as const;
export type PredictiveModelName = typeof PREDICTIVE_MODELS[number];
export const PROBE_POLICIES = [...PREDICTIVE_MODELS, "flat", "long-15m", "short-15m", "momentum-15m"] as const;
type Policy = typeof PROBE_POLICIES[number];
type Dataset = Awaited<ReturnType<typeof loadPredictiveAuditData>>;
export const PREDICTIVE_STUDY_SPEC = Object.freeze({
  version: "btc-eth-cost-aware-predictive-study-v1", researchOnly: true,
  candidate: COST_AWARE_RIDGE_SPEC, minimumPredictedWorstNetBpsExclusive: 1,
  sampleGate: 48, effectiveSampleGate: 32, trainingDateGate: 3,
  probePolicyOnly: true, portfolioSlotsPerPolicy: 1, candidateTuningOnEvaluation: false,
  untouched: false, automaticPromotion: false,
});

export interface PreparedProbe {
  symbol: string; atMs: number; eventIndex: number; features: number[];
  actions: Array<{ actionId: string; supportReady: boolean;
    means: Record<PredictiveModelName, Array<number | null>> }>;
  outcomes: Array<{ actionId: string; eventIndex: number; outcomes: DistributionOutcome[] }>;
}
interface PolicyLedger {
  policy: Policy; symbol: string; scenario: string; selections: number;
  filled: number; unfilled: number; unknown: number; knownNetBpsSum: number;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathKey = (symbol: string, atMs: number, actionId: string) => `${symbol}:${atMs}:${actionId}`;
const date = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);

/** A sparse, recorded-probe experiment. Only observed outcome records release
 * a slot. Outcomes are never consulted to decide which action to select. */
export function evaluateProbePolicies(probes: PreparedProbe[]) {
  const rows: PolicyLedger[] = PROBE_POLICIES.flatMap(policy => S.symbols.flatMap(symbol => SCENARIOS.map(scenario => ({
    policy, symbol, scenario: scenario.id, selections: 0, filled: 0, unfilled: 0, unknown: 0, knownNetBpsSum: 0 }))));
  const slots = new Map<Policy, string>(), completedThrough = new Map<Policy, number>();
  const selections: Array<{ policy: Policy; symbol: string; actionId: string; atMs: number; eventIndex: number;
    predictedWorstNetBps: number | null }> = [];
  const realized: Array<{ policy: Policy; symbol: string; actionId: string; atMs: number; eventIndex: number;
    outcomes: DistributionOutcome[] }> = [];
  const events = probes.flatMap(probe => [
    { kind: "FORECAST" as const, index: probe.eventIndex, probe, outcome: null },
    ...probe.outcomes.map(outcome => ({ kind: "OUTCOME" as const, index: outcome.eventIndex, probe, outcome })),
  ]).sort((a, b) => a.index - b.index);
  if (new Set(events.map(e => e.index)).size !== events.length) throw new Error("PREDICTIVE_DUPLICATE_EVENT_INDEX");
  for (const event of events) {
    const probe = event.probe;
    if (event.kind === "OUTCOME") {
      const outcome = event.outcome!;
      if (outcome.eventIndex <= probe.eventIndex) throw new Error("PREDICTIVE_OUTCOME_PRECEDES_FORECAST");
      const key = pathKey(probe.symbol, probe.atMs, outcome.actionId);
      for (const policy of PROBE_POLICIES) if (slots.get(policy) === key) {
        for (const scenario of SCENARIOS) {
          const value = outcome.outcomes.find(o => o.scenario === scenario.id);
          if (!value) throw new Error("PREDICTIVE_MISSING_SCENARIO");
          const row = rows.find(r => r.policy === policy && r.symbol === probe.symbol && r.scenario === scenario.id)!;
          if (value.status === "INVALID") row.unknown++;
          else {
            if (value.netBps === null || !Number.isFinite(value.netBps)) throw new Error("PREDICTIVE_INVALID_KNOWN_RETURN");
            row.filled += Number(value.status === "FILLED"); row.unfilled += Number(value.status === "UNFILLED");
            row.knownNetBpsSum += value.netBps;
          }
        }
        realized.push({ policy, symbol: probe.symbol, actionId: outcome.actionId, atMs: probe.atMs,
          eventIndex: event.index, outcomes: structuredClone(outcome.outcomes) });
        slots.delete(policy);
        completedThrough.set(policy, Math.max(...outcome.outcomes.map(o => o.exitAtMs)));
      }
      continue;
    }
    for (const policy of PROBE_POLICIES) {
      if (policy === "flat" || slots.has(policy) || probe.atMs <= (completedThrough.get(policy) ?? -1)) continue;
      let actionId: string | undefined, score: number | null = null;
      if ((PREDICTIVE_MODELS as readonly string[]).includes(policy)) {
        const model = policy as PredictiveModelName;
        const choices = probe.actions.filter(action => action.supportReady)
          .map(action => ({ actionId: action.actionId, scores: action.means[model] }))
          .filter(action => action.scores.length === SCENARIOS.length && action.scores.every(v => v !== null && Number.isFinite(v)))
          .map(action => ({ actionId: action.actionId, score: Math.min(...action.scores as number[]) }))
          .filter(action => action.score > PREDICTIVE_STUDY_SPEC.minimumPredictedWorstNetBpsExclusive)
          .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId));
        actionId = choices[0]?.actionId; score = choices[0]?.score ?? null;
      } else {
        const fixed = policy === "momentum-15m" ? probe.features[7] === 0 ? undefined
          : probe.features[7]! > 0 ? "long-15m" : "short-15m" : policy;
        if (probe.actions.some(action => action.actionId === fixed && action.supportReady)) actionId = fixed;
      }
      if (!actionId) continue;
      slots.set(policy, pathKey(probe.symbol, probe.atMs, actionId));
      selections.push({ policy, symbol: probe.symbol, actionId, atMs: probe.atMs, eventIndex: probe.eventIndex,
        predictedWorstNetBps: score });
      for (const row of rows) if (row.policy === policy && row.symbol === probe.symbol) row.selections++;
    }
  }
  if (slots.size) throw new Error("PREDICTIVE_MISSING_SELECTED_OUTCOME");
  const aggregates = PROBE_POLICIES.flatMap(policy => SCENARIOS.map(scenario => {
    const own = rows.filter(row => row.policy === policy && row.scenario === scenario.id);
    const totals = own.reduce((a, row) => ({ selections: a.selections + row.selections,
      filled: a.filled + row.filled, unfilled: a.unfilled + row.unfilled, unknown: a.unknown + row.unknown,
      knownNetBpsSum: a.knownNetBpsSum + row.knownNetBpsSum }),
    { selections: 0, filled: 0, unfilled: 0, unknown: 0, knownNetBpsSum: 0 });
    return { policy, scenario: scenario.id, ...totals,
      fullPathKnownNetBpsSum: totals.unknown ? null : totals.knownNetBpsSum,
      knownMeanNetBps: totals.filled + totals.unfilled ? totals.knownNetBpsSum / (totals.filled + totals.unfilled) : null };
  }));
  return { policyDefinition: "Recorded probe grid; common support gates; model policies require worst-scenario predicted net mean >1bp. No uncertainty/tail score is applied to any model policy.",
    modelAvailability: "Support gates are shared; each model also needs its own finite forecasts. Candidate filled-support requirements can reduce its available action set.",
    opportunities: PREDICTIVE_MODELS.map(model => ({ model, probeOrigins: probes.length,
      supportReadyActions: probes.reduce((n, p) => n + p.actions.filter(a => a.supportReady).length, 0),
      supportedFiniteActions: probes.reduce((n, p) => n + p.actions.filter(a => a.supportReady
        && a.means[model].every(v => v !== null && Number.isFinite(v))).length, 0),
      supportedPositiveWorstMeanActions: probes.reduce((n, p) => n + p.actions.filter(a => a.supportReady
        && a.means[model].every(v => v !== null && Number.isFinite(v) && v > 1)).length, 0) })),
    livePolicyEquivalent: false, bpsAreRequestedNotionalOutcomes: true, compoundedPortfolioReturn: false,
    unknownPathAssumption: "An observed INVALID outcome clears the hypothetical slot; the affected full-period scenario return remains unknown.",
    rows: rows.map(row => ({ ...row, fullPathKnownNetBpsSum: row.unknown ? null : row.knownNetBpsSum })),
    aggregates, selections, realized, selectionsSha256: hash(selections) };
}

interface ErrorAccumulator { count: number; absolute: number; squared: number; bias: number }
const emptyError = (): ErrorAccumulator => ({ count: 0, absolute: 0, squared: 0, bias: 0 });
function observeError(row: ErrorAccumulator, predicted: number, actual: number) {
  const difference = predicted - actual; row.count++; row.absolute += Math.abs(difference);
  row.squared += difference ** 2; row.bias += difference;
}
const finishError = (row: ErrorAccumulator) => ({ count: row.count,
  maeBps: row.count ? row.absolute / row.count : null,
  rmseBps: row.count ? Math.sqrt(row.squared / row.count) : null,
  meanErrorBps: row.count ? row.bias / row.count : null });

function costOnlyMeans(samples: DistributionSample[], cutoffMs: number) {
  const sums = new Map<string, { costs: number; weight: number }>();
  for (const sample of samples) {
    const weight = 2 ** (-(cutoffMs - sample.completedAtMs) / S.memoryHalfLifeMs);
    for (const outcome of sample.outcomes) {
      const key = `${sample.symbol}:${sample.actionId}:${outcome.scenario}`;
      const row = sums.get(key) ?? { costs: 0, weight: 0 };
      row.costs += weight * (outcome.grossBps! - outcome.netBps!); row.weight += weight; sums.set(key, row);
    }
  }
  return new Map([...sums].map(([key, row]) => [key, -row.costs / row.weight]));
}

export function runPredictiveAuditStudy(dataset: Dataset) {
  const freezes = dataset.freezes.map(freeze => {
    const conditional = new ConditionalDistributionModel();
    for (const sample of freeze.samples) if (!conditional.observe(sample)) throw new Error("PREDICTIVE_INVALID_FROZEN_BANK");
    const candidate = new CostAwareRidgeModel(freeze.samples, freeze.cutoffMs);
    return { ...freeze, conditional, candidate, costOnly: costOnlyMeans(freeze.samples, freeze.cutoffMs) };
  });
  const errors = S.symbols.flatMap(symbol => SCENARIOS.map(scenario => ({ symbol, scenario: scenario.id,
    probes: 0, unknown: 0, common: 0, origins: new Set<number>(), commonOrigins: new Set<number>(),
    availability: Object.fromEntries(PREDICTIVE_MODELS.map(name => [name, 0])) as Record<PredictiveModelName, number>,
    own: Object.fromEntries(PREDICTIVE_MODELS.map(name => [name, emptyError()])) as Record<PredictiveModelName, ErrorAccumulator>,
    paired: Object.fromEntries(PREDICTIVE_MODELS.map(name => [name, emptyError()])) as Record<PredictiveModelName, ErrorAccumulator>,
    grossCandidate: emptyError(), grossZero: emptyError(), costCandidate: emptyError(),
    actualGrossSum: 0, actualCostSum: 0, actualNetSum: 0 })));
  const prepared: PreparedProbe[] = [];
  const forecasts: Array<{ symbol: string; atMs: number; eventIndex: number; cutoffMs: number; bankSha256: string;
    actionId: string; supportReady: boolean; reasons: string[];
    means: Record<PredictiveModelName, Array<number | null>>;
    candidate: ReturnType<CostAwareRidgeModel["predictScenarios"]> }> = [];
  for (const probe of dataset.probes) {
    const freeze = [...freezes].reverse().find(f => f.cutoffMs <= probe.atMs);
    if (!freeze) throw new Error("PREDICTIVE_MISSING_FREEZE");
    const point: PreparedProbe = { symbol: probe.symbol, atMs: probe.atMs, eventIndex: probe.eventIndex,
      features: [...probe.features], actions: [], outcomes: structuredClone(probe.outcomes) };
    for (const action of ACTIONS) {
      const stored = probe.predictions.find(p => p.actionId === action.id)!;
      const original = freeze.conditional.predictScenarios(probe.symbol, action.id, probe.features, probe.atMs);
      const support = freeze.conditional.estimate(probe.symbol, action.id, probe.features, probe.atMs, 3);
      const supportReady = ["POSITIVE_DISTRIBUTIONAL_SCORE", "SCORE_BELOW_MINIMUM"].includes(support.reason)
        && (dataset.source.assets[probe.symbol]!.shortable || action.side === 1);
      const candidate = freeze.candidate.predictScenarios(probe.symbol, action.id, probe.features, probe.atMs);
      const means = Object.fromEntries(PREDICTIVE_MODELS.map(name => [name, SCENARIOS.map((scenario, i) => {
        const historical = stored.forecast.find(f => f.scenario === scenario.id)!;
        if (original[i]!.meanNetBps !== historical.efficient) throw new Error("PREDICTIVE_CONDITIONAL_FORECAST_MISMATCH");
        return name === "conditional" ? historical.efficient : name === "unconditional" ? historical.unconditionalEfficient
          : name === "cost-only" ? freeze.costOnly.get(`${probe.symbol}:${action.id}:${scenario.id}`) ?? null
            : candidate.find(c => c.scenario === scenario.id)!.meanNetBps;
      })])) as Record<PredictiveModelName, Array<number | null>>;
      point.actions.push({ actionId: action.id, supportReady, means });
      forecasts.push({ symbol: probe.symbol, atMs: probe.atMs, eventIndex: probe.eventIndex,
        cutoffMs: freeze.cutoffMs, bankSha256: freeze.sha256, actionId: action.id, supportReady,
        reasons: candidate.map(c => c.reason), means: structuredClone(means), candidate });
      const outcomes = probe.outcomes.find(o => o.actionId === action.id)!.outcomes;
      for (let i = 0; i < SCENARIOS.length; i++) {
        const scenario = SCENARIOS[i]!, outcome = outcomes.find(o => o.scenario === scenario.id)!;
        const row = errors.find(r => r.symbol === probe.symbol && r.scenario === scenario.id)!;
        row.probes++; row.origins.add(probe.atMs);
        for (const name of PREDICTIVE_MODELS) row.availability[name] += Number(means[name][i] !== null);
        if (outcome.status === "INVALID") { row.unknown++; continue; }
        for (const name of PREDICTIVE_MODELS) if (means[name][i] !== null)
          observeError(row.own[name], means[name][i]!, outcome.netBps!);
        if (PREDICTIVE_MODELS.some(name => means[name][i] === null)) continue;
        row.common++; row.commonOrigins.add(probe.atMs);
        for (const name of PREDICTIVE_MODELS) observeError(row.paired[name], means[name][i]!, outcome.netBps!);
        const c = candidate.find(c => c.scenario === scenario.id)!;
        observeError(row.grossCandidate, c.grossBps!, outcome.grossBps!);
        observeError(row.grossZero, 0, outcome.grossBps!);
        observeError(row.costCandidate, c.costBps!, outcome.grossBps! - outcome.netBps!);
        row.actualGrossSum += outcome.grossBps!; row.actualCostSum += outcome.grossBps! - outcome.netBps!;
        row.actualNetSum += outcome.netBps!;
      }
    }
    prepared.push(point);
  }
  return { version: PREDICTIVE_STUDY_SPEC.version, spec: PREDICTIVE_STUDY_SPEC,
    source: dataset.source, status: "DEVELOPMENT_ONLY", brokerOrdersSubmitted: 0, deploymentReady: false,
    profitabilityEstablished: false, modelFrozenBeforeEvaluation: true,
    freezeDiagnostics: freezes.map(f => ({ cutoffMs: f.cutoffMs, bankSha256: f.sha256,
      samples: f.samples.length, candidate: f.candidate.diagnostics() })),
    predictions: errors.map(r => ({ symbol: r.symbol, scenario: r.scenario, actionPaths: r.probes,
      assetOrigins: r.origins.size, dates: [...new Set([...r.origins].map(date))], unknown: r.unknown,
      availability: r.availability, commonActionPaths: r.common, commonAssetOrigins: r.commonOrigins.size,
      ownAvailableErrors: Object.fromEntries(PREDICTIVE_MODELS.map(n => [n, finishError(r.own[n])])),
      commonErrors: Object.fromEntries(PREDICTIVE_MODELS.map(n => [n, finishError(r.paired[n])])),
      grossPrediction: { candidate: finishError(r.grossCandidate), zeroGrossBaseline: finishError(r.grossZero) },
      costPrediction: finishError(r.costCandidate),
      commonActualMeans: { grossBps: r.common ? r.actualGrossSum / r.common : null,
        costBps: r.common ? r.actualCostSum / r.common : null, netBps: r.common ? r.actualNetSum / r.common : null } })),
    forecasts, forecastsSha256: hash(forecasts), policy: evaluateProbePolicies(prepared),
    limitations: [
      "Inspected historical development data; chronological labels cannot establish an untouched holdout.",
      "One fixed candidate, with no evaluation-driven hyperparameter search or automatic deployment.",
      "Gross forecasts target the existing action's executable outcome including its stops, targets, horizon, and partial fills; they are not unrestricted midpoint forecasts.",
      "Common finite prediction rows are compared identically; availability and own-available errors expose missing predictions.",
      "Six actions and three scenarios at an origin share market paths and are not independent observations.",
      "The diagnostic sparse policy uses a common mean-return threshold and support screen; it is not the production risk-score policy or one-second opportunity stream.",
      "Recorded execution outcomes are reused unchanged. The audit cannot simulate altered size, exits, latency, or fee rules without raw replay.",
      "Unknown selected outcomes invalidate full-period scenario-return claims. Known-only sums are partial and are not account P&L.",
      "A forecast-error improvement may only improve cost calibration. Beating the zero-gross baseline can also reflect an intercept or fill-fraction effect and does not isolate directional feature value.",
    ] };
}
