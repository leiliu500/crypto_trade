import { HOUR_MS, HOURLY_SYMBOLS, type HourlyBar, type HourlySymbol } from "./hourly-data.js";

export const HOURLY_PRICE_SETUP_IDS = Object.freeze(["channel-breakout-24h", "trend-recovery-24h"] as const);
export type HourlyPriceSetupId = typeof HOURLY_PRICE_SETUP_IDS[number];
export interface PriceSetupSignal {
  symbol: HourlySymbol;
  decisionMs: number;
  horizonHours: 24;
  side: 1 | -1;
  setupId: HourlyPriceSetupId;
  /** Geometric two-ATR distance, not an expected return or probability. */
  roomBps: number;
  /** Positive directional distance from the channel boundary or EMA24, in ATR units. */
  strength: number;
}
export const HOURLY_PRICE_SETUP_SPEC = Object.freeze({
  version: "btc-eth-hourly-price-setups-v1",
  researchOnly: true,
  setupIds: HOURLY_PRICE_SETUP_IDS,
  horizonHours: 24,
  minimumContinuousBars: 169,
  signalKnownAt: "CURRENT_BAR_OPEN_PLUS_ONE_HOUR" as const,
  outputWindow: "DECISION_FROM_INCLUSIVE_TO_EXCLUSIVE" as const,
  channelHours: 24,
  channel: "CURRENT_CLOSE_STRICTLY_OUTSIDE_PREVIOUS_24_HIGH_LOW; EMIT_FALSE_TO_TRUE_PER_SIDE" as const,
  ema: "RECURSIVE_ALPHA_2_OVER_PERIOD_PLUS_1; FIRST_CLOSE_SEED; RESET_ON_OWN_GAP" as const,
  fastEmaHours: 24,
  slowEmaHours: 168,
  atr: "SIMPLE_MEAN_LAST_14_TRUE_RANGES_INCLUDING_CURRENT; TRUE_RANGE_USES_PREVIOUS_CLOSE" as const,
  recoveryLookbackHours: 4,
  recoveryBandAtr: .25,
  recoveryLong: "EMA24>EMA168; CLOSE>EMA24+.25ATR; PREVIOUS_CLOSE<=PREVIOUS_EMA24+.25PREVIOUS_ATR; ANY_PREVIOUS_4_CLOSES<=THEIR_EMA24" as const,
  recoveryShort: "EMA24<EMA168; CLOSE<EMA24-.25ATR; PREVIOUS_CLOSE>=PREVIOUS_EMA24-.25PREVIOUS_ATR; ANY_PREVIOUS_4_CLOSES>=THEIR_EMA24" as const,
  roomBps: "2*ATR14/CURRENT_CLOSE*10000_GEOMETRIC_ONLY" as const,
  breakoutStrength: "DIRECTIONAL_DISTANCE_BEYOND_PREVIOUS_CHANNEL_DIVIDED_BY_ATR14" as const,
  recoveryStrength: "SIDE_TIMES_CLOSE_MINUS_EMA24_DIVIDED_BY_ATR14" as const,
  peerRequired: false,
  trainingSamplesRequired: false,
  zeroAtr: "NO_SIGNAL" as const,
});

const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validBar(bar: HourlyBar): boolean {
  return Boolean(bar && HOURLY_SYMBOLS.includes(bar.symbol) && validTime(bar.openMs)
    && bar.openMs % HOUR_MS === 0 && validTime(bar.openMs + HOUR_MS)
    && [bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
    && Number.isFinite(bar.volume) && bar.volume >= 0 && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= bar.low);
}

/** Pure price rules: no fit, sample bank, peer prices, or execution permission.
 * All prior supplied bars establish EMA and transition state. The output range
 * only filters decisions; each decision uses bars closed by that timestamp.
 * A gap resets own-asset history. A prior breakout state is tracked during
 * warmup, so becoming ready cannot turn a persistent breakout into a new event.
 */
export function buildHourlyPriceSetups(bars: readonly HourlyBar[], setupId: HourlyPriceSetupId,
  fromMs: number, toMs: number): PriceSetupSignal[] {
  if (!Array.isArray(bars) || !HOURLY_PRICE_SETUP_IDS.includes(setupId)
    || !validTime(fromMs) || !validTime(toMs) || fromMs >= toMs) throw new Error("INVALID_PRICE_SETUP_INPUT");
  const grouped = new Map<HourlySymbol, HourlyBar[]>(HOURLY_SYMBOLS.map(symbol => [symbol, []]));
  for (const bar of bars) {
    if (!validBar(bar)) throw new Error("INVALID_PRICE_SETUP_BAR");
    grouped.get(bar.symbol)!.push({ ...bar });
  }
  const signals: PriceSetupSignal[] = [];
  for (const symbol of HOURLY_SYMBOLS) {
    const own = grouped.get(symbol)!.sort((a, b) => a.openMs - b.openMs);
    for (let i = 1; i < own.length; i++) if (own[i]!.openMs === own[i - 1]!.openMs)
      throw new Error("DUPLICATE_PRICE_SETUP_BAR");
    const fast: number[] = [], slow: number[] = [], ranges: number[] = [], atr: number[] = [];
    let continuous = 0, priorLong = false, priorShort = false;
    for (let i = 0; i < own.length; i++) {
      const bar = own[i]!, decisionMs = bar.openMs + HOUR_MS;
      if (decisionMs >= toMs) break;
      const previous = own[i - 1], adjacent = previous !== undefined && bar.openMs - previous.openMs === HOUR_MS;
      continuous = adjacent ? continuous + 1 : 1;
      if (!adjacent) { priorLong = false; priorShort = false; }
      fast[i] = adjacent ? fast[i - 1]! + (bar.close - fast[i - 1]!) * 2 / 25 : bar.close;
      slow[i] = adjacent ? slow[i - 1]! + (bar.close - slow[i - 1]!) * 2 / 169 : bar.close;
      ranges[i] = adjacent ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))
        : bar.high - bar.low;
      let averageRange = 0;
      if (continuous >= 15) {
        for (let j = i - 13; j <= i; j++) averageRange += ranges[j]! / 14;
      }
      atr[i] = averageRange;
      let side: 1 | -1 | null = null, distance = 0;
      if (setupId === "channel-breakout-24h" && continuous >= 25) {
        let upper = -Infinity, lower = Infinity;
        for (let j = i - 24; j < i; j++) { upper = Math.max(upper, own[j]!.high); lower = Math.min(lower, own[j]!.low); }
        const long = bar.close > upper, short = bar.close < lower;
        if (long && !priorLong) { side = 1; distance = bar.close - upper; }
        else if (short && !priorShort) { side = -1; distance = lower - bar.close; }
        priorLong = long; priorShort = short;
      } else if (setupId === "trend-recovery-24h" && continuous >= 169) {
        let longPullback = false, shortPullback = false;
        for (let j = i - 4; j < i; j++) {
          longPullback ||= own[j]!.close <= fast[j]!;
          shortPullback ||= own[j]!.close >= fast[j]!;
        }
        if (fast[i]! > slow[i]! && bar.close > fast[i]! + .25 * atr[i]!
          && previous!.close <= fast[i - 1]! + .25 * atr[i - 1]! && longPullback) side = 1;
        else if (fast[i]! < slow[i]! && bar.close < fast[i]! - .25 * atr[i]!
          && previous!.close >= fast[i - 1]! - .25 * atr[i - 1]! && shortPullback) side = -1;
        if (side) distance = side * (bar.close - fast[i]!);
      }
      if (continuous < 169 || decisionMs < fromMs || !side || !(atr[i]! > 0)) continue;
      const roomBps = 2 * atr[i]! / bar.close * 10_000, strength = distance / atr[i]!;
      if (![roomBps, strength].every(value => Number.isFinite(value) && value > 0)) throw new Error("NONFINITE_PRICE_SETUP_SIGNAL");
      signals.push({ symbol, decisionMs, horizonHours: 24, side, setupId, roomBps, strength });
    }
  }
  return signals.sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol));
}
