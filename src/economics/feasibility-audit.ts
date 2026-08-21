export interface MinimumFeasibleHorizonInput {
  varianceRate: number;
  continuationQuality: number;
  sigmaCaptureFraction: number;
  breakoutContributionBps: number;
  robustCostBps: number;
  fixedSignalUncertaintyBps: number;
  minimumNetEdgeBps: number;
}

/** Analytical lower bound for the horizon needed to overcome fixed economics before a candidate can qualify. */
export function minimumFeasibleHorizonMs(input: MinimumFeasibleHorizonInput): number {
  const remainingBps = Math.max(0, input.robustCostBps + input.fixedSignalUncertaintyBps
    + input.minimumNetEdgeBps - input.breakoutContributionBps);
  if (remainingBps === 0) return 0;
  const capture = input.sigmaCaptureFraction * input.continuationQuality;
  if (!(capture > 0) || !(input.varianceRate > 0)) return Number.POSITIVE_INFINITY;
  const requiredSigmaFraction = remainingBps / (10_000 * capture);
  return 1_000 * requiredSigmaFraction * requiredSigmaFraction / input.varianceRate;
}
