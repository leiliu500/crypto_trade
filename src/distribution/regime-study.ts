import { createHash } from "node:crypto";
import { ConditionalDistributionModel } from "./model.js";
import { RegimeDistributionModel, REGIME_DISTRIBUTION_SPEC } from "./regime-model.js";
import type { PredictiveAuditData } from "./predictive-audit-data.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_SCENARIOS as SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionEstimate, type DistributionOutcome, type DistributionSample } from "./spec.js";

export const REGIME_STUDY_MODELS = ["conditional", "regime", "unconditional", "cost-only"] as const;
export type RegimeStudyModel = typeof REGIME_STUDY_MODELS[number];
export const REGIME_STUDY_POLICIES = [...REGIME_STUDY_MODELS, "regime-mean-diagnostic", "flat", "long-15m", "short-15m", "momentum-15m"] as const;
type Policy = typeof REGIME_STUDY_POLICIES[number];
export const REGIME_STUDY_SPEC = Object.freeze({ version: "btc-eth-native-regime-study-v1", researchOnly: true,
  candidate: REGIME_DISTRIBUTION_SPEC, minimumTrainingDays: 3,
  support: "EACH_MODEL_NATIVE_SUPPORT", modelPolicy: "CONDITIONAL_AND_REGIME_EXACT_ROBUSTNESS_ELIGIBILITY",
  baselinePolicy: "WHOLE_ACTION_BANK_SUPPORT_AND_WORST_NET_MEAN_ABOVE_ONE",
  fixedPolicySupport: "WHOLE_ACTION_BANK_SUPPORT", meanDiagnosticThresholdExclusive: 1,
  portfolioSlotsPerPolicy: 1, untouched: false, automaticPromotion: false });

export interface NativeActionEvidence {
  means: Array<number | null>; supportReady: boolean; eligible: boolean; reason: string; scoreBps: number | null;
}
export interface PreparedRegimeProbe {
  symbol: string; atMs: number; eventIndex: number; features: number[];
  actions: Array<{ actionId: string; models: Record<RegimeStudyModel, NativeActionEvidence> }>;
  outcomes: Array<{ actionId: string; eventIndex: number; outcomes: DistributionOutcome[] }>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finiteMeans = (means: Array<number | null>): means is number[] => means.length === SCENARIOS.length
  && means.every((n): n is number => n !== null && Number.isFinite(n));
const worstMean = (means: Array<number | null>) => finiteMeans(means) ? Math.min(...means) : null;
const supportReady = (estimate: DistributionEstimate) => ["SCORE_BELOW_MINIMUM", "POSITIVE_DISTRIBUTIONAL_SCORE"].includes(estimate.reason);
const pathKey = (symbol: string, atMs: number, actionId: string) => `${symbol}:${atMs}:${actionId}`;

/** Outcomes become available only at their archived receipt event. A terminal
 * unknown path releases this hypothetical slot but never becomes zero P&L. */
export function evaluateRegimeProbePolicies(probes: PreparedRegimeProbe[]) {
  const rows = REGIME_STUDY_POLICIES.flatMap(policy => S.symbols.flatMap(symbol => SCENARIOS.map(s => ({
    policy, symbol: symbol as string, scenario: s.id as string, selections: 0, filled: 0, unfilled: 0, unknown: 0, knownNetBpsSum: 0 }))));
  const slots = new Map<Policy, string>(), lastCompletion = new Map<Policy, number>();
  const selections: Array<{ policy: Policy; symbol: string; actionId: string; atMs: number; eventIndex: number;
    scoreBps: number | null; predictedWorstNetBps: number | null }> = [];
  const realized: Array<{ policy: Policy; symbol: string; actionId: string; atMs: number; eventIndex: number; outcomes: DistributionOutcome[] }> = [];
  const events = probes.flatMap(p => [{ kind: "FORECAST" as const, index: p.eventIndex, probe: p, outcome: null },
    ...p.outcomes.map(o => ({ kind: "OUTCOME" as const, index: o.eventIndex, probe: p, outcome: o }))]).sort((a, b) => a.index - b.index);
  if (new Set(events.map(e => e.index)).size !== events.length) throw new Error("REGIME_STUDY_DUPLICATE_EVENT_INDEX");
  for (const event of events) {
    const p = event.probe;
    if (event.kind === "OUTCOME") {
      const o = event.outcome!;
      if (event.index <= p.eventIndex) throw new Error("REGIME_STUDY_OUTCOME_BEFORE_FORECAST");
      if (o.outcomes.length !== SCENARIOS.length || new Set(o.outcomes.map(v => v.scenario)).size !== SCENARIOS.length
        || SCENARIOS.some(s => !o.outcomes.some(v => v.scenario === s.id))) throw new Error("REGIME_STUDY_MISSING_SCENARIO");
      for (const policy of REGIME_STUDY_POLICIES) if (slots.get(policy) === pathKey(p.symbol, p.atMs, o.actionId)) {
        for (const value of o.outcomes) {
          const row = rows.find(r => r.policy === policy && r.symbol === p.symbol && r.scenario === value.scenario)!;
          if (value.status === "INVALID") {
            if (value.netBps !== null) throw new Error("REGIME_STUDY_UNKNOWN_RETURN"); row.unknown++;
          } else {
            if (value.netBps === null || !Number.isFinite(value.netBps)) throw new Error("REGIME_STUDY_INVALID_KNOWN_RETURN");
            row.filled += Number(value.status === "FILLED"); row.unfilled += Number(value.status === "UNFILLED"); row.knownNetBpsSum += value.netBps;
          }
        }
        realized.push({ policy, symbol: p.symbol, actionId: o.actionId, atMs: p.atMs, eventIndex: event.index, outcomes: structuredClone(o.outcomes) });
        slots.delete(policy); lastCompletion.set(policy, Math.max(...o.outcomes.map(v => v.exitAtMs)));
      }
      continue;
    }
    for (const policy of REGIME_STUDY_POLICIES) {
      if (policy === "flat" || slots.has(policy) || p.atMs <= (lastCompletion.get(policy) ?? -1)) continue;
      let choice: { actionId: string; scoreBps: number | null; predictedWorstNetBps: number | null } | undefined;
      if ((REGIME_STUDY_MODELS as readonly string[]).includes(policy) || policy === "regime-mean-diagnostic") {
        const model: RegimeStudyModel = policy === "regime-mean-diagnostic" ? "regime" : policy as RegimeStudyModel;
        choice = p.actions.flatMap(action => {
          const evidence = action.models[model], mean = worstMean(evidence.means);
          const eligible = policy === "regime-mean-diagnostic" ? evidence.supportReady && mean !== null && mean > 1 : evidence.eligible;
          const score = policy === "regime-mean-diagnostic" ? mean : evidence.scoreBps;
          return eligible && mean !== null && score !== null && Number.isFinite(score)
            ? [{ actionId: action.actionId, scoreBps: score, predictedWorstNetBps: mean }] : [];
        }).sort((a, b) => b.scoreBps! - a.scoreBps! || a.actionId.localeCompare(b.actionId))[0];
      } else {
        const id = policy === "momentum-15m" ? p.features[7] === 0 ? undefined : p.features[7]! > 0 ? "long-15m" : "short-15m" : policy;
        const action = p.actions.find(a => a.actionId === id && a.models.unconditional.supportReady);
        if (action) choice = { actionId: action.actionId, scoreBps: null, predictedWorstNetBps: null };
      }
      if (!choice) continue;
      slots.set(policy, pathKey(p.symbol, p.atMs, choice.actionId));
      selections.push({ policy, symbol: p.symbol, atMs: p.atMs, eventIndex: p.eventIndex, ...choice });
      for (const row of rows) if (row.policy === policy && row.symbol === p.symbol) row.selections++;
    }
  }
  if (slots.size) throw new Error("REGIME_STUDY_MISSING_SELECTED_OUTCOME");
  const aggregates = REGIME_STUDY_POLICIES.flatMap(policy => SCENARIOS.map(s => {
    const total = rows.filter(r => r.policy === policy && r.scenario === s.id).reduce((a, r) => ({
      selections: a.selections + r.selections, filled: a.filled + r.filled, unfilled: a.unfilled + r.unfilled,
      unknown: a.unknown + r.unknown, knownNetBpsSum: a.knownNetBpsSum + r.knownNetBpsSum }),
    { selections: 0, filled: 0, unfilled: 0, unknown: 0, knownNetBpsSum: 0 });
    return { policy, scenario: s.id, ...total, fullPathKnownNetBpsSum: total.unknown ? null : total.knownNetBpsSum,
      knownMeanNetBps: total.filled + total.unfilled ? total.knownNetBpsSum / (total.filled + total.unfilled) : null };
  }));
  return { livePolicyEquivalent: false, bpsAreRequestedNotionalOutcomes: true, compoundedPortfolioReturn: false,
    policyDefinitions: { conditional: "Original model native support and exact lower-mean/tail score eligibility",
      regime: "Regime model native leaf support and exact lower-mean/tail score eligibility",
      unconditionalAndCostOnly: "Whole-bank support and worst-scenario predicted mean >1bp; diagnostic policies",
      regimeMeanDiagnostic: "Native regime support and worst-scenario predicted mean >1bp; excludes robustness score",
      fixedBaselines: "Whole-bank support, fixed 15-minute action, including original stops and targets" },
    unknownPathAssumption: "An observed INVALID terminal record releases the hypothetical slot. Its full-period scenario return remains unknown.",
    rows: rows.map(r => ({ ...r, fullPathKnownNetBpsSum: r.unknown ? null : r.knownNetBpsSum })), aggregates,
    selections, realized, selectionsSha256: hash(selections) };
}

function wholeBank(samples: DistributionSample[], cutoffMs: number) {
  const banks = new Map<string, DistributionSample[]>();
  for (const sample of samples) { const key = `${sample.symbol}:${sample.actionId}`, rows = banks.get(key) ?? []; rows.push(sample); banks.set(key, rows); }
  return (symbol: string, actionId: string, nowMs: number) => {
    const rows = banks.get(`${symbol}:${actionId}`) ?? [], weights = rows.map(r => 2 ** (-(nowMs - r.completedAtMs) / S.memoryHalfLifeMs));
    const total = weights.reduce((s, w) => s + w, 0), squares = weights.reduce((s, w) => s + w * w, 0), days = new Map<number, number>();
    rows.forEach((r, i) => { const d = Math.floor(r.signalAtMs / 86_400_000); days.set(d, (days.get(d) ?? 0) + weights[i]!); });
    const effective = squares ? total * total / squares : 0, observedDays = [...days.values()].filter(w => w >= 1).length;
    const latest = rows.length ? Math.max(...rows.map(r => r.completedAtMs)) : null;
    const reason = rows.length < 48 ? "INSUFFICIENT_SAMPLES" : effective < 32 ? "INSUFFICIENT_EFFECTIVE_SAMPLES"
      : observedDays < 3 ? "INSUFFICIENT_DAYS" : latest === null || nowMs - latest > S.maximumTrainingAgeMs ? "STALE_TRAINING" : "READY";
    const unconditional = SCENARIOS.map(s => rows.length ? rows.reduce((sum, r) => sum + r.outcomes.find(o => o.scenario === s.id)!.netBps!, 0) / rows.length : null);
    const costOnly = SCENARIOS.map(s => {
      let cost = 0, weight = 0;
      for (const r of rows) { const w = 2 ** (-(cutoffMs - r.completedAtMs) / S.memoryHalfLifeMs), o = r.outcomes.find(o => o.scenario === s.id)!;
        cost += w * (o.grossBps! - o.netBps!); weight += w; }
      return weight ? -cost / weight : null;
    });
    return { samples: rows.length, effectiveSamples: effective, observedDays, reason, unconditional, costOnly };
  };
}
interface Errors { count: number; absolute: number; squared: number; bias: number }
const errors = (): Errors => ({ count: 0, absolute: 0, squared: 0, bias: 0 });
function addError(row: Errors, forecast: number, actual: number) { const e = forecast - actual; row.count++; row.absolute += Math.abs(e); row.squared += e * e; row.bias += e; }
const finishError = (row: Errors) => ({ count: row.count, maeBps: row.count ? row.absolute / row.count : null,
  rmseBps: row.count ? Math.sqrt(row.squared / row.count) : null, meanErrorBps: row.count ? row.bias / row.count : null });

/** Fixed historical training banks, with each model's own support definition.
 * Partition rebuilds may reflect deterministic time aging, never test labels. */
export function runRegimeAuditStudy(dataset: PredictiveAuditData) {
  const freezes = dataset.freezes.map(f => {
    if (f.samples.some(s => s.completedAtMs >= f.cutoffMs)) throw new Error("REGIME_STUDY_FUTURE_TRAINING");
    const conditional = new ConditionalDistributionModel(), regime = new RegimeDistributionModel();
    for (const sample of f.samples) if (!conditional.observe(sample) || !regime.observe(sample)) throw new Error("REGIME_STUDY_INVALID_TRAINING");
    return { ...f, conditional, regime, whole: wholeBank(f.samples, f.cutoffMs) };
  });
  const metricRows = S.symbols.flatMap(symbol => SCENARIOS.map(scenario => ({ symbol, scenario: scenario.id,
    actionPaths: 0, origins: new Set<number>(), unknown: 0, common: 0, commonOrigins: new Set<number>(),
    availability: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, 0])) as Record<RegimeStudyModel, number>,
    own: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, errors()])) as Record<RegimeStudyModel, Errors>,
    paired: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, errors()])) as Record<RegimeStudyModel, Errors>,
    grossRegime: errors(), grossZero: errors(), cost: errors() })));
  const opportunityRows = S.symbols.flatMap(symbol => REGIME_STUDY_MODELS.map(model => ({ symbol, model,
    actionPaths: 0, nativeSupportReady: 0, finiteForecasts: 0, positiveWorstMean: 0, supportedPositiveWorstMean: 0, eligible: 0,
    allScenariosKnown: 0, unknownPaths: 0, knownBaseWinners: 0, knownRobustWinners: 0,
    eligibleKnownPaths: 0, eligibleRobustWinners: 0, missedRobustWinners: 0,
    missedByReason: {} as Record<string, number> })));
  const forecasts: Array<{ symbol: string; atMs: number; eventIndex: number; cutoffMs: number; bankSha256: string;
    actionId: string; models: Record<RegimeStudyModel, NativeActionEvidence>; conditional: DistributionEstimate;
    regime: DistributionEstimate; wholeBankSupport: { samples: number; effectiveSamples: number; observedDays: number; reason: string };
    regimePredictions: ReturnType<RegimeDistributionModel["predictScenarios"]> }> = [];
  const prepared: PreparedRegimeProbe[] = [];
  for (const probe of dataset.probes) {
    const f = [...freezes].reverse().find(f => f.cutoffMs <= probe.atMs); if (!f) throw new Error("REGIME_STUDY_NO_FREEZE");
    const p: PreparedRegimeProbe = { symbol: probe.symbol, atMs: probe.atMs, eventIndex: probe.eventIndex,
      features: [...probe.features], actions: [], outcomes: structuredClone(probe.outcomes) };
    for (const action of ACTIONS) {
      const conditional = f.conditional.estimate(probe.symbol, action.id, probe.features, probe.atMs, 3);
      const regime = f.regime.estimate(probe.symbol, action.id, probe.features, probe.atMs, 3);
      const original = f.conditional.predictScenarios(probe.symbol, action.id, probe.features, probe.atMs);
      const candidate = f.regime.predictScenarios(probe.symbol, action.id, probe.features, probe.atMs, 3);
      const bank = f.whole(probe.symbol, action.id, probe.atMs), sideAllowed = dataset.source.assets[probe.symbol]!.shortable || action.side === 1;
      const stored = probe.predictions.find(p => p.actionId === action.id)!;
      for (const [i, scenario] of SCENARIOS.entries()) if (stored.forecast.find(s => s.scenario === scenario.id)!.efficient !== original[i]!.meanNetBps)
        throw new Error("REGIME_STUDY_ORIGINAL_FORECAST_MISMATCH");
      const native = (means: Array<number | null>, estimate: DistributionEstimate): NativeActionEvidence => ({ means,
        supportReady: sideAllowed && supportReady(estimate), eligible: sideAllowed && estimate.eligible,
        reason: sideAllowed ? estimate.reason : "NOT_SHORTABLE", scoreBps: estimate.scoreBps });
      const baseline = (means: Array<number | null>): NativeActionEvidence => {
        const mean = worstMean(means), ready = sideAllowed && bank.reason === "READY";
        return { means, supportReady: ready, eligible: ready && mean !== null && mean > 1,
          reason: !sideAllowed ? "NOT_SHORTABLE" : bank.reason !== "READY" ? bank.reason : mean !== null && mean > 1 ? "POSITIVE_MEAN" : "MEAN_BELOW_MINIMUM", scoreBps: mean };
      };
      const models = { conditional: native(original.map(s => s.meanNetBps), conditional), regime: native(candidate.map(s => s.meanNetBps), regime),
        unconditional: baseline(bank.unconditional), "cost-only": baseline(bank.costOnly) };
      forecasts.push({ symbol: probe.symbol, atMs: probe.atMs, eventIndex: probe.eventIndex, cutoffMs: f.cutoffMs,
        bankSha256: f.sha256, actionId: action.id, models, conditional, regime,
        wholeBankSupport: { samples: bank.samples, effectiveSamples: bank.effectiveSamples, observedDays: bank.observedDays, reason: bank.reason }, regimePredictions: candidate });
      p.actions.push({ actionId: action.id, models });
      const outcomes = probe.outcomes.find(o => o.actionId === action.id)!.outcomes;
      const known = outcomes.every(o => o.status !== "INVALID"), robustWinner = known && outcomes.every(o => o.netBps! > 0);
      for (const model of REGIME_STUDY_MODELS) {
        const row = opportunityRows.find(r => r.symbol === probe.symbol && r.model === model)!, evidence = models[model], mean = worstMean(evidence.means);
        row.actionPaths++; row.nativeSupportReady += Number(evidence.supportReady); row.finiteForecasts += Number(mean !== null);
        row.positiveWorstMean += Number(mean !== null && mean > 1); row.supportedPositiveWorstMean += Number(evidence.supportReady && mean !== null && mean > 1);
        row.eligible += Number(evidence.eligible); row.allScenariosKnown += Number(known); row.unknownPaths += Number(!known);
        const base = outcomes.find(o => o.scenario === "base-250ms")!;
        row.knownBaseWinners += Number(base.status !== "INVALID" && base.netBps! > 0); row.knownRobustWinners += Number(robustWinner);
        row.eligibleKnownPaths += Number(evidence.eligible && known); row.eligibleRobustWinners += Number(evidence.eligible && robustWinner);
        if (robustWinner && !evidence.eligible) { row.missedRobustWinners++; row.missedByReason[evidence.reason] = (row.missedByReason[evidence.reason] ?? 0) + 1; }
      }
      for (const [index, scenario] of SCENARIOS.entries()) {
        const row = metricRows.find(r => r.symbol === probe.symbol && r.scenario === scenario.id)!, outcome = outcomes.find(o => o.scenario === scenario.id)!;
        row.actionPaths++; row.origins.add(probe.atMs);
        for (const m of REGIME_STUDY_MODELS) row.availability[m] += Number(models[m].means[index] !== null);
        if (outcome.status === "INVALID") { row.unknown++; continue; }
        for (const m of REGIME_STUDY_MODELS) if (models[m].means[index] !== null) addError(row.own[m], models[m].means[index]!, outcome.netBps!);
        if (REGIME_STUDY_MODELS.some(m => models[m].means[index] === null)) continue;
        row.common++; row.commonOrigins.add(probe.atMs);
        for (const m of REGIME_STUDY_MODELS) addError(row.paired[m], models[m].means[index]!, outcome.netBps!);
        if (candidate[index]!.grossBps === null || candidate[index]!.costBps === null) throw new Error("REGIME_STUDY_MISSING_COMPONENT");
        addError(row.grossRegime, candidate[index]!.grossBps!, outcome.grossBps!); addError(row.grossZero, 0, outcome.grossBps!);
        addError(row.cost, candidate[index]!.costBps!, outcome.grossBps! - outcome.netBps!);
      }
    }
    prepared.push(p);
  }
  return { version: REGIME_STUDY_SPEC.version, spec: REGIME_STUDY_SPEC, source: dataset.source, status: "DEVELOPMENT_ONLY",
    frozenTrainingBanks: true, partitionsMayRebuildFromDeterministicTimeAging: true,
    freezeDiagnostics: freezes.map(f => ({ cutoffMs: f.cutoffMs, samples: f.samples.length, sha256: f.sha256, finalRegimeDiagnostics: f.regime.diagnostics() })),
    predictions: metricRows.map(r => ({ symbol: r.symbol, scenario: r.scenario, actionPaths: r.actionPaths, assetOrigins: r.origins.size,
      dates: [...new Set([...r.origins].map(t => new Date(t).toISOString().slice(0, 10)))], unknown: r.unknown, availability: r.availability,
      commonActionPaths: r.common, commonAssetOrigins: r.commonOrigins.size,
      ownAvailableErrors: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, finishError(r.own[m])])),
      commonErrors: Object.fromEntries(REGIME_STUDY_MODELS.map(m => [m, finishError(r.paired[m])])),
      grossPrediction: { regime: finishError(r.grossRegime), zeroGrossBaseline: finishError(r.grossZero) }, costPrediction: finishError(r.cost) })),
    opportunities: opportunityRows.map(r => ({ ...r, eligibleKnownRobustPrecision: r.eligibleKnownPaths ? r.eligibleRobustWinners / r.eligibleKnownPaths : null,
      knownRobustRecall: r.knownRobustWinners ? r.eligibleRobustWinners / r.knownRobustWinners : null })),
    forecasts, forecastsSha256: hash(forecasts), policy: evaluateRegimeProbePolicies(prepared),
    brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false,
    limitations: ["Both archived windows were previously inspected; no untouched holdout or automatic promotion is claimed.",
      "Conditional geometry, supervised tree leaves, and whole-bank baselines have different native support. Counts expose those differences.",
      "Prediction errors are ungated where forecasts exist; common rows and own-available rows are both reported.",
      "Gross predictions target original executable action returns, including stops, targets, horizons, and fills; zero-gross comparisons do not isolate directional skill.",
      "Known winners and missed winners are ex-post diagnostic action labels, not attainable simultaneous portfolio profits.",
      "Precision and recall count dependent actions at shared origins, not independent market contexts or statistical proof.",
      "A sparse probe-grid policy differs from the live one-second strategy; recorded paths cannot simulate changed execution rules.",
      "Unknown selected outcomes leave full-period scenario returns null. Known-only sums are partial requested-notional basis points, not account P&L.",
      "Model parameters and thresholds are fixed before this run; deterministic aging may rebuild partitions from the unchanged training bank."] };
}
