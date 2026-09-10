import type { Direction } from "../core/market.js";

/** Declared before the development replay. No parameter search or profit claim. */
export const SYSTEMATIC_SPEC = Object.freeze({
  version: "btc-eth-hourly-trend-paper-v1", barMs: 3_600_000,
  fastSpan: 16, slowSpan: 64, atrSpan: 32, minimumBars: 192,
  minimumTrendStrength: .5, stopAtr: 2, targetAtr: 4,
  trailingAtr: 2, trailActivationR: 1,
  maximumHoldMs: 72 * 3_600_000, reentryCooldownMs: 6 * 3_600_000,
  maximumSignalAgeMs: 75 * 60_000, maximumQuoteAgeMs: 1_000,
  entryLatencyMs: 250, entryTtlMs: 2_000,
  maximumSpreadBps: 5, maximumEntrySlippageBps: 3,
  maximumCostToStopRatio: .25, fundingReserveBpsPerDay: 3,
  maximumPendingAttemptsPerSignal: 3, retryMs: 60_000,
  interpretation: "SYSTEMATIC_PAPER_HYPOTHESIS_NOT_RETURN_FORECAST",
});

export interface SystematicBar {
  symbol: string; openMs: number; open: number; high: number; low: number; close: number; volume: number;
}
export interface SystematicSignal {
  version: string; id: string; symbol: string; barCloseMs: number; availableAtMs: number;
  side: Direction | null; reason: string; close: number; emaFast: number; emaSlow: number;
  atr: number; atrBps: number; trendStrength: number; stopBps: number; targetBps: number;
  bars: number; inputSha256: string;
}
export interface SystematicPositionSpec {
  version: string; signalId: string; signalBarCloseMs: number;
  stopBps: number; targetBps: number; trailingBps: number; trailActivationR: number;
  maximumHoldMs: number; feeBps: number; fundingReserveBps: number;
}
export interface SystematicDecision {
  version: string; symbol: string; atMs: number; quoteSequence: string;
  signal: SystematicSignal | null; reason: string; paperReady: boolean;
  side: Direction | null; qty: number; referenceBid: number; referenceAsk: number;
  limitPx: number; estimatedCostBps: number | null; costToStopRatio: number | null;
  maximumNotional: number; availableDepthQty: number; bindingLimit: string | null;
}
