import { HOUR_MS, HOURLY_SYMBOLS, type HourlyBar, type HourlySymbol } from "./hourly-data.js";

export type HourlyVolumeFeatures = readonly [number, number, number, number, number, number,
  number, number, number, number, number, number];
export interface HourlyVolumePoint {
  readonly symbol: HourlySymbol;
  readonly decisionMs: number;
  readonly features: HourlyVolumeFeatures;
}
export const HOURLY_VOLUME_FEATURE_SPEC = Object.freeze({
  version: "btc-eth-hourly-volume-range-hedge-features-v1",
  researchOnly: true,
  featureDimension: 12,
  minimumSynchronizedContinuousBars: 169,
  knownAt: "CURRENT_BAR_OPEN_PLUS_ONE_HOUR" as const,
  returns: "LOG_CLOSE_DIFFERENCE; RMS_USES_COMPLETED_ONE_HOUR_RETURNS" as const,
  referenceWindows: "PREVIOUS_EXCLUDES_CURRENT; CURRENT_LAST_INCLUDES_CURRENT" as const,
  trueRange: "MAX_HIGH_MINUS_LOW_ABS_HIGH_MINUS_PREVIOUS_CLOSE_ABS_LOW_MINUS_PREVIOUS_CLOSE" as const,
  zeroReturnDenominator: 0,
  flatCandleLocationAndBody: 0,
  minimumVolatilityBps: .01,
  minimumVolatilityRatioTerm: 1e-8,
  minimumTrueRangeRatioTerm: 1e-8,
  volumeOffset: 1,
  beta: "SUM_168_OWN_RETURN_TIMES_PEER_RETURN_OVER_SUM_168_PEER_RETURN_SQUARED; ZERO_IF_PEER_SUM_ZERO" as const,
  residualScale: "RMS_168_OF_OWN_RETURN_MINUS_CURRENT_TRAILING_BETA_TIMES_PEER_RETURN_TIMES_SQRT24" as const,
  betaClipped: false,
  featuresClipped: false,
  populationFitting: false,
  distinctFromDistributionFeatureSchema: true,
  featureNames: Object.freeze([
    "log_return_1h_over_own_rms168_sqrt1",
    "log_return_4h_over_own_rms168_sqrt4",
    "log_return_24h_over_own_rms168_sqrt24",
    "log_return_168h_over_own_rms168_sqrt168",
    "log_max_rms24_bps_0_01",
    "log_rms24_floor1e_minus8_over_rms168_floor1e_minus8",
    "close_location_in_current_high_low_minus1_to1",
    "current_close_minus_open_over_high_minus_low",
    "log_current_true_range_over_previous24_mean_true_range_floor1e_minus8",
    "log_current_volume_plus1_over_previous24_mean_volume_plus1",
    "log_current_last24_mean_volume_plus1_over_previous168_mean_volume_plus1",
    "beta_hedged_log_return24_over_residual_rms168_sqrt24",
  ] as const),
});

interface AssetHistory {
  bars: HourlyBar[];
  byTime: Map<number, number>;
  logs: number[];
  returns: number[];
  trueRanges: number[];
  continuous: number[];
}
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validateBar(bar: HourlyBar): void {
  if (!bar || !HOURLY_SYMBOLS.includes(bar.symbol) || !validTime(bar.openMs)
    || bar.openMs % HOUR_MS !== 0 || !validTime(bar.openMs + HOUR_MS)
    || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close)
    || bar.high < Math.max(bar.open, bar.close) || bar.high < bar.low) throw new Error("HOURLY_VOLUME_INVALID_BAR");
}
function indexBars(bars: HourlyBar[]): AssetHistory {
  bars.sort((a, b) => a.openMs - b.openMs);
  const byTime = new Map<number, number>(), logs: number[] = [], returns: number[] = [];
  const trueRanges: number[] = [], continuous: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!, previous = bars[i - 1];
    if (byTime.has(bar.openMs)) throw new Error("HOURLY_VOLUME_DUPLICATE_BAR");
    byTime.set(bar.openMs, i);
    const adjacent = previous !== undefined && bar.openMs - previous.openMs === HOUR_MS;
    logs[i] = Math.log(bar.close);
    continuous[i] = adjacent ? continuous[i - 1]! + 1 : 1;
    returns[i] = adjacent ? logs[i]! - logs[i - 1]! : 0;
    trueRanges[i] = adjacent ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))
      : bar.high - bar.low;
  }
  return { bars, byTime, logs, returns, trueRanges, continuous };
}

/** A new research schema, independent of live distribution feature vectors.
 * Each output uses exactly 169 consecutive closed bars for each asset. Missing
 * own or peer hours suppress affected points until both lookbacks are complete.
 * Prior-only volume references exclude the current bar. Nothing is fitted over
 * the supplied population, and future bars cannot change an earlier point.
 */
export function buildHourlyVolumeFeatures(bars: readonly HourlyBar[]): readonly HourlyVolumePoint[] {
  if (!Array.isArray(bars)) throw new Error("HOURLY_VOLUME_INVALID_INPUT");
  const grouped = new Map<HourlySymbol, HourlyBar[]>(HOURLY_SYMBOLS.map(symbol => [symbol, []]));
  for (const bar of bars) { validateBar(bar); grouped.get(bar.symbol)!.push({ ...bar }); }
  const assets = new Map(HOURLY_SYMBOLS.map(symbol => [symbol, indexBars(grouped.get(symbol)!)]));
  const points: HourlyVolumePoint[] = [];
  for (const symbol of HOURLY_SYMBOLS) {
    const own = assets.get(symbol)!, peer = assets.get(symbol === "BTC/USD" ? "ETH/USD" : "BTC/USD")!;
    for (let i = 0; i < own.bars.length; i++) {
      if (own.continuous[i]! < 169) continue;
      const current = own.bars[i]!, peerIndex = peer.byTime.get(current.openMs);
      if (peerIndex === undefined || peer.continuous[peerIndex]! < 169) continue;
      let ownSquares = 0, shortSquares = 0, peerSquares = 0, cross = 0;
      let priorVolume168 = 0, priorVolume24 = 0, currentVolume24 = 0, priorRange24 = 0;
      for (let lag = 0; lag < 168; lag++) {
        const ownReturn = own.returns[i - lag]!, peerReturn = peer.returns[peerIndex - lag]!;
        ownSquares += ownReturn * ownReturn;
        peerSquares += peerReturn * peerReturn;
        cross += ownReturn * peerReturn;
        priorVolume168 += own.bars[i - lag - 1]!.volume / 168;
        if (lag < 24) {
          shortSquares += ownReturn * ownReturn;
          priorVolume24 += own.bars[i - lag - 1]!.volume / 24;
          currentVolume24 += own.bars[i - lag]!.volume / 24;
          priorRange24 += own.trueRanges[i - lag - 1]! / 24;
        }
      }
      const rms168 = Math.sqrt(ownSquares / 168), rms24 = Math.sqrt(shortSquares / 24);
      const beta = peerSquares > 0 ? cross / peerSquares : 0;
      let residualSquares = 0;
      for (let lag = 0; lag < 168; lag++) {
        const residual = own.returns[i - lag]! - beta * peer.returns[peerIndex - lag]!;
        residualSquares += residual * residual;
      }
      const residualScale = Math.sqrt(residualSquares / 168) * Math.sqrt(24);
      const own24 = own.logs[i]! - own.logs[i - 24]!, peer24 = peer.logs[peerIndex]! - peer.logs[peerIndex - 24]!;
      const range = current.high - current.low;
      const scaledReturn = (hours: number) => rms168 > 0 ? (own.logs[i]! - own.logs[i - hours]!) / (rms168 * Math.sqrt(hours)) : 0;
      const features: HourlyVolumeFeatures = Object.freeze([
        scaledReturn(1), scaledReturn(4), scaledReturn(24), scaledReturn(168),
        Math.log(Math.max(rms24 * 10_000, .01)),
        Math.log(Math.max(rms24, 1e-8)) - Math.log(Math.max(rms168, 1e-8)),
        range > 0 ? 2 * ((current.close - current.low) / range) - 1 : 0,
        range > 0 ? (current.close - current.open) / range : 0,
        Math.log(Math.max(own.trueRanges[i]!, 1e-8)) - Math.log(Math.max(priorRange24, 1e-8)),
        Math.log(current.volume + 1) - Math.log(priorVolume24 + 1),
        Math.log(currentVolume24 + 1) - Math.log(priorVolume168 + 1),
        residualScale > 0 ? (own24 - beta * peer24) / residualScale : 0,
      ]);
      if (!features.every(Number.isFinite)) throw new Error("HOURLY_VOLUME_NONFINITE_FEATURES");
      points.push(Object.freeze({ symbol, decisionMs: current.openMs + HOUR_MS, features }));
    }
  }
  return Object.freeze(points.sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol)));
}
