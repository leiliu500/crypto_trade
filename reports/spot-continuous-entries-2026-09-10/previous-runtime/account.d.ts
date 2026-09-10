/** Research-only spot accounting and displayed-book paper execution. No order adapter. */
export interface SpotFill {
    id: string;
    side: "buy" | "sell";
    quantity: number;
    /** Volume-weighted executed price; an average need not align to a price tick. */
    price: number;
    feeBps: number;
    timestampMs: number;
}
export interface SpotAccount {
    initialCashUsd: number;
    cashUsd: number;
    quantity: number;
    /** Remaining weighted acquisition cost, including entry fees. */
    entryCostUsd: number;
    realizedNetUsd: number;
    feesUsd: number;
    receipts: SpotFill[];
}
export interface SpotPaperBook {
    bids: [number, number][];
    asks: [number, number][];
    receivedAtMs: number;
}
export interface SpotPaperRules {
    lotSize: number;
    minimumQuantity: number;
    minimumNotionalUsd: number;
    tickSize: number;
}
export interface SpotPaperFillInput {
    account: SpotAccount;
    side: "buy" | "sell";
    /** Buy: maximum debit including fees. Sell: optional maximum gross sale notional. */
    budgetUsd?: number;
    /** Sell-only upper bound for a partial reduction; defaults to the actual inventory. */
    quantity?: number;
    book: SpotPaperBook;
    nowMs: number;
    feeBps: number;
    rules: SpotPaperRules;
    id: string;
}
export interface SpotPaperFillPlan {
    fill: SpotFill | null;
    reason: string;
    /** Full displayed notional on the requested side within the 10 bps collar. */
    visibleNotionalUsd: number;
}
export declare function createSpotAccount(initialCashUsd?: number): SpotAccount;
export declare function applySpotFill(account: SpotAccount, fill: SpotFill): SpotAccount;
export declare function markSpotAccount(account: SpotAccount, bid: number, exitFeeBps: number): {
    equityUsd: number;
    liquidationEquityUsd: number;
    unrealizedNetUsd: number;
    netPnlUsd: number;
};
/**
 * Simulated marketable IOC: fresh, uncrossed L2, a 10 bps collar from the best price,
 * and at most 5% of total displayed quantity inside that collar. The book walk uses
 * actual displayed levels; it adds no invented depth or separate slippage charge.
 * Partial quantity is allowed, subject to exchange lot and minimum-order rules.
 */
export declare function planSpotPaperFill(input: SpotPaperFillInput): SpotPaperFillPlan;
