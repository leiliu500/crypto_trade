import { type SpotWeek } from "./data.js";
export declare const SPOT_MARKET_SOURCES: Readonly<{
    ohlc: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080";
    rules: "https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD";
    book: "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=100";
}>;
export interface SpotMarketSource {
    url: string;
    requestedAtMs: number;
    receivedAtMs: number;
    sha256: string;
    responseBytes: number;
    httpStatus: number;
    /** Exact UTF-8 body text; invalid UTF-8 additionally preserves the exact base64 bytes. */
    rawBody: string;
    rawBodyBase64?: string;
    rawDocument: unknown;
    parseError?: string;
    serverDateHeader: string | null;
}
export interface SpotMarketRules {
    lotSize: number;
    minimumQuantity: number;
    minimumNotionalUsd: number;
    tickSize: number;
}
export interface SpotMarketBook {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
    /** Local full-response receipt only; this does not prove continuous venue freshness. */
    receivedAtMs: number;
}
export interface SpotMarketSnapshot {
    retrievedAtMs: number;
    bars: SpotWeek[];
    book: SpotMarketBook;
    rules: SpotMarketRules;
    sources: SpotMarketSource[];
    /** Missing history forbids new risk but does not discard valid books needed for exits. */
    historyError?: string;
}
export declare function parseSpotMarketRules(document: unknown): SpotMarketRules;
export declare function parseSpotMarketBook(document: unknown, receivedAtMs: number): SpotMarketBook;
/** Public REST data only: this module has no private API, credentials, or order path. */
export declare function fetchSpotMarketSnapshot(dependencies?: {
    fetcher?: typeof fetch;
    now?: () => number;
}): Promise<SpotMarketSnapshot>;
