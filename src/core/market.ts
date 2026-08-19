export type Direction = 1 | -1;
export type Side = "buy" | "sell";

export interface Level {
  px: number;
  qty: number;
  ageMs?: number;
  cancellationHazard?: number;
}

export interface BookState {
  symbol: string;
  bids: readonly Level[];
  asks: readonly Level[];
  exchangeTsMs: number;
  receiveTsMs: number;
  sequence: bigint;
  valid: boolean;
  sourceReset: boolean;
}

export interface MarketTrade {
  id: string;
  symbol: string;
  px: number;
  qty: number;
  aggressor: Direction;
  exchangeTsMs: number;
  receiveTsMs: number;
}

export interface BookFlow {
  bidAdded: number;
  bidCanceled: number;
  askAdded: number;
  askCanceled: number;
  bidReplenishmentRate: number;
  askReplenishmentRate: number;
}

export interface Features {
  symbol: string;
  mid: number;
  spread: number;
  spreadBps: number;
  microprice: number;
  visibleDepth: number;

  qi1: number;
  qiK: number;
  persistentQiK: number;
  ofi: number;
  tfi: number;
  bidCancellationRatio: number;
  askCancellationRatio: number;
  replenishmentPressure: number;

  velocity: number;
  acceleration: number;
  varianceRate: number;
  sigmaHBps: number;
  microEdgeZ: number;
  velocityZ: number;
  accelerationZ: number;

  efficiency: number;
  cusumUp: boolean;
  cusumDown: boolean;
  spreadZ: number;
  depthZ: number;
  signalFlipRate: number;

  providerAgeMs: number;
  staleThresholdMs: number;
  warmedUp: boolean;
  stale: boolean;
  receiveTsMs: number;
}

export type MarketEvent =
  | { kind: "BOOK"; id: string; book: BookState }
  | { kind: "TRADE"; id: string; trade: MarketTrade }
  | { kind: "HEARTBEAT"; id: string; symbol: string; receiveTsMs: number }
  | { kind: "DISCONNECT"; id: string; reason: string; receiveTsMs: number };

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

export const sigmoid = (x: number): number => {
  const z = clamp(x, -40, 40);
  return 1 / (1 + Math.exp(-z));
};

export const assertFinitePositive = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and positive`);
  }
};

export const sideToDirection = (side: Side): Direction => side === "buy" ? 1 : -1;
export const directionToSide = (direction: Direction): Side => direction === 1 ? "buy" : "sell";
