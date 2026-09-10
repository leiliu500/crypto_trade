import { createHash } from "node:crypto";

export interface StudentTrainingRow { readonly features: readonly number[]; readonly target: number; readonly weight: number; }
export interface StudentPrediction { location: number; scale: number; }
export const STUDENT_BOOST_SPEC = Object.freeze({
  version: "btc-eth-hourly-student-natural-boost-v1", degreesOfFreedom: 5,
  maximumRounds: 48, learningRate: .05, maximumDepth: 2, histogramBins: 32,
  minimumLeafSamples: 256, minimumScaleBps: 1, maximumScaleBps: 10_000,
  histogram: "UNWEIGHTED_TRAINING_FEATURE_QUANTILES_FROZEN_BEFORE_BOOSTING" as const,
  splitLoss: "WEIGHTED_SQUARED_NEGATIVE_NATURAL_GRADIENT_ERROR" as const,
  splitTie: "ASCENDING_FEATURE_THEN_ASCENDING_THRESHOLD" as const,
  backtrackingSteps: Object.freeze(Array.from({ length: 11 }, (_, i) => 2 ** -i)),
  backtracking: "COMMON_STEP_FOR_BOTH_HEADS; WEIGHTED_TRAINING_NLL_MUST_NOT_INCREASE" as const,
  scaleInterpretation: "STUDENT_T_SCALE; STANDARD_DEVIATION_IS_SCALE_TIMES_SQRT_5_OVER_3" as const,
  linearBaselineRidgePenalty: 16, linearFeatureScaleFloor: .1,
  temporalValidationOwner: "CALLER; PRIMITIVE_RECEIVES_NO_TIMESTAMPS" as const,
  calibration: "NONE_IN_PRIMITIVE" as const,
});

const NU = 5, SQRT_NU = Math.sqrt(NU), LOG_NORMALIZER = Math.log(3 * Math.PI * SQRT_NU / 8);
const LOG_MIN_SCALE = Math.log(STUDENT_BOOST_SPEC.minimumScaleBps), LOG_MAX_SCALE = Math.log(STUDENT_BOOST_SPEC.maximumScaleBps);
const clampLogScale = (value: number) => Math.max(LOG_MIN_SCALE, Math.min(LOG_MAX_SCALE, value));
const clampScale = (value: number) => Math.max(STUDENT_BOOST_SPEC.minimumScaleBps, Math.min(STUDENT_BOOST_SPEC.maximumScaleBps, value));
const scaleFromLog = (value: number) => clampScale(Math.exp(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function parameters(y: number, location: number, scale: number): number {
  if (![y, location, scale].every(Number.isFinite) || scale <= 0) throw new Error("STUDENT_INVALID_DISTRIBUTION_INPUT");
  return (y - location) / scale;
}

/** Negative log-density, including its normalization constant. */
export function studentTNll5(y: number, location: number, scale: number): number {
  const z = parameters(y, location, scale), magnitude = Math.abs(z);
  const logTerm = magnitude > SQRT_NU ? 2 * Math.log(magnitude) - Math.log(NU) + Math.log1p(NU / magnitude ** 2)
    : Math.log1p(z * z / NU);
  return Math.log(scale) + LOG_NORMALIZER + 3 * logTerm;
}

/** Fisher-preconditioned gradient of NLL in (location, log(scale)). Training
 * fits its negative. The off-diagonal Fisher term is zero by symmetry. */
export function studentNaturalGradient5(y: number, location: number, scale: number): { location: number; logScale: number } {
  const z = parameters(y, location, scale), square = z * z;
  const locationGradient = Number.isFinite(square) ? -8 * scale * z / (NU + square) : -8 * scale / z;
  return { location: locationGradient, logScale: 4 * (6 / (NU + square) - 1) };
}

/** Exact t5 integral in the central region, with a convergent tail series to
 * avoid subtractive cancellation when computing a very small lower tail. */
export function studentTCdf5(x: number): number {
  if (Number.isNaN(x) || typeof x !== "number") throw new Error("STUDENT_INVALID_CDF_INPUT");
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const magnitude = Math.abs(x);
  if (magnitude >= 2 * SQRT_NU) {
    const u = SQRT_NU / magnitude, squared = u * u;
    let power = u ** 5, sum = 0;
    for (let k = 0; k < 64; k++) {
      const term = ((k + 1) * (k + 2) / 2) * power / (2 * k + 5);
      sum += term;
      if (k > 0 && Math.abs(term) <= Number.EPSILON * Math.abs(sum)) break;
      power *= -squared;
    }
    const tail = Math.max(0, Math.min(.5, 8 * sum / (3 * Math.PI)));
    return x < 0 ? tail : 1 - tail;
  }
  const angle = Math.atan(x / SQRT_NU);
  return Math.max(0, Math.min(1, .5 + angle / Math.PI + 2 * Math.sin(2 * angle) / (3 * Math.PI)
    + Math.sin(4 * angle) / (12 * Math.PI)));
}

export function studentTQuantile5(probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("STUDENT_INVALID_QUANTILE_INPUT");
  if (probability === 0) return -Infinity;
  if (probability === 1) return Infinity;
  if (probability === .5) return 0;
  const tail = Math.min(probability, 1 - probability);
  let lower = 0, upper = 1;
  while (studentTCdf5(-upper) > tail) upper *= 2;
  for (let i = 0; i < 96; i++) {
    const midpoint = lower + (upper - lower) / 2;
    if (studentTCdf5(-midpoint) > tail) lower = midpoint; else upper = midpoint;
  }
  const magnitude = lower + (upper - lower) / 2;
  return probability < .5 ? -magnitude : magnitude;
}

interface Prepared {
  features: Float64Array[]; target: Float64Array; weight: Float64Array;
  dimension: number; samples: number; weightSum: number; weightedESS: number; trainingRowsSha256: string;
  targetMean: number; targetVariance: number;
}
function prepare(rows: readonly StudentTrainingRow[], dimension: number): Prepared {
  if (!Array.isArray(rows) || !rows.length || !Number.isSafeInteger(dimension) || dimension <= 0)
    throw new Error("STUDENT_INVALID_TRAINING_INPUT");
  const features = Array.from({ length: dimension }, () => new Float64Array(rows.length));
  const target = new Float64Array(rows.length), weight = new Float64Array(rows.length);
  let weightSum = 0, weightSquared = 0, numerator = 0;
  const canonical = rows.map((row, i) => {
    if (!row || !Array.isArray(row.features) || row.features.length !== dimension
      || !Number.isFinite(row.target) || !Number.isFinite(row.weight) || row.weight <= 0)
      throw new Error("STUDENT_INVALID_TRAINING_ROW");
    const values: number[] = [];
    for (let j = 0; j < dimension; j++) {
      const value = row.features[j]!;
      if (!Number.isFinite(value)) throw new Error("STUDENT_INVALID_TRAINING_ROW");
      features[j]![i] = value; values.push(value);
    }
    target[i] = row.target; weight[i] = row.weight;
    weightSum += row.weight; weightSquared += row.weight ** 2; numerator += row.weight * row.target;
    return { features: values, target: row.target, weight: row.weight };
  });
  const targetMean = numerator / weightSum;
  let targetVariance = 0;
  for (let i = 0; i < rows.length; i++) targetVariance += weight[i]! * (target[i]! - targetMean) ** 2;
  targetVariance /= weightSum;
  const weightedESS = weightSum * weightSum / weightSquared;
  if (![weightSum, weightSquared, targetMean, targetVariance, weightedESS].every(Number.isFinite))
    throw new Error("STUDENT_NONFINITE_TRAINING_AGGREGATE");
  return { features, target, weight, dimension, samples: rows.length, weightSum, weightedESS,
    trainingRowsSha256: hash(canonical), targetMean, targetVariance };
}
function checkFeatures(features: readonly number[], dimension: number): void {
  if (!Array.isArray(features) || features.length !== dimension) throw new Error("STUDENT_INVALID_PREDICTION_FEATURES");
  for (let j = 0; j < dimension; j++) if (!Number.isFinite(features[j])) throw new Error("STUDENT_INVALID_PREDICTION_FEATURES");
}
interface Leaf { kind: "leaf"; value: number; samples: number; weightSum: number; }
interface Split { kind: "split"; feature: number; threshold: number; gain: number; samples: number; weightSum: number; left: Tree; right: Tree; }
type Tree = Leaf | Split;
interface Histograms { thresholds: number[][]; binIds: Uint8Array[]; }
function histograms(data: Prepared): Histograms {
  const thresholds: number[][] = [], binIds: Uint8Array[] = [];
  for (let j = 0; j < data.dimension; j++) {
    const ordered = [...data.features[j]!].sort((a, b) => a - b), boundaries: number[] = [];
    for (let k = 1; k < STUDENT_BOOST_SPEC.histogramBins; k++) {
      const index = Math.ceil(k * ordered.length / STUDENT_BOOST_SPEC.histogramBins);
      if (index <= 0 || index >= ordered.length) continue;
      const a = ordered[index - 1]!, b = ordered[index]!;
      const midpoint = a / 2 + b / 2, boundary = midpoint < b ? midpoint : a;
      if (boundary < ordered.at(-1)! && (boundaries.length === 0 || boundary > boundaries.at(-1)!)) boundaries.push(boundary);
    }
    const bins = new Uint8Array(data.samples);
    for (let i = 0; i < data.samples; i++) {
      let bin = 0; while (bin < boundaries.length && data.features[j]![i]! > boundaries[bin]!) bin++;
      bins[i] = bin;
    }
    thresholds.push(boundaries); binIds.push(bins);
  }
  return { thresholds, binIds };
}
function fitTree(data: Prepared, histogram: Histograms, targets: Float64Array): Tree {
  function build(indices: Uint32Array, depth: number): Tree {
    let weightSum = 0, sum = 0, squared = 0;
    for (const i of indices) { const w = data.weight[i]!, y = targets[i]!; weightSum += w; sum += w * y; squared += w * y * y; }
    const leaf: Leaf = { kind: "leaf", value: sum / weightSum, samples: indices.length, weightSum };
    if (![weightSum, sum, squared, leaf.value].every(Number.isFinite)) throw new Error("STUDENT_NONFINITE_TREE");
    if (depth >= STUDENT_BOOST_SPEC.maximumDepth || indices.length < 2 * STUDENT_BOOST_SPEC.minimumLeafSamples) return leaf;
    const tolerance = 1e-12 * Math.max(1, squared), parent = sum * sum / weightSum;
    let best: { feature: number; threshold: number; gain: number } | null = null;
    for (let j = 0; j < data.dimension; j++) {
      const boundaries = histogram.thresholds[j]!;
      if (!boundaries.length) continue;
      const counts = new Uint32Array(boundaries.length + 1), weights = new Float64Array(boundaries.length + 1), sums = new Float64Array(boundaries.length + 1);
      const bins = histogram.binIds[j]!;
      for (const i of indices) { const bin = bins[i]!, w = data.weight[i]!; counts[bin]!++; weights[bin]! += w; sums[bin]! += w * targets[i]!; }
      let leftCount = 0, leftWeight = 0, leftSum = 0;
      for (let k = 0; k < boundaries.length; k++) {
        leftCount += counts[k]!; leftWeight += weights[k]!; leftSum += sums[k]!;
        if (leftCount < STUDENT_BOOST_SPEC.minimumLeafSamples || indices.length - leftCount < STUDENT_BOOST_SPEC.minimumLeafSamples) continue;
        const rightWeight = weightSum - leftWeight, rightSum = sum - leftSum;
        if (!(leftWeight > 0) || !(rightWeight > 0)) continue;
        const gain = leftSum * leftSum / leftWeight + rightSum * rightSum / rightWeight - parent;
        if (Number.isFinite(gain) && gain > tolerance && (!best || gain > best.gain + tolerance))
          best = { feature: j, threshold: boundaries[k]!, gain };
      }
    }
    if (!best) return leaf;
    const left: number[] = [], right: number[] = [];
    for (const i of indices) (data.features[best.feature]![i]! <= best.threshold ? left : right).push(i);
    if (left.length < STUDENT_BOOST_SPEC.minimumLeafSamples || right.length < STUDENT_BOOST_SPEC.minimumLeafSamples)
      throw new Error("STUDENT_HISTOGRAM_PARTITION_MISMATCH");
    return { kind: "split", ...best, samples: indices.length, weightSum,
      left: build(Uint32Array.from(left), depth + 1), right: build(Uint32Array.from(right), depth + 1) };
  }
  return build(Uint32Array.from({ length: data.samples }, (_, i) => i), 0);
}
function treeValue(tree: Tree, features: readonly number[]): number {
  let node = tree;
  while (node.kind === "split") node = features[node.feature]! <= node.threshold ? node.left : node.right;
  return node.value;
}
function treeTrainingValues(tree: Tree, features: Float64Array[], result: Float64Array): void {
  for (let i = 0; i < result.length; i++) {
    let node = tree;
    while (node.kind === "split") node = features[node.feature]![i]! <= node.threshold ? node.left : node.right;
    result[i] = node.value;
  }
}
function weightedNll(data: Prepared, locations: Float64Array, logScales: Float64Array): number {
  let loss = 0;
  for (let i = 0; i < data.samples; i++) {
    if (!Number.isFinite(locations[i]) || !Number.isFinite(logScales[i])) return Infinity;
    loss += data.weight[i]! * studentTNll5(data.target[i]!, locations[i]!, scaleFromLog(logScales[i]!));
  }
  return loss / data.weightSum;
}

export function fitStudentBoost(rows: readonly StudentTrainingRow[], dimension: number) {
  const data = prepare(rows, dimension), histogram = histograms(data);
  const initialLocation = data.targetMean, initialScale = clampScale(Math.sqrt(data.targetVariance * 3 / 5));
  let locations = new Float64Array(data.samples).fill(initialLocation), logScales = new Float64Array(data.samples).fill(Math.log(initialScale));
  let proposedLocations = new Float64Array(data.samples), proposedLogScales = new Float64Array(data.samples);
  const locationGradients = new Float64Array(data.samples), logScaleGradients = new Float64Array(data.samples);
  const locationChanges = new Float64Array(data.samples), logScaleChanges = new Float64Array(data.samples);
  const rounds: Array<{ step: number; locationTree: Tree; logScaleTree: Tree }> = [];
  const losses = [weightedNll(data, locations, logScales)];
  if (!Number.isFinite(losses[0])) throw new Error("STUDENT_NONFINITE_INITIAL_LOSS");
  let attemptedRounds = 0, stoppedBecause: "MAXIMUM_ROUNDS" | "NO_NONINCREASING_STEP" = "MAXIMUM_ROUNDS";
  for (let round = 0; round < STUDENT_BOOST_SPEC.maximumRounds; round++) {
    attemptedRounds++;
    for (let i = 0; i < data.samples; i++) {
      const gradient = studentNaturalGradient5(data.target[i]!, locations[i]!, scaleFromLog(logScales[i]!));
      locationGradients[i] = -gradient.location; logScaleGradients[i] = -gradient.logScale;
    }
    const locationTree = fitTree(data, histogram, locationGradients), logScaleTree = fitTree(data, histogram, logScaleGradients);
    treeTrainingValues(locationTree, data.features, locationChanges); treeTrainingValues(logScaleTree, data.features, logScaleChanges);
    let accepted = false;
    for (const step of STUDENT_BOOST_SPEC.backtrackingSteps) {
      const rate = STUDENT_BOOST_SPEC.learningRate * step;
      for (let i = 0; i < data.samples; i++) {
        proposedLocations[i] = locations[i]! + rate * locationChanges[i]!;
        proposedLogScales[i] = clampLogScale(logScales[i]! + rate * logScaleChanges[i]!);
      }
      const loss = weightedNll(data, proposedLocations, proposedLogScales);
      if (Number.isFinite(loss) && loss <= losses.at(-1)!) {
        [locations, proposedLocations] = [proposedLocations, locations];
        [logScales, proposedLogScales] = [proposedLogScales, logScales];
        rounds.push({ step, locationTree, logScaleTree }); losses.push(loss); accepted = true; break;
      }
    }
    if (!accepted) { stoppedBecause = "NO_NONINCREASING_STEP"; break; }
  }
  const diagnostics = { version: STUDENT_BOOST_SPEC.version, kind: "STUDENT_NATURAL_BOOST" as const, spec: STUDENT_BOOST_SPEC,
    dimension, samples: data.samples, weightSum: data.weightSum, weightedESS: data.weightedESS, trainingRowsSha256: data.trainingRowsSha256,
    initialLocation, initialScale, attemptedRounds, acceptedRounds: rounds.length, stoppedBecause,
    initialWeightedNll: losses[0]!, finalWeightedNll: losses.at(-1)!, weightedNllHistory: losses,
    binThresholds: histogram.thresholds, rounds };
  return {
    predict(features: readonly number[]): StudentPrediction {
      checkFeatures(features, dimension);
      let location = initialLocation, logScale = Math.log(initialScale);
      for (const round of rounds) {
        const rate = STUDENT_BOOST_SPEC.learningRate * round.step;
        location += rate * treeValue(round.locationTree, features);
        logScale = clampLogScale(logScale + rate * treeValue(round.logScaleTree, features));
      }
      if (!Number.isFinite(location)) throw new Error("STUDENT_NONFINITE_PREDICTION");
      return { location, scale: scaleFromLog(logScale) };
    },
    diagnostics() { return structuredClone(diagnostics); },
  };
}

function solveRidge(matrix: number[][], target: number[]): number[] {
  const size = target.length, lower = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let i = 0; i < size; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
    if (!Number.isFinite(value) || i === j && value <= 0) throw new Error("STUDENT_NONFINITE_LINEAR_FIT");
    lower[i]![j] = i === j ? Math.sqrt(value) : value / lower[j]![j]!;
  }
  const intermediate = Array<number>(size).fill(0), result = Array<number>(size).fill(0);
  for (let i = 0; i < size; i++) {
    let value = target[i]!; for (let j = 0; j < i; j++) value -= lower[i]![j]! * intermediate[j]!;
    intermediate[i] = value / lower[i]![i]!;
  }
  for (let i = size - 1; i >= 0; i--) {
    let value = intermediate[i]!; for (let j = i + 1; j < size; j++) value -= lower[j]![i]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  if (!result.every(Number.isFinite)) throw new Error("STUDENT_NONFINITE_LINEAR_FIT");
  return result;
}

/** Fixed weighted ridge comparison with identical row, weight and cost targets.
 * Its t5 scale is the training residual SD times sqrt(3/5), not a second fit. */
export function fitLinearStudent(rows: readonly StudentTrainingRow[], dimension: number) {
  const data = prepare(rows, dimension), centers = Array<number>(dimension).fill(0), scales = Array<number>(dimension).fill(0);
  for (let j = 0; j < dimension; j++) {
    for (let i = 0; i < data.samples; i++) centers[j]! += data.weight[i]! * data.features[j]![i]!;
    centers[j]! /= data.weightSum;
    for (let i = 0; i < data.samples; i++) scales[j]! += data.weight[i]! * (data.features[j]![i]! - centers[j]!) ** 2;
    scales[j] = Math.max(STUDENT_BOOST_SPEC.linearFeatureScaleFloor, Math.sqrt(scales[j]! / data.weightSum));
  }
  const matrix = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) =>
    i === j ? STUDENT_BOOST_SPEC.linearBaselineRidgePenalty : 0));
  const target = Array<number>(dimension).fill(0);
  for (let row = 0; row < data.samples; row++) {
    const x = centers.map((center, j) => (data.features[j]![row]! - center) / scales[j]!), weight = data.weight[row]!;
    for (let i = 0; i < dimension; i++) {
      target[i]! += weight * x[i]! * (data.target[row]! - data.targetMean);
      for (let j = 0; j <= i; j++) matrix[i]![j]! += weight * x[i]! * x[j]!;
    }
  }
  for (let i = 0; i < dimension; i++) for (let j = 0; j < i; j++) matrix[j]![i] = matrix[i]![j]!;
  const coefficients = solveRidge(matrix, target), residuals = new Float64Array(data.samples);
  let residualMean = 0, residualVariance = 0;
  for (let row = 0; row < data.samples; row++) {
    const location = data.targetMean + coefficients.reduce((sum, coefficient, j) =>
      sum + coefficient * (data.features[j]![row]! - centers[j]!) / scales[j]!, 0);
    residuals[row] = data.target[row]! - location; residualMean += data.weight[row]! * residuals[row]!;
  }
  residualMean /= data.weightSum;
  for (let row = 0; row < data.samples; row++) residualVariance += data.weight[row]! * (residuals[row]! - residualMean) ** 2;
  residualVariance /= data.weightSum;
  const scale = clampScale(Math.sqrt(residualVariance * 3 / 5));
  if (![...centers, ...scales, residualMean, residualVariance, scale].every(Number.isFinite)) throw new Error("STUDENT_NONFINITE_LINEAR_FIT");
  const intercept = data.targetMean;
  const diagnostics = { version: "btc-eth-hourly-linear-student-baseline-v1", kind: "LINEAR_STUDENT_BASELINE" as const,
    degreesOfFreedom: 5, ridgePenalty: STUDENT_BOOST_SPEC.linearBaselineRidgePenalty, dimension,
    samples: data.samples, weightSum: data.weightSum, weightedESS: data.weightedESS, trainingRowsSha256: data.trainingRowsSha256,
    intercept, centers, scales, coefficients, residualMean, residualVariance, scale };
  return {
    predict(features: readonly number[]): StudentPrediction {
      checkFeatures(features, dimension);
      const location = intercept + coefficients.reduce((sum, coefficient, j) =>
        sum + coefficient * (features[j]! - centers[j]!) / scales[j]!, 0);
      if (!Number.isFinite(location)) throw new Error("STUDENT_NONFINITE_PREDICTION");
      return { location, scale };
    },
    diagnostics() { return structuredClone(diagnostics); },
  };
}
