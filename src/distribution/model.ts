import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC, DISTRIBUTION_ENTRY_PROFILES,
  type DistributionEstimate, type DistributionSample } from "./spec.js";

const DAY_MS = 86_400_000;
/** Fixed support restrictions on the already scaled market features. These are
 * abstention rules, not parameters selected by a profit search. */
export const DISTRIBUTION_SUPPORT = Object.freeze({ maximumDistance: 1.5,
  maximumCoordinateDistance: 1, minimumWeight: .01, minimumDayWeight: 1 });

interface Bank { samples: DistributionSample[]; lastSignalAtMs: number; completedAtMs: number }
interface Neighbor { sample: DistributionSample; weight: number }
interface ScenarioEstimate { mean: number; lower: number; tail: number; score: number; fillProbability: number }
export interface DistributionScenarioPrediction {
  scenario: string; meanNetBps: number | null; samples: number; effectiveSamples: number;
}

function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function validFeatures(features: readonly number[]): boolean {
  return Array.isArray(features) && features.length === DISTRIBUTION_SPEC.featureDimension
    && features.every(value => Number.isFinite(value) && Math.abs(value) <= 1);
}
function validPredictionInput(symbol: string, actionId: string, features: readonly number[], nowMs: number): boolean {
  return (DISTRIBUTION_SPEC.symbols as readonly string[]).includes(symbol)
    && DISTRIBUTION_ACTIONS.some(a => a.id === actionId) && validTime(nowMs) && validFeatures(features);
}

function weightedTailLoss(values: Array<{ value: number; weight: number }>, totalWeight: number): number {
  let remaining = totalWeight * DISTRIBUTION_SPEC.tailFraction, numerator = 0;
  const tailWeight = remaining;
  for (const { value, weight } of values.sort((a, b) => a.value - b.value)) {
    const included = Math.min(remaining, weight);
    numerator += included * value; remaining -= included;
    if (remaining <= 0) break;
  }
  return Math.max(0, -numerator / tailWeight);
}

/** Conditional empirical executable returns, including nonfills and partial
 * fills on the original requested notional. No costs are subtracted twice.
 *
 * The lower mean is an approximate robustness score: max(individual SE,
 * UTC-day clustered SE) times a fixed multiplier. It is not a calibrated
 * confidence bound under arbitrary dependence or a guarantee about new tails.
 * Each action has a separate bank of nonoverlapping completed outcomes. */
export class ConditionalDistributionModel {
  private readonly banks = new Map<string, Bank>();
  private accepted = 0;
  private readonly rejected: Record<string, number> = {};

  public observe(sample: DistributionSample): boolean {
    const invalid = this.invalidSample(sample);
    if (invalid) return this.reject(invalid);
    const key = `${sample.symbol}:${sample.actionId}`, previous = this.banks.get(key);
    // IDs encode the origin. This permanent timestamp watermark also rejects
    // duplicates after their full outcome has left the bounded sample bank.
    if (previous && (sample.signalAtMs <= previous.lastSignalAtMs
      || sample.signalAtMs < previous.completedAtMs)) return this.reject("DUPLICATE_OVERLAPPING_OR_REVERSED_SAMPLE");
    const copy: DistributionSample = { ...sample, features: [...sample.features], outcomes: sample.outcomes.map(o => ({ ...o })) };
    const bank = previous ?? { samples: [], lastSignalAtMs: -1, completedAtMs: -1 };
    bank.samples.push(copy);
    if (bank.samples.length > DISTRIBUTION_SPEC.maximumSamples) bank.samples.shift();
    bank.lastSignalAtMs = sample.signalAtMs; bank.completedAtMs = sample.completedAtMs;
    this.banks.set(key, bank); this.accepted++;
    return true;
  }

  public estimate(symbol: string, actionId: string, features: readonly number[], nowMs: number,
    minimumTrainingDays: number = DISTRIBUTION_SPEC.minimumDays): DistributionEstimate {
    const empty = (reason: string): DistributionEstimate => ({ actionId, samples: 0, effectiveSamples: 0,
      observedDays: 0, meanNetBps: null, lowerMeanNetBps: null, tailLossBps: null,
      scoreBps: null, fillProbability: 0, eligible: false, reason });
    if (!validPredictionInput(symbol, actionId, features, nowMs)
      || (minimumTrainingDays !== DISTRIBUTION_SPEC.minimumDays
        && minimumTrainingDays !== DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL.minimumTrainingDays)) {
      return empty("INVALID_ESTIMATE_INPUT");
    }
    const { completed, neighbors } = this.completedNeighbors(symbol, actionId, features, nowMs);
    if (!completed.length) return empty("NO_COMPLETED_SAMPLES");
    if (!neighbors.length) return empty("OUT_OF_SUPPORT");
    const totalWeight = neighbors.reduce((sum, n) => sum + n.weight, 0);
    const effectiveSamples = totalWeight ** 2 / neighbors.reduce((sum, n) => sum + n.weight ** 2, 0);
    const dayWeights = new Map<number, number>();
    for (const { sample, weight } of neighbors) {
      const day = Math.floor(sample.signalAtMs / DAY_MS);
      dayWeights.set(day, (dayWeights.get(day) ?? 0) + weight);
    }
    const observedDays = [...dayWeights.values()].filter(weight => weight >= DISTRIBUTION_SUPPORT.minimumDayWeight).length;
    const newest = Math.max(...neighbors.map(n => n.sample.completedAtMs));
    let reason = observedDays < minimumTrainingDays ? "INSUFFICIENT_DAYS"
      : neighbors.length < DISTRIBUTION_SPEC.minimumSamples ? "INSUFFICIENT_SAMPLES"
        : effectiveSamples < DISTRIBUTION_SPEC.minimumEffectiveSamples ? "INSUFFICIENT_EFFECTIVE_SAMPLES"
          : nowMs - newest > DISTRIBUTION_SPEC.maximumTrainingAgeMs ? "STALE_TRAINING" : "POSITIVE_DISTRIBUTIONAL_SCORE";
    const scenarios = DISTRIBUTION_SCENARIOS.map(s => this.scenarioEstimate(neighbors, s.id, totalWeight, effectiveSamples));
    const worst = scenarios.reduce((a, b) => b.score < a.score ? b : a);
    const finite = scenarios.every(s => [s.mean, s.lower, s.tail, s.score, s.fillProbability].every(Number.isFinite));
    if (reason === "POSITIVE_DISTRIBUTIONAL_SCORE" && !finite) reason = "NONFINITE_ESTIMATE";
    if (reason === "POSITIVE_DISTRIBUTIONAL_SCORE" && worst.score <= DISTRIBUTION_SPEC.minimumScoreBps) reason = "SCORE_BELOW_MINIMUM";
    return { actionId, samples: neighbors.length, effectiveSamples, observedDays,
      meanNetBps: Number.isFinite(worst.mean) ? worst.mean : null,
      lowerMeanNetBps: Number.isFinite(worst.lower) ? worst.lower : null,
      tailLossBps: Number.isFinite(worst.tail) ? worst.tail : null,
      scoreBps: Number.isFinite(worst.score) ? worst.score : null,
      fillProbability: Number.isFinite(worst.fillProbability) ? worst.fillProbability : 0,
      reason, eligible: reason === "POSITIVE_DISTRIBUTIONAL_SCORE" };
  }

  /** Read-only forecasts for comparing each execution scenario with its matching
   * later outcome. These are the same supported, shrunk means used by estimate,
   * before eligibility gates. A null mean records absent support or invalid input;
   * it is never a zero-return forecast or permission to trade. */
  public predictScenarios(symbol: string, actionId: string, features: readonly number[], nowMs: number): DistributionScenarioPrediction[] {
    const empty = (): DistributionScenarioPrediction[] => DISTRIBUTION_SCENARIOS.map(s => ({ scenario: s.id,
      meanNetBps: null, samples: 0, effectiveSamples: 0 }));
    if (!validPredictionInput(symbol, actionId, features, nowMs)) return empty();
    const { neighbors } = this.completedNeighbors(symbol, actionId, features, nowMs);
    if (!neighbors.length) return empty();
    const totalWeight = neighbors.reduce((sum, n) => sum + n.weight, 0);
    const effectiveSamples = totalWeight ** 2 / neighbors.reduce((sum, n) => sum + n.weight ** 2, 0);
    return DISTRIBUTION_SCENARIOS.map(s => {
      const mean = this.scenarioEstimate(neighbors, s.id, totalWeight, effectiveSamples).mean;
      return { scenario: s.id, meanNetBps: Number.isFinite(mean) ? mean : null,
        samples: neighbors.length, effectiveSamples };
    });
  }

  private completedNeighbors(symbol: string, actionId: string, features: readonly number[], nowMs: number):
    { completed: DistributionSample[]; neighbors: Neighbor[] } {
    const completed = this.banks.get(`${symbol}:${actionId}`)?.samples.filter(s => s.completedAtMs <= nowMs) ?? [];
    const neighbors: Neighbor[] = [];
    for (const sample of completed) {
      let distanceSquared = 0, maximumCoordinate = 0;
      for (let j = 0; j < features.length; j++) {
        const difference = Math.abs(features[j]! - sample.features[j]!);
        distanceSquared += difference * difference; maximumCoordinate = Math.max(maximumCoordinate, difference);
      }
      if (distanceSquared > DISTRIBUTION_SUPPORT.maximumDistance ** 2
        || maximumCoordinate > DISTRIBUTION_SUPPORT.maximumCoordinateDistance) continue;
      const weight = Math.exp(-distanceSquared / (2 * DISTRIBUTION_SPEC.kernelBandwidth ** 2))
        * 2 ** (-(nowMs - sample.completedAtMs) / DISTRIBUTION_SPEC.memoryHalfLifeMs);
      if (weight >= DISTRIBUTION_SUPPORT.minimumWeight) neighbors.push({ sample, weight });
    }
    return { completed, neighbors };
  }

  public stats() {
    return { version: DISTRIBUTION_SPEC.version, acceptedSamples: this.accepted,
      retainedSamples: [...this.banks.values()].reduce((sum, bank) => sum + bank.samples.length, 0),
      rejectedSamples: Object.values(this.rejected).reduce((sum, count) => sum + count, 0),
      rejectedByReason: { ...this.rejected },
      byAction: DISTRIBUTION_SPEC.symbols.flatMap(symbol => DISTRIBUTION_ACTIONS.map(action => {
        const bank = this.banks.get(`${symbol}:${action.id}`);
        return { symbol, actionId: action.id, samples: bank?.samples.length ?? 0, trainedThroughMs: bank?.completedAtMs ?? null };
      })) };
  }

  private reject(reason: string): false { this.rejected[reason] = (this.rejected[reason] ?? 0) + 1; return false; }

  private invalidSample(sample: DistributionSample): string | null {
    if (!sample || !(DISTRIBUTION_SPEC.symbols as readonly string[]).includes(sample.symbol)
      || !DISTRIBUTION_ACTIONS.some(a => a.id === sample.actionId) || !validTime(sample.signalAtMs)
      || !validTime(sample.completedAtMs) || sample.completedAtMs < sample.signalAtMs
      || sample.id !== `${sample.symbol}:${sample.actionId}:${sample.signalAtMs}` || !validFeatures(sample.features)
      || !Array.isArray(sample.outcomes) || sample.outcomes.length !== DISTRIBUTION_SCENARIOS.length) return "INVALID_SAMPLE_SHAPE";
    const scenarios = new Set<string>();
    for (const outcome of sample.outcomes) {
      if (!outcome) return "INVALID_OUTCOME";
      const scenario = DISTRIBUTION_SCENARIOS.find(s => s.id === outcome.scenario);
      if (!scenario || scenarios.has(outcome.scenario)) return "UNMATCHED_SCENARIOS";
      scenarios.add(outcome.scenario);
      if (!validTime(outcome.exitAtMs) || outcome.exitAtMs < sample.signalAtMs + scenario.latencyMs
        || outcome.exitAtMs > sample.completedAtMs || typeof outcome.reason !== "string"
        || outcome.netBps === null || outcome.grossBps === null || !Number.isFinite(outcome.netBps)
        || !Number.isFinite(outcome.grossBps) || outcome.netBps > outcome.grossBps + 1e-9
        || !Number.isFinite(outcome.filledFraction) || outcome.filledFraction < 0 || outcome.filledFraction > 1) return "INVALID_OUTCOME";
      if (outcome.status === "FILLED") {
        if (outcome.filledFraction <= 0 || outcome.entryAtMs === null || !validTime(outcome.entryAtMs)
          || outcome.entryAtMs < sample.signalAtMs + scenario.latencyMs || outcome.exitAtMs < outcome.entryAtMs) return "INVALID_OUTCOME";
      } else if (outcome.status !== "UNFILLED" || outcome.entryAtMs !== null || outcome.filledFraction !== 0
        || outcome.netBps !== 0 || outcome.grossBps !== 0) return "INVALID_OUTCOME";
    }
    return null;
  }

  private scenarioEstimate(neighbors: Neighbor[], scenario: string, totalWeight: number, effectiveSamples: number): ScenarioEstimate {
    const values = neighbors.map(({ sample, weight }) => ({ sample, weight, outcome: sample.outcomes.find(o => o.scenario === scenario)! }));
    const numerator = values.reduce((sum, v) => sum + v.weight * v.outcome.netBps!, 0);
    const rawMean = numerator / totalWeight, mean = numerator / (totalWeight + DISTRIBUTION_SPEC.priorWeight);
    const individualVariance = values.reduce((sum, v) => sum + v.weight * (v.outcome.netBps! - rawMean) ** 2, 0) / totalWeight;
    const individualSe = effectiveSamples > 1 ? Math.sqrt(individualVariance / (effectiveSamples - 1)) : Infinity;
    const dayResiduals = new Map<number, number>();
    for (const { sample, weight, outcome } of values) {
      const day = Math.floor(sample.signalAtMs / DAY_MS);
      dayResiduals.set(day, (dayResiduals.get(day) ?? 0) + weight * (outcome.netBps! - rawMean));
    }
    const days = dayResiduals.size;
    const clusteredSe = days > 1 ? Math.sqrt(days / (days - 1)
      * [...dayResiduals.values()].reduce((sum, residual) => sum + residual ** 2, 0)) / totalWeight : Infinity;
    const lower = mean - DISTRIBUTION_SPEC.uncertaintyMultiplier * Math.max(individualSe, clusteredSe);
    const tail = weightedTailLoss(values.map(v => ({ value: v.outcome.netBps!, weight: v.weight })), totalWeight);
    const fillProbability = values.reduce((sum, v) => sum + v.weight * Number(v.outcome.status === "FILLED"), 0) / totalWeight;
    return { mean, lower, tail, score: lower - DISTRIBUTION_SPEC.tailPenalty * tail, fillProbability };
  }
}
