import { type SpotFill } from "./account.js";
import { type SpotWeek } from "./data.js";
import { type SpotPolicy, type SpotScenario } from "./spec.js";
export interface SpotReplayWeek {
    openMs: number;
    endMs: number;
    signalAvailableAtMs: number;
    signalState: string;
    signalReason: string;
    quantity: number;
    cashUsd: number;
    liquidationEquityUsd: number;
    weeklyNetUsd: number;
    markedNotionalUsd: number;
    weeklyLowLiquidationEquityUsd: number;
}
export interface SpotReplay {
    version: string;
    policy: SpotPolicy;
    scenario: SpotScenario;
    startMs: number;
    endMs: number;
    firstEligibleExecutionOpenMs: number | null;
    finalEligibleExecutionOpenMs: number | null;
    initialCashUsd: number;
    initialEntryBudgetUsd: number;
    finalCashUsd: number;
    finalQuantity: number;
    netPnlUsd: number;
    realizedNetUsd: number;
    feesUsd: number;
    closedEpisodes: number;
    netReturnOnInitialEntryBudgetFraction: number;
    drawdownOnInitialEntryBudgetFraction: number;
    netAccountReturnFraction: number;
    buys: number;
    sells: number;
    turnoverUsd: number;
    investedWeeks: number;
    maximumMarkedNotionalUsd: number;
    maxWeeklyCloseDrawdownUsd: number;
    sampledPeakToWeeklyLowUsd: number;
    accountDrawdownHalted: boolean;
    terminalFlat: boolean;
    fivePercentInitialBudgetHurdleUsd: number;
    netAboveAllocatedCapitalHurdleUsd: number;
    orders: Array<SpotFill & {
        reason: string;
    }>;
    weekly: SpotReplayWeek[];
}
export declare function replaySpotTrend(input: {
    bars: readonly SpotWeek[];
    startMs: number;
    endMs: number;
    policy: SpotPolicy;
    scenario: SpotScenario;
}): SpotReplay;
/** Dependent observations: calendar-week moving blocks, never a trade-count confidence claim. */
export declare function bootstrapSpotWeeks(values: readonly number[], blockWeeks: number, repetitions: number, seed: number, quantile: number): {
    lowerMeanWeeklyNetUsd: null;
    completeWeeks: number;
    blocks: number;
} | {
    lowerMeanWeeklyNetUsd: number;
    completeWeeks: number;
    blocks: number;
};
