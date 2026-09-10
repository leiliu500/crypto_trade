export declare const WEEK_MS: number;
export declare const SPOT_WEEK_DATA_SPEC: Readonly<{
    readonly version: "kraken-btc-spot-weeks-v1";
    readonly symbol: "BTC/USD";
    readonly intervalMinutes: 10080;
    readonly sourceUrl: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080";
    readonly documentationUrl: "https://docs.kraken.com/api-reference/market-data/get-ohlc-data";
    readonly maximumResponseBytes: number;
    readonly maximumSourceRows: 721;
    readonly finalizationLagMs: 60000;
    readonly startMs: 0;
    readonly gapPolicy: "REJECT_MISSING_COMPLETED_WEEKS";
    readonly timestamps: "NATIVE_THURSDAY_UTC_EPOCH_ALIGNED_WEEKS";
}>;
export interface SpotWeek {
    openMs: number;
    endMs: number;
    availableAtMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trades: number;
}
export interface SpotWeekDataset {
    version: typeof SPOT_WEEK_DATA_SPEC.version;
    symbol: "BTC/USD";
    intervalMinutes: 10080;
    bars: SpotWeek[];
    sourceUrl: typeof SPOT_WEEK_DATA_SPEC.sourceUrl;
    sourceSha256: string;
    sourceBytes: number;
    retrievedAtMs: number;
    coverage: {
        originalRows: number;
        retainedBars: number;
        firstOpenMs: number;
        lastEndMs: number;
        excludedIncomplete: number;
        gaps: Array<{
            fromMs: number;
            toMs: number;
            weeks: number;
        }>;
    };
    limitations: string[];
}
/** No incomplete/future price is accessed when selecting the completed dataset. */
export declare function parseSpotWeeks(document: unknown, asOfMs: number): SpotWeek[];
/** Data acquisition only; a directory is immutable and is never resumed/overwritten. */
export declare function downloadSpotWeeks(root: string, dependencies?: {
    fetcher?: typeof fetch;
    nowMs?: number;
}): Promise<SpotWeekDataset>;
/** Reconstruct every retained bar from the hash-bound public source, not cached features. */
export declare function loadSpotWeeks(root: string): Promise<SpotWeekDataset>;
export declare function main(args?: string[]): Promise<void>;
