import { markSpotAccount, type SpotAccount, type SpotFill } from "./account.js";
import type { SpotMarketSnapshot } from "./market.js";
import { type SpotTrendSignal } from "./signal.js";
import { type SpotPaperOrder } from "./orders.js";
export declare const SPOT_PAPER_SPEC: Readonly<{
    readonly version: "btc-spot-weekly-research-paper-runner-v2";
    readonly mode: "RESEARCH_PAPER";
    readonly cycleIntervalMs: 300000;
    readonly maximumBookAgeMs: 5000;
    readonly entryWindowMs: 3600000;
    readonly signalCutoff: "CURRENT_NATIVE_WEEK_OPEN;ONLY_ALREADY_FINALIZED_PREVIOUS_SIGNALS;MATCHES_HISTORICAL_BASE_WEEK_DELAY";
    readonly entries: "FIRST_HOUR_OF_NATIVE_WEEK_ONLY;NO_MIDWEEK_CATCH_UP;FIRST_PARTIAL_FILL_CONSUMES_ENTRY_NO_ADDITIONS";
    readonly exits: "CURRENT_DELAYED_WEEKLY_CASH_STATE_OR_MISSING_HISTORY_OR_PERSISTENT_ACCOUNT_DRAWDOWN_HALT;RETRY_PARTIAL_EXITS_WITH_FRESH_BOOKS";
    readonly execution: "DURABLE_SUBMITTED_PAPER_IOC_THEN_BROKER_ACCEPTANCE_FILL_OR_CANCEL;10_BPS_COLLAR;5_PERCENT_ELIGIBLE_DEPTH;NO_LIVE_EXCHANGE_ORDERS";
    readonly interpretation: "FORWARD_RESEARCH_PAPER_ONLY;L2_SIMULATED_FILLS_ARE_NOT_OBSERVED_VENUE_FILLS;LIVE_TRADING_DISABLED";
}>;
export interface SpotPaperDecision {
    timestampMs: number;
    action: "buy" | "sell" | "hold";
    reason: string;
    fill: SpotFill | null;
    orderId?: string | null;
    signal: SpotTrendSignal;
    mark: ReturnType<typeof markSpotAccount> | null;
}
export interface SpotPaperState {
    version: typeof SPOT_PAPER_SPEC.version;
    mode: "RESEARCH_PAPER";
    startedAtMs: number;
    lastCycleMs: number;
    cycles: number;
    account: SpotAccount;
    peakEquityUsd: number;
    halted: boolean;
    lastSignal: SpotTrendSignal | null;
    lastDecision: SpotPaperDecision | null;
    evidenceSha256: string;
    orders: SpotPaperOrder[];
}
export declare function createSpotPaperState(evidenceSha256: string, nowMs: number): SpotPaperState;
export declare function validateSpotPaperState(state: SpotPaperState): void;
export declare function prepareSpotPaperCycle(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number): {
    state: SpotPaperState;
    decision: SpotPaperDecision;
};
/** Call only after the submitted request has been durably recorded. */
export declare function settleSpotPaperCycle(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number): {
    state: SpotPaperState;
    decision: SpotPaperDecision;
};
/** In-memory convenience for deterministic tests. The service persists between these phases. */
export declare function advanceSpotPaper(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number): {
    state: SpotPaperState;
    decision: SpotPaperDecision;
};
