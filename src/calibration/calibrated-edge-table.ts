import type { Direction } from "../core/market.js";
import type { ConservativeEdge, ExecutionPath } from "../economics/types.js";
import type { RegimeName } from "../strategy/deterministic-regime.js";

export interface CalibratedEdgeBucket {
  symbol: string;
  side: Direction;
  regime: RegimeName;
  minimumQuality: number;
  maximumQuality: number;
  minimumSpreadBps: number;
  maximumSpreadBps: number;
  horizonMs: number;
  path: ExecutionPath;
  meanGrossReturnBps: number;
  lowerConfidenceGrossReturnBps: number;
  effectiveSampleCount: number;
}

export interface CalibratedEdgeQuery {
  symbol: string; side: Direction; regime: RegimeName; quality: number; spreadBps: number;
}

export class CalibratedEdgeTable {
  public constructor(private readonly buckets: readonly CalibratedEdgeBucket[] = []) {
    for (const [index, bucket] of buckets.entries()) validateBucket(bucket, index);
  }

  public resolve(query: CalibratedEdgeQuery): ConservativeEdge[] {
    return this.buckets.filter((bucket) => bucket.symbol === query.symbol && bucket.side === query.side
      && bucket.regime === query.regime && query.quality >= bucket.minimumQuality && query.quality < bucket.maximumQuality
      && query.spreadBps >= bucket.minimumSpreadBps && query.spreadBps < bucket.maximumSpreadBps)
      .map((bucket) => ({
        source: "CALIBRATED", side: query.side, horizonMs: bucket.horizonMs,
        grossBeforeUncertaintyBps: bucket.meanGrossReturnBps,
        signalUncertaintyBps: Math.max(0, bucket.meanGrossReturnBps - bucket.lowerConfidenceGrossReturnBps),
        conservativeGrossBps: bucket.lowerConfidenceGrossReturnBps,
        quality: query.quality, effectiveSampleCount: bucket.effectiveSampleCount,
        executionPath: bucket.path,
      }));
  }
}

function validateBucket(bucket: CalibratedEdgeBucket, index: number): void {
  if (!bucket || typeof bucket !== "object" || typeof bucket.symbol !== "string" || !bucket.symbol
    || ![-1, 1].includes(bucket.side)
    || !["REVERSAL_UP", "REVERSAL_DOWN", "BREAKOUT_UP", "BREAKOUT_DOWN", "TREND_UP", "TREND_DOWN", "CHOP", "UNKNOWN"].includes(bucket.regime)
    || !["MAKER_MAKER", "MAKER_TAKER", "TAKER_TAKER"].includes(bucket.path)) {
    throw new Error(`Invalid calibrated edge bucket ${index}: identity fields`);
  }
  const numbers = [bucket.minimumQuality, bucket.maximumQuality, bucket.minimumSpreadBps, bucket.maximumSpreadBps,
    bucket.horizonMs, bucket.meanGrossReturnBps, bucket.lowerConfidenceGrossReturnBps, bucket.effectiveSampleCount];
  if (numbers.some((value) => !Number.isFinite(value)) || bucket.minimumQuality < 0 || bucket.maximumQuality > 1
    || bucket.minimumQuality >= bucket.maximumQuality || bucket.minimumSpreadBps < 0
    || bucket.minimumSpreadBps >= bucket.maximumSpreadBps || bucket.horizonMs <= 0
    || bucket.effectiveSampleCount < 0 || bucket.lowerConfidenceGrossReturnBps > bucket.meanGrossReturnBps) {
    throw new Error(`Invalid calibrated edge bucket ${index}: numeric ranges`);
  }
}
