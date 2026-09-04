import type { Direction } from "../core/market.js";
import type { CalibratedEdgeBucket } from "../calibration/calibrated-edge-table.js";
import type { EntryFamily, ExecutionPath } from "../economics/types.js";
import type { RegimeName } from "../strategy/deterministic-regime.js";

export type AlphaRouteStyle = "maker" | "taker";

export interface AlphaResearchObservation {
  decisionId: string;
  configurationVersion: string;
  symbol: string;
  family: EntryFamily;
  side: Direction;
  regime: RegimeName;
  executionPath: ExecutionPath;
  routeStyle: AlphaRouteStyle;
  horizonMs: number;
  signalAtMs: number;
  signalSpreadBps: number | null;
  signalQuality: number | null;
  predictedNetBps: number | null;
  modeledCostBps: number;
  realizedNetBps: number;
  makerFillProbability: number | null;
  makerFilled: boolean | null;
  makerFillOutcomeKnown: boolean | null;
}

export interface AlphaPromotionPolicy {
  minimumIndependentSamples: number;
  minimumCoverageMs: number;
  walkForwardFolds: number;
  minimumOutOfSampleSamples: number;
  confidenceZ: number;
  minimumMakerFillAuc: number;
  maximumBucketSpreadBps: number;
}

export interface AlphaFoldResult {
  fold: number;
  trainingSamples: number;
  testSamples: number;
  trainingEndMs: number;
  testStartMs: number;
  testEndMs: number;
  meanTestNetBps: number;
}

export interface AlphaCohortEvaluation {
  cohortKey: string;
  configurationVersion: string;
  symbol: string;
  family: EntryFamily;
  side: Direction;
  regime: RegimeName;
  executionPath: ExecutionPath;
  routeStyle: AlphaRouteStyle;
  horizonMs: number;
  rawSamples: number;
  independentSamples: number;
  outOfSampleSamples: number;
  coverageMs: number;
  validationFolds: number;
  meanOutOfSampleNetBps: number | null;
  lowerConfidenceNetBps: number | null;
  predictedRealizedCorrelation: number | null;
  predictionMaeBps: number | null;
  makerFillAuc: number | null;
  folds: readonly AlphaFoldResult[];
  promoted: boolean;
  rejectionReasons: readonly string[];
  calibratedBucket: CalibratedEdgeBucket | null;
}

export interface AlphaResearchReport {
  generatedAtMs: number;
  policy: AlphaPromotionPolicy;
  observations: number;
  configurationVersions: readonly string[];
  cohorts: readonly AlphaCohortEvaluation[];
  promotedCohorts: number;
  rejectedCohorts: number;
}

export const DEFAULT_ALPHA_PROMOTION_POLICY: AlphaPromotionPolicy = {
  minimumIndependentSamples: 100,
  minimumCoverageMs: 7 * 86_400_000,
  walkForwardFolds: 3,
  minimumOutOfSampleSamples: 30,
  confidenceZ: 1.645,
  minimumMakerFillAuc: .55,
  maximumBucketSpreadBps: 1_000,
};

/**
 * Evaluates route and holding-horizon alternatives chronologically. Samples are
 * purged by their own outcome horizon, preventing one market move from being
 * counted repeatedly. Only the best validated route/horizon for each
 * symbol/family/side/regime cohort is promoted.
 */
export function evaluateAlphaResearch(observations: readonly AlphaResearchObservation[],
  policy: AlphaPromotionPolicy = DEFAULT_ALPHA_PROMOTION_POLICY,
  generatedAtMs = Date.now()): AlphaResearchReport {
  validatePolicy(policy);
  const groups = new Map<string, AlphaResearchObservation[]>();
  for (const observation of observations) {
    if (!validObservation(observation)) continue;
    const key = alphaCohortKey(observation);
    const values = groups.get(key) ?? [];
    values.push(observation);
    groups.set(key, values);
  }
  const evaluated = [...groups.entries()].map(([key, values]) => evaluateCohort(key, values, policy));
  const byStrategyCohort = new Map<string, AlphaCohortEvaluation[]>();
  for (const cohort of evaluated) {
    const key = strategyCohortKey(cohort);
    const values = byStrategyCohort.get(key) ?? [];
    values.push(cohort);
    byStrategyCohort.set(key, values);
  }
  const final: AlphaCohortEvaluation[] = [];
  for (const values of byStrategyCohort.values()) {
    const eligible = values.filter((value) => value.rejectionReasons.length === 0)
      .sort((left, right) => (right.lowerConfidenceNetBps ?? Number.NEGATIVE_INFINITY)
        - (left.lowerConfidenceNetBps ?? Number.NEGATIVE_INFINITY));
    const winner = eligible[0]?.cohortKey;
    for (const value of values) {
      if (value.rejectionReasons.length === 0 && value.cohortKey !== winner) {
        final.push({ ...value, promoted: false,
          rejectionReasons: ["NOT_BEST_ROUTE_HORIZON"], calibratedBucket: null });
      } else if (value.cohortKey === winner) {
        final.push({ ...value, promoted: true });
      } else final.push(value);
    }
  }
  final.sort((left, right) => left.cohortKey.localeCompare(right.cohortKey));
  return {
    generatedAtMs,
    policy: { ...policy },
    observations: observations.length,
    configurationVersions: [...new Set(observations.map((value) => value.configurationVersion))].sort(),
    cohorts: final,
    promotedCohorts: final.filter((value) => value.promoted).length,
    rejectedCohorts: final.filter((value) => !value.promoted).length,
  };
}

export function alphaCohortKey(value: Pick<AlphaResearchObservation, "configurationVersion" | "symbol" | "family"
  | "side" | "regime" | "executionPath" | "routeStyle" | "horizonMs">): string {
  return [value.configurationVersion, value.symbol, value.family, value.side, value.regime,
    value.executionPath, value.routeStyle, value.horizonMs].join("|");
}

export function independentAlphaSamples(observations: readonly AlphaResearchObservation[]): AlphaResearchObservation[] {
  const sorted = [...observations].sort((left, right) => left.signalAtMs - right.signalAtMs
    || left.decisionId.localeCompare(right.decisionId));
  const independent: AlphaResearchObservation[] = [];
  for (const observation of sorted) {
    const previous = independent.at(-1);
    if (!previous || observation.signalAtMs - previous.signalAtMs >= observation.horizonMs) independent.push(observation);
  }
  return independent;
}

export function rocAuc(scores: readonly number[], labels: readonly boolean[]): number | null {
  if (scores.length !== labels.length || scores.length < 2) return null;
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0 || scores.some((value) => !Number.isFinite(value))) return null;
  const ranked = scores.map((score, index) => ({ score, label: labels[index]! }))
    .sort((left, right) => left.score - right.score);
  let positiveRankSum = 0;
  let index = 0;
  while (index < ranked.length) {
    let end = index + 1;
    while (end < ranked.length && ranked[end]!.score === ranked[index]!.score) end += 1;
    const averageRank = ((index + 1) + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) if (ranked[cursor]!.label) positiveRankSum += averageRank;
    index = end;
  }
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function evaluateCohort(cohortKey: string, observations: readonly AlphaResearchObservation[],
  policy: AlphaPromotionPolicy): AlphaCohortEvaluation {
  const independent = independentAlphaSamples(observations);
  const first = independent[0]!;
  const coverageMs = independent.length < 2 ? 0
    : independent.at(-1)!.signalAtMs - independent[0]!.signalAtMs;
  const folds = purgedWalkForward(independent, policy);
  const testObservations = folds.flatMap((fold) => independent.filter((observation) =>
    observation.signalAtMs >= fold.testStartMs && observation.signalAtMs <= fold.testEndMs));
  const oosReturns = testObservations.map((value) => value.realizedNetBps);
  const average = oosReturns.length > 0 ? mean(oosReturns) : null;
  const standardError = oosReturns.length > 1 ? sampleStandardDeviation(oosReturns) / Math.sqrt(oosReturns.length) : null;
  const lower = average !== null && standardError !== null ? average - policy.confidenceZ * standardError : null;
  const pairedPredictions = testObservations.filter((value) => value.predictedNetBps !== null);
  const predicted = pairedPredictions.map((value) => value.predictedNetBps!);
  const realized = pairedPredictions.map((value) => value.realizedNetBps);
  const makerSamples = testObservations.filter((value) => value.routeStyle === "maker"
    && value.makerFillOutcomeKnown === true
    && value.makerFillProbability !== null && value.makerFilled !== null);
  const makerFillAuc = first.routeStyle === "maker"
    ? rocAuc(makerSamples.map((value) => value.makerFillProbability!), makerSamples.map((value) => value.makerFilled!))
    : null;
  const reasons: string[] = [];
  if (independent.length < policy.minimumIndependentSamples) reasons.push("INSUFFICIENT_INDEPENDENT_SAMPLES");
  if (coverageMs < policy.minimumCoverageMs) reasons.push("INSUFFICIENT_TIME_COVERAGE");
  if (folds.length < policy.walkForwardFolds) reasons.push("INSUFFICIENT_WALK_FORWARD_FOLDS");
  if (oosReturns.length < policy.minimumOutOfSampleSamples) reasons.push("INSUFFICIENT_OUT_OF_SAMPLE_SAMPLES");
  if (lower === null || lower <= 0) reasons.push("NON_POSITIVE_OUT_OF_SAMPLE_LOWER_BOUND");
  if (first.routeStyle === "maker" && makerFillAuc === null) reasons.push("MAKER_FILL_AUC_UNAVAILABLE");
  else if (first.routeStyle === "maker" && makerFillAuc !== null
    && makerFillAuc < policy.minimumMakerFillAuc) reasons.push("MAKER_FILL_AUC_BELOW_MINIMUM");
  const averageModeledCost = mean(independent.map((value) => value.modeledCostBps));
  const bucket: CalibratedEdgeBucket | null = reasons.length === 0 && average !== null && lower !== null ? {
    symbol: first.symbol, family: first.family, side: first.side, regime: first.regime,
    minimumQuality: 0, maximumQuality: 1, minimumSpreadBps: 0,
    maximumSpreadBps: policy.maximumBucketSpreadBps,
    horizonMs: first.horizonMs, path: first.executionPath,
    meanGrossReturnBps: average + averageModeledCost,
    lowerConfidenceGrossReturnBps: lower + averageModeledCost,
    effectiveSampleCount: independent.length,
  } : null;
  return {
    cohortKey, configurationVersion: first.configurationVersion, symbol: first.symbol,
    family: first.family, side: first.side, regime: first.regime, executionPath: first.executionPath,
    routeStyle: first.routeStyle, horizonMs: first.horizonMs, rawSamples: observations.length,
    independentSamples: independent.length, outOfSampleSamples: oosReturns.length, coverageMs,
    validationFolds: folds.length, meanOutOfSampleNetBps: average, lowerConfidenceNetBps: lower,
    predictedRealizedCorrelation: predicted.length >= 2 ? correlation(predicted, realized) : null,
    predictionMaeBps: predicted.length > 0 ? mean(predicted.map((value, index) => Math.abs(value - realized[index]!))) : null,
    makerFillAuc, folds, promoted: false, rejectionReasons: reasons, calibratedBucket: bucket,
  };
}

function purgedWalkForward(observations: readonly AlphaResearchObservation[], policy: AlphaPromotionPolicy): AlphaFoldResult[] {
  if (observations.length < 4) return [];
  const firstTestIndex = Math.max(1, Math.floor(observations.length * .4));
  const testPopulation = observations.length - firstTestIndex;
  const foldSize = Math.max(1, Math.floor(testPopulation / policy.walkForwardFolds));
  const minimumTrainingSamples = Math.max(10, Math.floor(policy.minimumIndependentSamples * .2));
  const folds: AlphaFoldResult[] = [];
  for (let fold = 0; fold < policy.walkForwardFolds; fold += 1) {
    const start = firstTestIndex + fold * foldSize;
    const end = fold === policy.walkForwardFolds - 1 ? observations.length : Math.min(observations.length, start + foldSize);
    const test = observations.slice(start, end);
    if (test.length === 0) continue;
    const testStartMs = test[0]!.signalAtMs;
    const training = observations.slice(0, start).filter((value) => value.signalAtMs + value.horizonMs < testStartMs);
    if (training.length < minimumTrainingSamples) continue;
    folds.push({ fold: fold + 1, trainingSamples: training.length, testSamples: test.length,
      trainingEndMs: training.at(-1)!.signalAtMs, testStartMs, testEndMs: test.at(-1)!.signalAtMs,
      meanTestNetBps: mean(test.map((value) => value.realizedNetBps)) });
  }
  return folds;
}

function strategyCohortKey(value: Pick<AlphaCohortEvaluation, "configurationVersion" | "symbol" | "family" | "side" | "regime">): string {
  return [value.configurationVersion, value.symbol, value.family, value.side, value.regime].join("|");
}

function validObservation(value: AlphaResearchObservation): boolean {
  return Boolean(value.decisionId && value.configurationVersion && value.symbol)
    && [1, -1].includes(value.side)
    && Number.isFinite(value.horizonMs) && value.horizonMs > 0
    && Number.isFinite(value.signalAtMs) && value.signalAtMs >= 0
    && Number.isFinite(value.modeledCostBps) && value.modeledCostBps >= 0
    && Number.isFinite(value.realizedNetBps);
}

function validatePolicy(policy: AlphaPromotionPolicy): void {
  if (!Number.isInteger(policy.minimumIndependentSamples) || policy.minimumIndependentSamples < 2
    || !Number.isFinite(policy.minimumCoverageMs) || policy.minimumCoverageMs <= 0
    || !Number.isInteger(policy.walkForwardFolds) || policy.walkForwardFolds < 2
    || !Number.isInteger(policy.minimumOutOfSampleSamples) || policy.minimumOutOfSampleSamples < 2
    || !Number.isFinite(policy.confidenceZ) || policy.confidenceZ <= 0
    || !Number.isFinite(policy.minimumMakerFillAuc) || policy.minimumMakerFillAuc < .5 || policy.minimumMakerFillAuc > 1
    || !Number.isFinite(policy.maximumBucketSpreadBps) || policy.maximumBucketSpreadBps <= 0) {
    throw new Error("Invalid alpha promotion policy");
  }
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}
function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
}
function correlation(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = mean(left), rightMean = mean(right);
  let covariance = 0, leftVariance = 0, rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean, rightDelta = right[index]! - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : 0;
}
