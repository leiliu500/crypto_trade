import { type SpotPaperState } from "./paper.js";
interface Envelope {
    version: "spot-paper-journal-v1";
    state: SpotPaperState;
    runtimeSourceSha256: string;
    lastEvidence: {
        file: string;
        sha256: string;
    } | null;
    receiptEvidence: Record<string, {
        file: string;
        sha256: string;
    }>;
    migrationEvidence?: {
        file: string;
        sha256: string;
    };
}
export declare function loadSpotPaperEnvelope(file: string, root: string): Promise<Envelope | null>;
export declare function migrateSpotPaperEnvelope(envelope: Envelope, root: string, sourceSha256: string): Promise<Envelope>;
export declare function runSpotPaper(args?: string[]): Promise<{
    system: string;
    mode: string;
    liveTradingEnabled: boolean;
    orderSubmissionEnabled: boolean;
    orderExecutionMode: string;
    provenProfitable: boolean;
    strategy: Readonly<{
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
    healthy: boolean;
    lastError: string | null;
    lastSuccessMs: number;
    evidence: {
        baseNetUsd: number;
        stressNetUsd: number;
        baseEpisodes: number;
        stressEpisodes: number;
        lowerMeanWeeklyNetUsd: number | null;
        provenProfitable: false;
    };
    state: SpotPaperState;
}>;
export {};
