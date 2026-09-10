import type { SpotWeek } from "./data.js";
export interface SpotTrendSignal {
    version: string;
    availableAtMs: number;
    lastWeekEndMs: number | null;
    state: "long" | "cash";
    reason: "WARMUP" | "TREND_ENTER" | "TREND_EXIT" | "HOLD_BAND";
    close: number | null;
    movingAverage: number | null;
}
/** Consumes only bars already available at decision time; state is causal hysteresis. */
export declare function spotTrendSignal(bars: readonly SpotWeek[], nowMs: number, previous: "long" | "cash"): SpotTrendSignal;
export declare function reconstructSpotTrend(bars: readonly SpotWeek[], nowMs: number): SpotTrendSignal;
