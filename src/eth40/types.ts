import type { SpotAccount, SpotPaperBook, SpotPaperRules } from "../spot-trend/account.js";

export type Asset = "ETH/USD" | "BTC/USD";
export interface DailyBar { openTimeMs: number; open: number; high: number; low: number; close: number; volume: number }
export interface VerifiedBook extends SpotPaperBook {
  symbol: Asset;
  checksumValid: boolean;
  checksum: string;
  exchangeUpdateAtMs: number;
  connectionId: string;
  checksumAsks?: [string, string][];
  checksumBids?: [string, string][];
  checksumVerification?: "LOCAL_TOP10_CRC32";
}
export interface MarketSnapshot {
  observedAtMs: number;
  histories: Record<Asset, DailyBar[]>;
  books: Partial<Record<Asset, VerifiedBook>>;
  rules: Partial<Record<Asset, SpotPaperRules>>;
  rulesFetchedAtMs: number;
  rulesFetchedAtMsByAsset?: Partial<Record<Asset, number>>;
  errors: string[];
  evidenceIds: string[];
}
export type AccountId = "eth40" | "passiveEth" | "passiveBtc";
export interface PaperPortfolio {
  symbol: Asset;
  account: SpotAccount;
  entered: boolean;
  lastFillDayMs: number | null;
  completedEpisodes: number;
  peakLiquidationEquityUsd: number;
  maxDrawdownUsd: number;
}
export interface PaperState {
  version: "eth40-forward-v1";
  startedAtMs: number;
  reviewAtMs: number;
  firstExecutionDayMs: number;
  lastCycleAtMs: number;
  portfolios: Record<AccountId, PaperPortfolio>;
}
export interface Decision {
  accountId: AccountId;
  symbol: Asset;
  action: "buy" | "sell" | "hold" | "blocked";
  reason: string;
  target: "long" | "cash" | null;
  signalDayMs: number | null;
  sma40: number | null;
  close: number | null;
  orderId: string | null;
  fill: import("../spot-trend/account.js").SpotFill | null;
  budgetUsd: number | null;
}
export interface Valuation {
  accountId: AccountId;
  cashUsd: number;
  quantity: number;
  liquidationEquityUsd: number | null;
  netPnlUsd: number | null;
  realizedNetUsd: number;
  feesUsd: number;
  quoteAgeMs: number | null;
  fresh: boolean;
}
export interface CycleResult { state: PaperState; decisions: Decision[]; valuations: Valuation[] }
