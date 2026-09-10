import { createHash } from "node:crypto";
import { SYSTEMATIC_SPEC as S, type SystematicBar, type SystematicSignal } from "./spec.js";

const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** A fixed-window, causal price rule, not an expected return or probability.
 * Exactly the latest minimumBars completed own-asset candles seed EMA16/64.
 * This makes replay, restart and rolling HTTP warmup identical even when callers
 * provide different amounts of older history. ATR is the arithmetic mean of the
 * latest 32 true ranges, each using its immediately preceding completed close.
 * No peer asset is required. The caller must separately check signal freshness.
 *
 * Insufficient/gapped support returns null. Malformed admitted bars, duplicate
 * completed timestamps and invalid arguments throw; future/incomplete OHLCV is
 * never inspected. Enough support returns a diagnostic even without a direction.
 */
export function buildSystematicSignal(bars: readonly SystematicBar[], symbol: string,
  asOfMs: number, availableAtMs = asOfMs): SystematicSignal | null {
  if (!Array.isArray(bars) || !["BTC/USD", "ETH/USD"].includes(symbol)
    || !validTime(asOfMs) || !validTime(availableAtMs) || availableAtMs > asOfMs)
    throw new Error("SYSTEMATIC_SIGNAL_INVALID_ARGUMENT");
  const own: SystematicBar[] = [];
  for (const row of bars) {
    if (!row || typeof row !== "object") throw new Error("SYSTEMATIC_SIGNAL_INVALID_BAR");
    if (row.symbol !== symbol) continue;
    if (!validTime(row.openMs) || row.openMs % S.barMs !== 0 || !validTime(row.openMs + S.barMs))
      throw new Error("SYSTEMATIC_SIGNAL_INVALID_BAR_TIME");
    if (row.openMs + S.barMs > asOfMs) continue;
    if (![row.open, row.high, row.low, row.close].every(v => Number.isFinite(v) && v > 0)
      || !Number.isFinite(row.volume) || row.volume < 0 || row.low > Math.min(row.open, row.close)
      || row.high < Math.max(row.open, row.close) || row.low > row.high)
      throw new Error("SYSTEMATIC_SIGNAL_INVALID_BAR");
    // Canonical properties prevent object insertion order or extra source fields
    // from changing the fingerprint of the information actually used.
    own.push({ symbol, openMs: row.openMs, open: row.open, high: row.high,
      low: row.low, close: row.close, volume: row.volume });
  }
  own.sort((a, b) => a.openMs - b.openMs);
  for (let i = 1; i < own.length; i++) if (own[i]!.openMs === own[i - 1]!.openMs)
    throw new Error("SYSTEMATIC_SIGNAL_DUPLICATE_BAR");
  if (own.length < S.minimumBars) return null;
  const used = own.slice(-S.minimumBars), latest = used.at(-1)!;
  for (let i = 1; i < used.length; i++) if (used[i]!.openMs - used[i - 1]!.openMs !== S.barMs) return null;
  const barCloseMs = latest.openMs + S.barMs;
  if (availableAtMs < barCloseMs) throw new Error("SYSTEMATIC_SIGNAL_UNAVAILABLE_AT_RECEIPT");
  let emaFast = used[0]!.close, emaSlow = emaFast, atr = 0;
  for (let i = 1; i < used.length; i++) {
    const bar = used[i]!, previous = used[i - 1]!;
    emaFast += (bar.close - emaFast) * 2 / (S.fastSpan + 1);
    emaSlow += (bar.close - emaSlow) * 2 / (S.slowSpan + 1);
    if (i >= used.length - S.atrSpan) atr += Math.max(bar.high - bar.low,
      Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)) / S.atrSpan;
  }
  const atrBps = atr / latest.close * 10_000;
  const trendStrength = atr > 0 ? (emaFast - emaSlow) / atr : 0;
  const stopBps = S.stopAtr * atrBps, targetBps = S.targetAtr * atrBps;
  if (![emaFast, emaSlow, atr, atrBps, trendStrength, stopBps, targetBps].every(Number.isFinite))
    throw new Error("SYSTEMATIC_SIGNAL_NONFINITE_MATH");
  let side: SystematicSignal["side"] = null, reason = "NO_VOLATILITY";
  if (atr > 0) {
    reason = "WEAK_TREND";
    if (Math.abs(trendStrength) >= S.minimumTrendStrength) {
      const direction = trendStrength > 0 ? 1 : -1;
      reason = "PRICE_TREND_DISAGREEMENT";
      if (direction * (latest.close - emaSlow) > 0) {
        side = direction; reason = "SYSTEMATIC_TREND_SIGNAL";
      }
    }
  }
  const inputSha256 = createHash("sha256").update(JSON.stringify({ version: S.version,
    fastSpan: S.fastSpan, slowSpan: S.slowSpan, atrSpan: S.atrSpan,
    minimumBars: S.minimumBars, minimumTrendStrength: S.minimumTrendStrength,
    stopAtr: S.stopAtr, targetAtr: S.targetAtr, bars: used })).digest("hex");
  return { version: S.version, id: `${S.version}:${symbol}:${barCloseMs}:${inputSha256}`,
    symbol, barCloseMs, availableAtMs, side, reason, close: latest.close, emaFast, emaSlow,
    atr, atrBps, trendStrength, stopBps, targetBps, bars: used.length, inputSha256 };
}
