import type { SpotWeek } from "./data.js";
import { WEEK_MS } from "./data.js";
import { SPOT_TREND_SPEC as S } from "./spec.js";

export interface SpotTrendSignal {
  version: string; availableAtMs: number; lastWeekEndMs: number | null;
  state: "long" | "cash"; reason: "WARMUP" | "TREND_ENTER" | "TREND_EXIT" | "HOLD_BAND";
  close: number | null; movingAverage: number | null;
}

/** Consumes only bars already available at decision time; state is causal hysteresis. */
export function spotTrendSignal(bars: readonly SpotWeek[], nowMs: number, previous: "long" | "cash"): SpotTrendSignal {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !["long", "cash"].includes(previous)) throw new Error("INVALID_SPOT_SIGNAL_ARGUMENT");
  const completed = bars.filter(b => b.availableAtMs <= nowMs);
  const window = completed.slice(-S.movingAverageWeeks);
  for (let i = 0; i < window.length; i++) {
    const b = window[i]!;
    if (![b.close, b.openMs, b.endMs, b.availableAtMs].every(Number.isFinite) || b.close <= 0
      || b.endMs !== b.openMs + WEEK_MS || b.availableAtMs < b.endMs
      || i > 0 && b.openMs !== window[i - 1]!.endMs) throw new Error("INVALID_SPOT_SIGNAL_HISTORY");
  }
  const last = window.at(-1);
  const base = { version: S.version, availableAtMs: last?.availableAtMs ?? nowMs,
    lastWeekEndMs: last?.endMs ?? null, close: last?.close ?? null };
  if (window.length < S.movingAverageWeeks) return { ...base, state: "cash", reason: "WARMUP", movingAverage: null };
  const movingAverage = window.reduce((sum, b) => sum + b.close, 0) / window.length;
  if (last!.close <= movingAverage) return { ...base, state: "cash", reason: "TREND_EXIT", movingAverage };
  if (last!.close > movingAverage * (1 + S.entryBufferFraction)) return { ...base, state: "long", reason: "TREND_ENTER", movingAverage };
  return { ...base, state: previous, reason: "HOLD_BAND", movingAverage };
}

export function reconstructSpotTrend(bars: readonly SpotWeek[], nowMs: number): SpotTrendSignal {
  let signal = spotTrendSignal([], nowMs, "cash");
  for (const bar of bars) {
    if (bar.availableAtMs > nowMs) break;
    signal = spotTrendSignal(bars, bar.availableAtMs, signal.state);
  }
  return signal;
}
