/** Kish effective sample size for weighted observations. */
export function effectiveSampleCount(weights: readonly number[]): number {
  const positive = weights.filter((weight) => Number.isFinite(weight) && weight > 0);
  const sum = positive.reduce((total, weight) => total + weight, 0);
  const squared = positive.reduce((total, weight) => total + weight * weight, 0);
  return squared > 0 ? sum * sum / squared : 0;
}
