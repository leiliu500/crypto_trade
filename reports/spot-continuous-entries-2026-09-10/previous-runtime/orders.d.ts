import { type SpotAccount, type SpotFill, type SpotPaperBook, type SpotPaperRules } from "./account.js";
/** Orders belong to the local paper broker. No exchange credentials or transport are used. */
export interface SpotOrderRequest {
    clientOrderId: string;
    symbol: "BTC/USD";
    side: "buy" | "sell";
    quantity: number;
    limitPrice: number;
    timeInForce: "ioc";
    reduceOnly: boolean;
    createdAtMs: number;
    feeBps: number;
}
export type SpotPaperOrderStatus = "SUBMITTED" | "ACCEPTED" | "FILLED" | "CANCELED" | "REJECTED";
export interface SpotPaperOrderEvent {
    type: SpotPaperOrderStatus | "PARTIAL_FILL";
    timestampMs: number;
    detail?: string;
}
export interface SpotPaperOrder {
    request: SpotOrderRequest;
    orderId: string;
    status: SpotPaperOrderStatus;
    filledQuantity: number;
    averageFillPrice: number | null;
    feeUsd: number;
    rejectionReason: string | null;
    cancellationReason: string | null;
    events: SpotPaperOrderEvent[];
    fill: SpotFill | null;
}
export interface SpotOrderExecutionSnapshot {
    book: SpotPaperBook;
    rules: SpotPaperRules;
    /** Expected fee from the deployed policy, independently checked against the request. */
    feeBps: number;
}
export declare const SPOT_ORDER_SPEC: Readonly<{
    maximumLifetimeMs: 30000;
    timeInForce: "ioc";
    mode: "PAPER";
}>;
/** Every receipt has exactly one terminal order, and every order fill has its receipt. */
export declare function validateSpotOrderLedger(orders: SpotPaperOrder[], account: SpotAccount): void;
/** Caller must durably persist this SUBMITTED transition before calling execution. */
export declare function submitSpotPaperOrder(existingOrders: SpotPaperOrder[], request: SpotOrderRequest, account: SpotAccount): SpotPaperOrder[];
/** Explicit cancellation is durable through the same terminal event shape as IOC expiry. */
export declare function cancelSpotPaperOrder(order: SpotPaperOrder, reason: string, nowMs: number): SpotPaperOrder;
/** Pure IOC matching: accepted events and account/receipt changes commit together. */
export declare function executeSpotPaperOrder(order: SpotPaperOrder, account: SpotAccount, snapshot: SpotOrderExecutionSnapshot, nowMs: number): {
    order: SpotPaperOrder;
    account: SpotAccount;
};
