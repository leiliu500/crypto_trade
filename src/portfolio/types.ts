import type { AssetRules } from "../execution/planner.js";
import type { HourlyBar } from "../research/hourly-data.js";

export const PORTFOLIO_SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
export type PortfolioSymbol = typeof PORTFOLIO_SYMBOLS[number];
export type Pair<T> = Record<PortfolioSymbol, T>;
export const PORTFOLIO_HOUR_MS = 3_600_000;
export const PORTFOLIO_DAY_MS = 24 * PORTFOLIO_HOUR_MS;
export const PORTFOLIO_VERSION = "btc-eth-persistent-target-portfolio-v1";
export const PORTFOLIO_SPEC = Object.freeze({
  version: PORTFOLIO_VERSION, maximumGrossNotionalUsd: 12,
  trendLookbackDays: Object.freeze([30, 90, 360]), volatilityLookbackDays: 60,
  minimumDailyVolatility: .0001, signalClip: 1, decisionIntervalMs: PORTFOLIO_DAY_MS,
  sameSideDeadbandFraction: .25, targetValidityMs: 2 * PORTFOLIO_DAY_MS,
  targetExpiryAction: "FLATTEN_ON_FRESH_EXECUTABLE_QUOTES",
  maximumPendingOrders: 2, maximumQuoteAgeMs: 5_000,
  targetInterpretation: "DIMENSIONLESS_TREND_AND_RELATIVE_INVERSE_VOLATILITY;NOT_EXPECTED_RETURN",
  sizing: "JOINT_FEASIBLE_LOT_ALLOCATION_UNDER_SHARED_12_USD_GROSS_CAP",
  objective: "SUM_SQUARED_USD_TRACKING_ERROR_DIVIDED_BY_12_PLUS_ESTIMATED_ADJUSTMENT_COST_USD",
});

export type PortfolioPolicy = "multiscale-trend" | "sign-trend-90d" | "constant-btc" | "constant-eth" | "flat";
export interface PortfolioSignal {
  symbol: PortfolioSymbol; close: number; dailyVolatility: number;
  trendScores: number[]; score: number; relativeRiskWeight: number;
}
export interface PortfolioTarget {
  version: typeof PORTFOLIO_VERSION; policy: PortfolioPolicy; decisionMs: number;
  availableAtMs: number; validUntilMs: number; inputSha256: string;
  targetUsd: Pair<number>; signals: PortfolioSignal[];
}
export interface PortfolioQuote {
  symbol: PortfolioSymbol; atMs: number; bid: number; ask: number;
  bidQty: number; askQty: number;
}
export interface PortfolioPosition { qty: number; averagePrice: number; }
export interface PortfolioOrder {
  id: string; symbol: PortfolioSymbol; signedQty: number; remainingQty: number;
  reduceOnly: boolean; limitPrice: number; createdAtMs: number; targetDecisionMs: number;
}
export interface PortfolioState {
  version: typeof PORTFOLIO_VERSION; initialEquityUsd: number; cashUsd: number;
  positions: Pair<PortfolioPosition>; pending: PortfolioOrder[];
  processedFillIds: string[]; processedFundingIds: string[];
  fillReceipts: PortfolioFill[];
  fundingReceipts: Array<{ id: string; atMs: number; costUsd: number }>;
  totalFeesUsd: number; totalFundingCostUsd: number; totalTurnoverUsd: number;
  realizedPricePnlUsd: number; nextOrderSequence: number;
}
export interface PortfolioFill {
  id: string; orderId: string; symbol: PortfolioSymbol; atMs: number;
  signedQty: number; price: number; feeUsd: number;
}
export interface PortfolioPlan {
  atMs: number; targetDecisionMs: number; status: "WAIT" | "HOLD" | "REDUCE" | "INCREASE" | "BLOCKED";
  reason: string; executableQty: Pair<number>; desiredUsd: Pair<number>;
  grossNotionalUsd: number; unusedCapacityUsd: number; estimatedAdjustmentCostUsd: number;
  orders: PortfolioOrder[];
  riskPrices: Pair<number>;
  rules: Pair<AssetRules>;
}
export interface PortfolioPlannerInput {
  state: PortfolioState; target: PortfolioTarget; quotes: Pair<PortfolioQuote>;
  rules: Pair<AssetRules>; atMs: number; feeBps: number; forceFlat?: boolean;
}
export type { AssetRules, HourlyBar };
