import { buildHorizonResearchActions, HORIZON_RESEARCH_SPEC, type HorizonResearchAction } from "./horizon-spec.js";
import { DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC, type DistributionOutcome } from "./spec.js";

export interface HorizonResearchPanel {
  symbol: string; signalAtMs: number; completedAtMs: number; volatility30mBps: number; features: number[];
  paths: Array<{ action: HorizonResearchAction; outcomes: DistributionOutcome[] }>;
}
export interface HorizonAssessmentOptions { trainingStartMs: number; laterStartMs: number }
type Period = "TRAINING" | "LATER";
type Family = HorizonResearchAction["family"];
type Scope = Family | "ALL";
interface Day { count: number; sum: number }
interface Aggregate {
  period: Period; symbol: string; actionId: string | null; family: Scope; scenario: string;
  opportunities: number; knownOutcomes: number; filled: number; partialFills: number; unfilled: number;
  flat: number; invalidOrMissing: number; netSum: number; grossSum: number;
  holdingMsSum: number; holdingCount: number; reasons: Record<string, number>; days: Map<number, Day>;
}
interface Observation {
  status: "FILLED" | "UNFILLED" | "INVALID" | "FLAT"; reason: string;
  netBps: number | null; grossBps: number | null; filledFraction: number;
  entryAtMs: number | null; exitAtMs: number;
}
export interface HorizonTrainingCandidate {
  actionId: string; family: Family; trainingPanels: number; trainingDays: number;
  worstScenarioLowerMeanNetBps: number | null; eligible: boolean; reason: string;
}
interface LockedPolicy {
  symbol: string; scope: Scope; actionId: string | null; family: Family | null;
  reason: string; trainingPanels: number; trainingDays: number; worstTrainingLowerMeanNetBps: number | null;
  trainingRanking: HorizonTrainingCandidate[]; later: Aggregate[]; laterCommon: Aggregate[];
}
const families: readonly Family[] = ["LEGACY", "FIXED_CONTROL", "VOLATILITY"];
const catalog = buildHorizonResearchActions(0);
const safeTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const key = (period: Period, symbol: string, actionId: string, scenario: string) => `${period}|${symbol}|${actionId}|${scenario}`;
const countReason = (counts: Record<string, number>, reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; };

function aggregate(period: Period, symbol: string, actionId: string | null, family: Scope, scenario: string): Aggregate {
  return { period, symbol, actionId, family, scenario, opportunities: 0, knownOutcomes: 0, filled: 0,
    partialFills: 0, unfilled: 0, flat: 0, invalidOrMissing: 0, netSum: 0, grossSum: 0,
    holdingMsSum: 0, holdingCount: 0, reasons: {}, days: new Map() };
}
function observe(row: Aggregate, outcome: Observation, signalAtMs: number): void {
  row.opportunities++; countReason(row.reasons, outcome.reason);
  if (outcome.status === "INVALID") { row.invalidOrMissing++; return; }
  row.knownOutcomes++; row.netSum += outcome.netBps!; row.grossSum += outcome.grossBps!;
  row.filled += Number(outcome.status === "FILLED");
  row.partialFills += Number(outcome.status === "FILLED" && outcome.filledFraction < 1);
  row.unfilled += Number(outcome.status === "UNFILLED"); row.flat += Number(outcome.status === "FLAT");
  if (outcome.entryAtMs !== null) { row.holdingMsSum += outcome.exitAtMs - outcome.entryAtMs; row.holdingCount++; }
  const day = Math.floor(signalAtMs / 86_400_000), block = row.days.get(day) ?? { count: 0, sum: 0 };
  block.count++; block.sum += outcome.netBps!; row.days.set(day, block);
}
function daySummary(row: Aggregate) {
  const values = [...row.days.values()].map(day => day.sum / day.count);
  if (!values.length) return { dayMeanNetBps: null, lowerMeanNetBps: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { dayMeanNetBps: mean, lowerMeanNetBps: null };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { dayMeanNetBps: mean,
    lowerMeanNetBps: mean - DISTRIBUTION_SPEC.uncertaintyMultiplier * Math.sqrt(Math.max(1, variance) / values.length) };
}
function summarize(row: Aggregate) {
  const { days, netSum, grossSum, holdingMsSum, holdingCount, ...counts } = row;
  const complete = row.opportunities > 0 && row.invalidOrMissing === 0;
  const daily = daySummary(row);
  return { ...counts, observedDays: days.size,
    meanNetBps: complete ? netSum / row.opportunities : null,
    meanGrossBps: complete ? grossSum / row.opportunities : null,
    normalizedNetUsdAt12: complete ? netSum * 12 / 10_000 : null,
    knownOutcomeMeanNetBps: row.knownOutcomes ? netSum / row.knownOutcomes : null,
    knownOutcomeNetSumBps: row.knownOutcomes ? netSum : null,
    normalizedKnownOutcomeNetUsdAt12: row.knownOutcomes ? netSum * 12 / 10_000 : null,
    meanHoldingMs: holdingCount ? holdingMsSum / holdingCount : null,
    dayMeanNetBps: complete ? daily.dayMeanNetBps : null,
    lowerMeanNetBps: complete ? daily.lowerMeanNetBps : null };
}
function invalid(reason: string, atMs: number): Observation {
  return { status: "INVALID", reason, netBps: null, grossBps: null, filledFraction: 0, entryAtMs: null, exitAtMs: atMs };
}

/** Streaming comparison of frozen counterfactual policies on identical origins.
 * The caller must flush/purge pending training panels, then lockSelection before
 * processing its first event at or after laterStartMs. No later return selects
 * or changes the benchmark, and no outcome is installed in the live engine. */
export class StreamingHorizonAssessment {
  private readonly common = new Map<string, Aggregate>();
  private readonly individual = new Map<string, Aggregate>();
  private readonly lastSignals = new Map<string, number>();
  private readonly lastCompletions = new Map<string, number>();
  private policies: LockedPolicy[] | null = null;
  private finished = false;
  private counts = { panels: 0, beforeTraining: 0, trainingPanels: 0, laterPanels: 0,
    completeCommonTrainingPanels: 0, completeCommonLaterPanels: 0, invalidOrMissingTrainingPanels: 0,
    invalidOrMissingLaterPanels: 0, boundaryPurgedTrainingPanels: 0, trainingPanelsAfterLock: 0 };
  private readonly invalidReasons: Record<string, number> = {};

  public constructor(private readonly options: HorizonAssessmentOptions) {
    if (!safeTime(options.trainingStartMs) || !safeTime(options.laterStartMs)
      || options.trainingStartMs >= options.laterStartMs) throw new Error("INVALID_HORIZON_ASSESSMENT_BOUNDARIES");
    this.options = { ...options };
    for (const period of ["TRAINING", "LATER"] as const) for (const symbol of DISTRIBUTION_SPEC.symbols) {
      for (const action of catalog) for (const scenario of DISTRIBUTION_SCENARIOS) {
        const id = key(period, symbol, action.id, scenario.id);
        this.common.set(id, aggregate(period, symbol, action.id, action.family, scenario.id));
        this.individual.set(id, aggregate(period, symbol, action.id, action.family, scenario.id));
      }
    }
  }

  public observePanel(panel: HorizonResearchPanel): void {
    if (this.finished) throw new Error("HORIZON_ASSESSMENT_FINISHED");
    if (!panel || !DISTRIBUTION_SPEC.symbols.some(symbol => symbol === panel.symbol)
      || !safeTime(panel.signalAtMs) || !safeTime(panel.completedAtMs) || panel.completedAtMs < panel.signalAtMs
      || !Number.isFinite(panel.volatility30mBps) || panel.volatility30mBps < 0
      || !Array.isArray(panel.features) || panel.features.length !== DISTRIBUTION_SPEC.featureDimension
      || !panel.features.every(value => Number.isFinite(value) && Math.abs(value) <= 1)
      || !Array.isArray(panel.paths)) throw new Error("INVALID_HORIZON_PANEL");
    const lastSignal = this.lastSignals.get(panel.symbol), lastCompletion = this.lastCompletions.get(panel.symbol);
    if (lastSignal !== undefined && (panel.signalAtMs < lastSignal + HORIZON_RESEARCH_SPEC.proposalIntervalMs
      || panel.signalAtMs < lastCompletion!)) throw new Error("OVERLAPPING_OR_REVERSED_HORIZON_PANEL");
    const period = panel.signalAtMs < this.options.trainingStartMs ? null
      : panel.signalAtMs < this.options.laterStartMs ? "TRAINING" : "LATER";
    if (period === "LATER" && !this.policies) throw new Error("HORIZON_SELECTION_MUST_LOCK_BEFORE_LATER_DATA");
    const expected = buildHorizonResearchActions(panel.volatility30mBps);
    for (const path of panel.paths) {
      const action = expected.find(candidate => candidate.id === path?.action?.id);
      if (!action || Object.keys(action).some(field => action[field as keyof HorizonResearchAction]
        !== path.action[field as keyof HorizonResearchAction]) || !Array.isArray(path.outcomes)) {
        throw new Error("HORIZON_ACTION_NOT_FROZEN_AT_ORIGIN");
      }
    }
    this.lastSignals.set(panel.symbol, panel.signalAtMs); this.lastCompletions.set(panel.symbol, panel.completedAtMs);
    this.counts.panels++;
    if (!period) { this.counts.beforeTraining++; return; }
    if (period === "TRAINING") this.counts.trainingPanels++; else this.counts.laterPanels++;
    const observations = new Map<string, Observation>();
    for (const action of expected) {
      const paths = panel.paths.filter(path => path.action.id === action.id);
      for (const scenario of DISTRIBUTION_SCENARIOS) {
        const outcome = paths.length !== 1 ? invalid(paths.length ? "DUPLICATE_ACTION" : "MISSING_ACTION", panel.completedAtMs)
          : this.readOutcome(panel, paths[0]!.outcomes, scenario.id);
        observations.set(`${action.id}|${scenario.id}`, outcome);
        observe(this.individual.get(key(period, panel.symbol, action.id, scenario.id))!, outcome, panel.signalAtMs);
        if (outcome.status === "INVALID") countReason(this.invalidReasons, outcome.reason);
      }
    }
    const complete = [...observations.values()].every(outcome => outcome.status !== "INVALID");
    if (!complete) {
      if (period === "TRAINING") this.counts.invalidOrMissingTrainingPanels++;
      else this.counts.invalidOrMissingLaterPanels++;
    }
    const crossesBoundary = period === "TRAINING" && (panel.completedAtMs >= this.options.laterStartMs
      || panel.paths.some(path => path.outcomes.some(outcome => outcome?.exitAtMs >= this.options.laterStartMs)));
    if (crossesBoundary) this.counts.boundaryPurgedTrainingPanels++;
    const afterLock = period === "TRAINING" && this.policies !== null;
    if (afterLock) this.counts.trainingPanelsAfterLock++;
    const admitted = complete && !crossesBoundary && !afterLock;
    if (admitted) {
      if (period === "TRAINING") this.counts.completeCommonTrainingPanels++;
      else this.counts.completeCommonLaterPanels++;
      for (const action of expected) for (const scenario of DISTRIBUTION_SCENARIOS) {
        observe(this.common.get(key(period, panel.symbol, action.id, scenario.id))!,
          observations.get(`${action.id}|${scenario.id}`)!, panel.signalAtMs);
      }
    }
    if (period === "LATER") for (const policy of this.policies!.filter(policy => policy.symbol === panel.symbol)) {
      for (const scenario of DISTRIBUTION_SCENARIOS) {
        const outcome = policy.actionId === null ? { status: "FLAT" as const, reason: "STAY_FLAT", netBps: 0,
          grossBps: 0, filledFraction: 0, entryAtMs: null, exitAtMs: panel.signalAtMs }
          : observations.get(`${policy.actionId}|${scenario.id}`)!;
        observe(policy.later.find(row => row.scenario === scenario.id)!, outcome, panel.signalAtMs);
        if (admitted) observe(policy.laterCommon.find(row => row.scenario === scenario.id)!, outcome, panel.signalAtMs);
      }
    }
  }

  private readOutcome(panel: HorizonResearchPanel, outcomes: DistributionOutcome[], scenario: string): Observation {
    const latencyMs = DISTRIBUTION_SCENARIOS.find(expected => expected.id === scenario)!.latencyMs;
    if (outcomes.some(outcome => !outcome || !DISTRIBUTION_SCENARIOS.some(expected => expected.id === outcome.scenario))) {
      return invalid("UNEXPECTED_SCENARIO", panel.completedAtMs);
    }
    const matches = outcomes.filter(outcome => outcome?.scenario === scenario);
    if (matches.length !== 1) return invalid(matches.length ? "DUPLICATE_SCENARIO" : "MISSING_SCENARIO", panel.completedAtMs);
    const outcome = matches[0]!;
    if (!safeTime(outcome.exitAtMs) || outcome.exitAtMs < panel.signalAtMs || outcome.exitAtMs > panel.completedAtMs
      || typeof outcome.reason !== "string" || !outcome.reason
      || !Number.isFinite(outcome.filledFraction) || outcome.filledFraction < 0 || outcome.filledFraction > 1
      || (outcome.entryAtMs !== null && (!safeTime(outcome.entryAtMs) || outcome.entryAtMs < panel.signalAtMs
        || outcome.entryAtMs > outcome.exitAtMs))) return invalid("MALFORMED_OUTCOME", panel.completedAtMs);
    if (outcome.status === "INVALID") return invalid(outcome.reason, outcome.exitAtMs);
    if (!Number.isFinite(outcome.netBps) || !Number.isFinite(outcome.grossBps)
      || outcome.netBps! > outcome.grossBps! + 1e-8 || outcome.exitAtMs < panel.signalAtMs + latencyMs
      || (outcome.status !== "FILLED" && outcome.status !== "UNFILLED")
      || (outcome.status === "FILLED" && (outcome.entryAtMs === null || outcome.filledFraction <= 0
        || outcome.entryAtMs < panel.signalAtMs + latencyMs || outcome.exitAtMs < outcome.entryAtMs + latencyMs))
      || (outcome.status === "UNFILLED" && (outcome.entryAtMs !== null || outcome.filledFraction !== 0
        || outcome.netBps !== 0 || outcome.grossBps !== 0))) return invalid("MALFORMED_OUTCOME", panel.completedAtMs);
    return { ...outcome };
  }

  public lockSelection(): void {
    if (this.policies) return;
    this.policies = [];
    for (const symbol of DISTRIBUTION_SPEC.symbols) for (const scope of ["ALL", ...families] as const) {
      const ranking = catalog.filter(action => scope === "ALL" || action.family === scope).map(action => {
        const rows = DISTRIBUTION_SCENARIOS.map(scenario => this.common.get(key("TRAINING", symbol, action.id, scenario.id))!);
        const trainingPanels = Math.min(...rows.map(row => row.knownOutcomes));
        const trainingDays = Math.min(...rows.map(row => row.days.size));
        const lowers = rows.map(row => daySummary(row).lowerMeanNetBps);
        const worst = lowers.every(value => value !== null && Number.isFinite(value)) ? Math.min(...lowers as number[]) : null;
        const reason = trainingPanels < HORIZON_RESEARCH_SPEC.minimumTrainingPanels ? "INSUFFICIENT_TRAINING_PANELS"
          : trainingDays < HORIZON_RESEARCH_SPEC.minimumTrainingDays ? "INSUFFICIENT_TRAINING_DAYS"
            : worst === null || worst <= DISTRIBUTION_SPEC.minimumScoreBps ? "TRAINING_LOWER_MEAN_BELOW_MINIMUM" : "POSITIVE_TRAINING_LOWER_MEAN";
        return { actionId: action.id, family: action.family, trainingPanels, trainingDays,
          worstScenarioLowerMeanNetBps: worst, eligible: reason === "POSITIVE_TRAINING_LOWER_MEAN", reason } satisfies HorizonTrainingCandidate;
      }).sort((a, b) => Number(b.eligible) - Number(a.eligible)
        || (b.worstScenarioLowerMeanNetBps ?? -Infinity) - (a.worstScenarioLowerMeanNetBps ?? -Infinity)
        || a.actionId.localeCompare(b.actionId));
      const best = ranking[0]!, selected = best.eligible ? best : null;
      this.policies.push({ symbol, scope, actionId: selected?.actionId ?? null, family: selected?.family ?? null,
        reason: best.reason, trainingPanels: best.trainingPanels, trainingDays: best.trainingDays,
        worstTrainingLowerMeanNetBps: best.worstScenarioLowerMeanNetBps, trainingRanking: ranking,
        later: DISTRIBUTION_SCENARIOS.map(scenario => aggregate("LATER", symbol, selected?.actionId ?? null, scope, scenario.id)),
        laterCommon: DISTRIBUTION_SCENARIOS.map(scenario => aggregate("LATER", symbol, selected?.actionId ?? null, scope, scenario.id)) });
    }
  }

  public finish() {
    this.lockSelection(); this.finished = true;
    const policies = this.policies!.map(({ later, laterCommon, ...policy }) => ({ ...policy,
      later: later.map(summarize), laterCommon: laterCommon.map(summarize) }));
    return structuredClone({ version: `${HORIZON_RESEARCH_SPEC.version}:assessment-v1`, boundaries: this.options,
      ...this.counts, selectionLocked: true, minimumTrainingPanels: HORIZON_RESEARCH_SPEC.minimumTrainingPanels,
      minimumTrainingDays: HORIZON_RESEARCH_SPEC.minimumTrainingDays, minimumLowerMeanNetBps: DISTRIBUTION_SPEC.minimumScoreBps,
      actionComparisons: [...this.common.values()].map(summarize),
      individualCoverage: [...this.individual.values()].map(summarize),
      selectedPolicies: policies.filter(policy => policy.scope === "ALL"),
      familyComparisons: policies.filter(policy => policy.scope !== "ALL"), invalidReasons: this.invalidReasons,
      brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false,
      assumptions: [
        "All 26 actions and three execution stresses share each 31-minute origin; common comparisons require every path to be known",
        "Individual coverage retains known short outcomes when other actions fail; unmatched known-outcome means never rank a horizon or family",
        "Training panels touching the later boundary are jointly purged, and training observations arriving after the explicit lock cannot change selection",
        "Each asset's overall and family benchmarks lock one action or FLAT using preceding common training panels only; later returns never select a winner",
        "The fixed training winner is a diagnostic benchmark, not the live conditional model, an optimized live strategy, or authorization to deploy",
        "Selection needs 24 common training panels across three UTC dates and every scenario's daily-cluster lower mean strictly above one basis point",
        "Daily means receive equal weight; the 2.58 uncertainty multiplier and one-square-basis-point variance floor are fixed approximations, not calibrated coverage guarantees",
        "Selected later results retain invalid selected paths as unknown; laterCommon restricts every family to identical complete panels",
        "Net basis-point outcomes already include fill fraction, fees, spread, visible-depth fills and reserve; they are not charged again",
        "normalizedNetUsdAt12 scales each hypothetical basis-point outcome to a standardized twelve-dollar denominator; it is neither exact simulated cash P&L nor live account profit",
        "BTC and ETH are separate counterfactual arms; their results are not combined into a shared-portfolio P&L",
        "Volatility-derived action parameters are frozen at the origin and checked against the fixed specification",
        "Recorded data was available during design; chronological later data is not claimed to be an untouched holdout",
        "Unknown paths are never assigned zero; genuine nonfills and FLAT receive zero, and zero filled trades do not establish profit",
      ] });
  }
}
export type HorizonAssessmentReport = ReturnType<StreamingHorizonAssessment["finish"]>;
