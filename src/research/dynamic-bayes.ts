export interface BayesianPrediction {
  mean: number; meanVariance: number; predictiveVariance: number; scaleSquared: number; degreesOfFreedom: number;
}

/** Normal/inverse-gamma regression with exponentially discounted sufficient
 * statistics and a fixed zero-mean ridge prior. Returns a Student-t predictive
 * distribution, keeping parameter uncertainty separate from return noise. */
export class DynamicBayes {
  private readonly xx: number[][];
  private readonly xy: number[];
  private yy = 0;
  private count = 0;
  public constructor(private readonly dimensions: number, private readonly halfLife: number) {
    if (!Number.isInteger(dimensions) || dimensions < 0 || dimensions > 20 || !(halfLife > 0)) throw new Error("INVALID_BAYES_SPEC");
    this.xx = Array.from({ length: dimensions }, () => Array(dimensions).fill(0) as number[]);
    this.xy = Array(dimensions).fill(0) as number[];
  }
  public predict(x: readonly number[]): BayesianPrediction {
    this.check(x);
    const precision = this.xx.map((r, i) => r.map((v, j) => v + (i === j ? (i === 0 ? 1 : 10) : 0)));
    const coefficients = solvePositive(precision, this.xy), influence = solvePositive(precision, x);
    const a = 3 + this.count / 2;
    const b = Math.max(2, 2 + .5 * (this.yy - dot(coefficients, this.xy)));
    const noise = b / (a - 1), leverage = Math.max(0, dot(x, influence));
    return { mean: dot(x, coefficients), meanVariance: noise * leverage,
      predictiveVariance: noise * (1 + leverage), scaleSquared: b / a * (1 + leverage), degreesOfFreedom: 2 * a };
  }
  public update(x: readonly number[], y: number): void {
    this.check(x);
    if (!Number.isFinite(y)) throw new Error("INVALID_BAYES_TARGET");
    const decay = 2 ** (-1 / this.halfLife);
    this.count = decay * this.count + 1; this.yy = decay * this.yy + y * y;
    for (let i = 0; i < this.dimensions; i++) {
      this.xy[i] = decay * this.xy[i]! + x[i]! * y;
      for (let j = 0; j < this.dimensions; j++) this.xx[i]![j] = decay * this.xx[i]![j]! + x[i]! * x[j]!;
    }
  }
  private check(x: readonly number[]): void {
    if (x.length !== this.dimensions || !x.every(Number.isFinite)) throw new Error("INVALID_BAYES_FEATURES");
  }
}

/** Cholesky solution avoids explicit inversion and preserves ridge symmetry. */
function solvePositive(matrix: readonly number[][], rhs: readonly number[]): number[] {
  const n = rhs.length, l = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= l[i]![k]! * l[j]![k]!;
    if (i === j && (!(value > 0) || !Number.isFinite(value))) throw new Error("BAYES_PRECISION_NOT_POSITIVE");
    l[i]![j] = i === j ? Math.sqrt(value) : value / l[j]![j]!;
  }
  const z = Array(n).fill(0) as number[], result = Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) {
    let value = rhs[i]!; for (let j = 0; j < i; j++) value -= l[i]![j]! * z[j]!;
    z[i] = value / l[i]![i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = z[i]!; for (let j = i + 1; j < n; j++) value -= l[j]![i]! * result[j]!;
    result[i] = value / l[i]![i]!;
  }
  return result;
}

export function studentLogDensity(value: number, p: BayesianPrediction): number {
  const v = p.degreesOfFreedom, squared = (value - p.mean) ** 2 / p.scaleSquared;
  return logGamma((v + 1) / 2) - logGamma(v / 2) - .5 * Math.log(v * Math.PI * p.scaleSquared)
    - (v + 1) / 2 * Math.log1p(squared / v);
}
function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let sum = .99999999999980993;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i]! / (z + i);
  const t = z + 6.5;
  return .5 * Math.log(2 * Math.PI) + (z - .5) * Math.log(t) - t + Math.log(sum);
}
export const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
