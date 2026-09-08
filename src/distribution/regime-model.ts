import { ConditionalDistributionModel, type DistributionScenarioPrediction } from "./model.js";
import { DISTRIBUTION_ACTIONS as ACTIONS, DISTRIBUTION_ENTRY_PROFILES, DISTRIBUTION_SCENARIOS as SCENARIOS,
  DISTRIBUTION_SPEC as S, type DistributionEstimate, type DistributionSample } from "./spec.js";

const DAY_MS = 86_400_000;
/** Fixed before historical evaluation. Coordinate 5 is excluded because its
 * elapsed-time volatility proxy depends on the phase of the retained price
 * sample. Existing feature vectors and historical labels remain unchanged. */
export const REGIME_DISTRIBUTION_SPEC = Object.freeze({
  version: "btc-eth-supervised-regime-distribution-v1", labelVersion: S.version,
  maximumDepth: 2, splitFeatureIndices: Object.freeze([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]),
  excludedFeatureIndices: Object.freeze([5]),
  splitLoss: "MEAN_OF_THREE_RECENCY_WEIGHTED_GROSS_SSE" as const,
  minimumLeafSamples: S.minimumSamples, minimumLeafEffectiveSamples: S.minimumEffectiveSamples,
  minimumLeafDayWeight: 1, minimumTrainingDays: Object.freeze([3, 7] as const),
  grossPriorWeight: S.priorWeight, costPriorWeight: 0,
  memoryHalfLifeMs: S.memoryHalfLifeMs, maximumTrainingAgeMs: S.maximumTrainingAgeMs,
  uncertaintyMultiplier: S.uncertaintyMultiplier, tailFraction: S.tailFraction,
  tailPenalty: S.tailPenalty, minimumScoreBpsExclusive: S.minimumScoreBps,
});

export interface RegimeScenarioPrediction extends DistributionScenarioPrediction {
  grossBps: number | null; costBps: number | null; observedDays: number;
}
interface Row { sample: DistributionSample; weight: number }
interface Aggregate {
  count: number; weight: number; weightSquared: number; days: Map<number, number>;
  gross: number[]; grossSquared: number[];
}
interface Leaf { kind: "leaf"; rows: Row[]; aggregate: Aggregate; depth: number }
interface Branch { kind: "split"; feature: number; threshold: number; depth: number;
  aggregate: Aggregate; left: Tree; right: Tree }
type Tree = Leaf | Branch;
interface Bank { samples: DistributionSample[]; revision: number }
interface CachedTree {
  symbol: string; actionId: string; revision: number; completed: number; lastCompletedId: string;
  minimumDays: number; referenceMs: number; builtAtMs: number; expiresAtMs: number; root: Tree;
}
interface ScenarioEstimate { mean: number; gross: number; cost: number; lower: number;
  tail: number; score: number; fillProbability: number }

const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validDays = (days: number) => days === S.minimumDays || days === DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL.minimumTrainingDays;
const validInput = (symbol: string, actionId: string, features: readonly number[], nowMs: number, days: number) =>
  (S.symbols as readonly string[]).includes(symbol) && ACTIONS.some(a => a.id === actionId)
  && validTime(nowMs) && validDays(days) && Array.isArray(features) && features.length === S.featureDimension
  && features.every(value => Number.isFinite(value) && Math.abs(value) <= 1);
const emptyAggregate = (): Aggregate => ({ count: 0, weight: 0, weightSquared: 0, days: new Map(),
  gross: SCENARIOS.map(() => 0), grossSquared: SCENARIOS.map(() => 0) });
function add(aggregate: Aggregate, row: Row): void {
  aggregate.count++; aggregate.weight += row.weight; aggregate.weightSquared += row.weight ** 2;
  const day = Math.floor(row.sample.signalAtMs / DAY_MS);
  aggregate.days.set(day, (aggregate.days.get(day) ?? 0) + row.weight);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const gross = row.sample.outcomes.find(o => o.scenario === SCENARIOS[i]!.id)!.grossBps!;
    aggregate.gross[i]! += row.weight * gross; aggregate.grossSquared[i]! += row.weight * gross ** 2;
  }
}
function aggregateRows(rows: Row[]): Aggregate {
  const result = emptyAggregate(); for (const row of rows) add(result, row); return result;
}
function subtract(total: Aggregate, left: Aggregate): Aggregate {
  return { count: total.count - left.count, weight: total.weight - left.weight,
    weightSquared: total.weightSquared - left.weightSquared,
    days: new Map([...total.days].map(([day, weight]) => [day, Math.max(0, weight - (left.days.get(day) ?? 0))])),
    gross: total.gross.map((value, i) => value - left.gross[i]!),
    grossSquared: total.grossSquared.map((value, i) => value - left.grossSquared[i]!) };
}
const effective = (a: Aggregate) => a.weightSquared > 0 ? a.weight ** 2 / a.weightSquared : 0;
const observedDays = (a: Aggregate, decay: number) => [...a.days.values()].filter(weight => weight * decay >= 1).length;
const supported = (a: Aggregate, decay: number, days: number) => a.count >= S.minimumSamples
  && effective(a) >= S.minimumEffectiveSamples && observedDays(a, decay) >= days;
function loss(a: Aggregate): number {
  if (!(a.weight > 0)) return Infinity;
  return a.gross.reduce((sum, value, i) => sum + Math.max(0, a.grossSquared[i]! - value ** 2 / a.weight), 0) / SCENARIOS.length;
}

function buildTree(rows: Row[], depth: number, decay: number, days: number): Tree {
  const aggregate = aggregateRows(rows), parentLoss = loss(aggregate);
  const leaf: Leaf = { kind: "leaf", rows, aggregate, depth };
  if (depth >= REGIME_DISTRIBUTION_SPEC.maximumDepth || rows.length < 2 * S.minimumSamples
    || !supported(aggregate, decay, days) || !Number.isFinite(parentLoss)) return leaf;
  let best: { feature: number; threshold: number; improvement: number } | null = null;
  // This tolerance only suppresses floating-point SSE cancellation. Features
  // and ascending thresholds provide a deterministic tie order.
  const tolerance = 1e-12 * Math.max(1, parentLoss);
  for (const feature of REGIME_DISTRIBUTION_SPEC.splitFeatureIndices) {
    const ordered = [...rows].sort((a, b) => a.sample.features[feature]! - b.sample.features[feature]!
      || a.sample.signalAtMs - b.sample.signalAtMs);
    const left = emptyAggregate();
    for (let i = 0; i < ordered.length - 1; i++) {
      add(left, ordered[i]!);
      const a = ordered[i]!.sample.features[feature]!, b = ordered[i + 1]!.sample.features[feature]!;
      if (a === b || left.count < S.minimumSamples || ordered.length - left.count < S.minimumSamples) continue;
      const right = subtract(aggregate, left);
      if (!supported(left, decay, days) || !supported(right, decay, days)) continue;
      const improvement = parentLoss - loss(left) - loss(right);
      if (!Number.isFinite(improvement) || improvement <= tolerance
        || (best && improvement <= best.improvement + tolerance)) continue;
      const midpoint = (a + b) / 2;
      best = { feature, threshold: midpoint < b ? midpoint : a, improvement };
    }
  }
  if (!best) return leaf;
  const left = rows.filter(row => row.sample.features[best.feature]! <= best.threshold);
  const right = rows.filter(row => row.sample.features[best.feature]! > best.threshold);
  // Recompute support on the final groups rather than trusting prefix sums at
  // a floating-point boundary.
  if (!supported(aggregateRows(left), decay, days) || !supported(aggregateRows(right), decay, days)) return leaf;
  return { kind: "split", feature: best.feature, threshold: best.threshold, depth, aggregate,
    left: buildTree(left, depth + 1, decay, days), right: buildTree(right, depth + 1, decay, days) };
}
const leaves = (tree: Tree): Leaf[] => tree.kind === "leaf" ? [tree] : [...leaves(tree.left), ...leaves(tree.right)];
function selectLeaf(tree: Tree, features: readonly number[]): Leaf {
  if (tree.kind === "leaf") return tree;
  return selectLeaf(features[tree.feature]! <= tree.threshold ? tree.left : tree.right, features);
}
function cacheExpiration(root: Tree, referenceMs: number, nowMs: number, days: number): number {
  const decay = 2 ** (-(nowMs - referenceMs) / S.memoryHalfLifeMs);
  let expiration = Infinity;
  for (const leaf of leaves(root)) {
    if (!supported(leaf.aggregate, decay, days)) continue;
    const weights = [...leaf.aggregate.days.values()].sort((a, b) => b - a);
    const lastValidMs = referenceMs + S.memoryHalfLifeMs * Math.log2(weights[days - 1]!);
    expiration = Math.min(expiration, Math.max(nowMs + 1, Math.floor(lastValidMs) + 1));
  }
  return expiration;
}

/** Supervised, shallow partitions of causal gross-return history. It changes
 * conditional estimation; support, execution costs and score gates are retained.
 * The robustness score remains approximate after supervised split selection. */
export class RegimeDistributionModel {
  private readonly validator = new ConditionalDistributionModel();
  private readonly banks = new Map<string, Bank>();
  private readonly trees = new Map<string, CachedTree>();

  public observe(sample: DistributionSample): boolean {
    if (!this.validator.observe(sample)) return false;
    const key = `${sample.symbol}:${sample.actionId}`, bank = this.banks.get(key) ?? { samples: [], revision: 0 };
    // Copy the canonical scalar/array fields. Unrelated extra properties must
    // not make cloning throw after the shared validator has accepted the row.
    bank.samples.push({ id: sample.id, symbol: sample.symbol, actionId: sample.actionId,
      signalAtMs: sample.signalAtMs, completedAtMs: sample.completedAtMs,
      features: [...sample.features], outcomes: sample.outcomes.map(outcome => ({
        scenario: outcome.scenario, status: outcome.status, filledFraction: outcome.filledFraction,
        entryAtMs: outcome.entryAtMs, exitAtMs: outcome.exitAtMs, grossBps: outcome.grossBps,
        netBps: outcome.netBps, reason: outcome.reason })) });
    bank.revision++;
    if (bank.samples.length > S.maximumSamples) bank.samples.shift();
    this.banks.set(key, bank);
    this.trees.delete(`${key}:3`); this.trees.delete(`${key}:7`);
    return true;
  }

  private tree(symbol: string, actionId: string, nowMs: number, days: number): CachedTree | null {
    const key = `${symbol}:${actionId}`, bank = this.banks.get(key);
    const completed = bank?.samples.filter(sample => sample.completedAtMs <= nowMs) ?? [];
    if (!bank || !completed.length) return null;
    const cacheKey = `${key}:${days}`, previous = this.trees.get(cacheKey), last = completed.at(-1)!;
    if (previous && previous.revision === bank.revision && previous.completed === completed.length
      && previous.lastCompletedId === last.id && nowMs >= previous.builtAtMs && nowMs < previous.expiresAtMs) return previous;
    const referenceMs = Math.max(...completed.map(sample => sample.completedAtMs));
    const rows = completed.map(sample => ({ sample, weight: 2 ** (-(referenceMs - sample.completedAtMs) / S.memoryHalfLifeMs) }));
    const decay = 2 ** (-(nowMs - referenceMs) / S.memoryHalfLifeMs), root = buildTree(rows, 0, decay, days);
    const result: CachedTree = { symbol, actionId, revision: bank.revision, completed: completed.length,
      lastCompletedId: last.id, minimumDays: days, referenceMs, builtAtMs: nowMs,
      expiresAtMs: cacheExpiration(root, referenceMs, nowMs, days), root };
    this.trees.set(cacheKey, result); return result;
  }

  private scenario(leaf: Leaf, scenario: string, decay: number): ScenarioEstimate {
    const totalWeight = leaf.aggregate.weight, ess = effective(leaf.aggregate);
    const values = leaf.rows.map(row => ({ ...row, outcome: row.sample.outcomes.find(o => o.scenario === scenario)! }));
    const grossNumerator = values.reduce((sum, row) => sum + row.weight * row.outcome.grossBps!, 0);
    const gross = grossNumerator * decay / (totalWeight * decay + S.priorWeight);
    const cost = values.reduce((sum, row) => sum + row.weight * (row.outcome.grossBps! - row.outcome.netBps!), 0) / totalWeight;
    const mean = gross - cost;
    const rawMean = values.reduce((sum, row) => sum + row.weight * row.outcome.netBps!, 0) / totalWeight;
    const variance = values.reduce((sum, row) => sum + row.weight * (row.outcome.netBps! - rawMean) ** 2, 0) / totalWeight;
    const individualSe = ess > 1 ? Math.sqrt(variance / (ess - 1)) : Infinity;
    const residuals = new Map<number, number>();
    for (const row of values) if (row.weight > 0) {
      const day = Math.floor(row.sample.signalAtMs / DAY_MS);
      residuals.set(day, (residuals.get(day) ?? 0) + row.weight * (row.outcome.netBps! - rawMean));
    }
    const days = residuals.size;
    const clusteredSe = days > 1 ? Math.sqrt(days / (days - 1)
      * [...residuals.values()].reduce((sum, value) => sum + value ** 2, 0)) / totalWeight : Infinity;
    const lower = mean - S.uncertaintyMultiplier * Math.max(individualSe, clusteredSe);
    let remaining = totalWeight * S.tailFraction, numerator = 0;
    for (const row of [...values].sort((a, b) => a.outcome.netBps! - b.outcome.netBps!)) {
      const included = Math.min(remaining, row.weight); numerator += included * row.outcome.netBps!;
      remaining -= included; if (remaining <= 0) break;
    }
    const tail = Math.max(0, -numerator / (totalWeight * S.tailFraction));
    const fillProbability = values.reduce((sum, row) => sum + row.weight * Number(row.outcome.status === "FILLED"), 0) / totalWeight;
    return { mean, gross, cost, lower, tail, score: lower - S.tailPenalty * tail, fillProbability };
  }

  public estimate(symbol: string, actionId: string, features: readonly number[], nowMs: number,
    minimumTrainingDays: number = S.minimumDays): DistributionEstimate {
    const empty = (reason: string): DistributionEstimate => ({ actionId, samples: 0, effectiveSamples: 0,
      observedDays: 0, meanNetBps: null, lowerMeanNetBps: null, tailLossBps: null, scoreBps: null,
      fillProbability: 0, eligible: false, reason });
    if (!validInput(symbol, actionId, features, nowMs, minimumTrainingDays)) return empty("INVALID_ESTIMATE_INPUT");
    const tree = this.tree(symbol, actionId, nowMs, minimumTrainingDays);
    if (!tree) return empty("NO_COMPLETED_SAMPLES");
    const leaf = selectLeaf(tree.root, features), decay = 2 ** (-(nowMs - tree.referenceMs) / S.memoryHalfLifeMs);
    const count = leaf.aggregate.count, ess = effective(leaf.aggregate), days = observedDays(leaf.aggregate, decay);
    const newest = Math.max(...leaf.rows.map(row => row.sample.completedAtMs));
    let reason = days < minimumTrainingDays ? "INSUFFICIENT_DAYS" : count < S.minimumSamples ? "INSUFFICIENT_SAMPLES"
      : ess < S.minimumEffectiveSamples ? "INSUFFICIENT_EFFECTIVE_SAMPLES"
        : nowMs - newest > S.maximumTrainingAgeMs ? "STALE_TRAINING" : "POSITIVE_DISTRIBUTIONAL_SCORE";
    const scenarios = SCENARIOS.map(scenario => this.scenario(leaf, scenario.id, decay));
    const worst = scenarios.reduce((a, b) => b.score < a.score ? b : a);
    const finite = scenarios.every(s => [s.mean, s.gross, s.cost, s.lower, s.tail, s.score, s.fillProbability].every(Number.isFinite));
    if (reason === "POSITIVE_DISTRIBUTIONAL_SCORE" && !finite) reason = "NONFINITE_ESTIMATE";
    if (reason === "POSITIVE_DISTRIBUTIONAL_SCORE" && worst.score <= S.minimumScoreBps) reason = "SCORE_BELOW_MINIMUM";
    return { actionId, samples: count, effectiveSamples: ess, observedDays: days,
      meanNetBps: Number.isFinite(worst.mean) ? worst.mean : null,
      lowerMeanNetBps: Number.isFinite(worst.lower) ? worst.lower : null,
      tailLossBps: Number.isFinite(worst.tail) ? worst.tail : null,
      scoreBps: Number.isFinite(worst.score) ? worst.score : null,
      fillProbability: Number.isFinite(worst.fillProbability) ? worst.fillProbability : 0,
      eligible: reason === "POSITIVE_DISTRIBUTIONAL_SCORE", reason };
  }

  /** Pass the same date requirement as estimate: partition support is part of
   * the model specification. Diagnostic means remain available when a gate fails. */
  public predictScenarios(symbol: string, actionId: string, features: readonly number[], nowMs: number,
    minimumTrainingDays: number = S.minimumDays): RegimeScenarioPrediction[] {
    const empty = () => SCENARIOS.map(scenario => ({ scenario: scenario.id, meanNetBps: null,
      grossBps: null, costBps: null, samples: 0, effectiveSamples: 0, observedDays: 0 }));
    if (!validInput(symbol, actionId, features, nowMs, minimumTrainingDays)) return empty();
    const tree = this.tree(symbol, actionId, nowMs, minimumTrainingDays); if (!tree) return empty();
    const leaf = selectLeaf(tree.root, features), decay = 2 ** (-(nowMs - tree.referenceMs) / S.memoryHalfLifeMs);
    return SCENARIOS.map(scenario => {
      const value = this.scenario(leaf, scenario.id, decay);
      return { scenario: scenario.id, meanNetBps: Number.isFinite(value.mean) ? value.mean : null,
        grossBps: Number.isFinite(value.gross) ? value.gross : null, costBps: Number.isFinite(value.cost) ? value.cost : null,
        samples: leaf.aggregate.count, effectiveSamples: effective(leaf.aggregate), observedDays: observedDays(leaf.aggregate, decay) };
    });
  }

  public stats() { return { ...this.validator.stats(), modelVersion: REGIME_DISTRIBUTION_SPEC.version }; }

  public diagnostics() {
    const describe = (tree: Tree, decay: number): object => {
      const support = { samples: tree.aggregate.count, effectiveSamples: effective(tree.aggregate),
        observedDays: observedDays(tree.aggregate, decay) };
      return tree.kind === "leaf" ? { kind: tree.kind, depth: tree.depth, ...support,
        trainingSampleIds: tree.rows.map(row => row.sample.id) }
        : { kind: tree.kind, depth: tree.depth, ...support, feature: tree.feature, threshold: tree.threshold,
          left: describe(tree.left, decay), right: describe(tree.right, decay) };
    };
    return { version: REGIME_DISTRIBUTION_SPEC.version, spec: REGIME_DISTRIBUTION_SPEC,
      trees: [...this.trees.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId)
        || a.minimumDays - b.minimumDays).map(tree => {
        const terminal = leaves(tree.root);
        return { symbol: tree.symbol, actionId: tree.actionId, minimumTrainingDays: tree.minimumDays,
          builtAtMs: tree.builtAtMs, referenceMs: tree.referenceMs,
          expiresAtMs: Number.isFinite(tree.expiresAtMs) ? tree.expiresAtMs : null,
          leafCount: terminal.length, splitCount: terminal.length - 1,
          maximumDepth: Math.max(...terminal.map(leaf => leaf.depth)),
          tree: describe(tree.root, 2 ** (-(tree.builtAtMs - tree.referenceMs) / S.memoryHalfLifeMs)) };
      }) };
  }
}
