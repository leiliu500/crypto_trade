import type { CostEstimate } from "../strategy/cost.js";

export type HealthTone = "healthy" | "degraded" | "critical";
export type EventSeverity = "info" | "warning" | "critical";

export interface DatabaseHealth {
  connected: boolean;
  status: "disabled" | "connecting" | "connected" | "degraded";
  queuedRecords: number;
  droppedRecords: number;
  lastPersistedAtMs: number | null;
  lastError: string | null;
}

export interface LivenessCheck {
  id: string;
  label: string;
  healthy: boolean;
  detail: string;
  updatedAtMs: number;
}

export interface DashboardEvent {
  id: string;
  type: string;
  severity: EventSeverity;
  atMs: number;
  symbol: string | null;
  clientOrderId: string | null;
  summary: string;
  payload: unknown;
}

export interface OrderTimelineEntry {
  id: string;
  status: string;
  label: string;
  atMs: number;
  severity: EventSeverity;
}

export interface DashboardOrderCard {
  clientOrderId: string;
  alpacaOrderId: string | null;
  symbol: string;
  side: 1 | -1;
  style: string;
  timeInForce: string;
  status: string;
  terminal: boolean;
  requestedQty: number;
  filledQty: number;
  remainingQty: number;
  fillPercent: number;
  averageFillPx: number;
  limitPx: number;
  expectedValue: number;
  fillProbability: number;
  expectedCost: CostEstimate;
  reduceOnlyIntent: boolean;
  createdMs: number;
  expiresMs: number;
  updatedMs: number;
  ageMs: number;
  expiresInMs: number;
  error: string | null;
  timeline: readonly OrderTimelineEntry[];
}

export interface DashboardPositionCard {
  symbol: string;
  side: 1 | -1;
  qty: number;
  entryPx: number;
  currentPx: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlBps: number | null;
  phase: string;
  openedMs: number;
  ageMs: number;
  initialRiskPx: number;
  floorPx: number;
  stopPx: number;
  mfePx: number;
  maePx: number;
  breakEvenArmed: boolean;
  latestAction: string;
  latestReason: string | null;
  holdEdgeBps: number | null;
  reversalProbability: number | null;
}

export interface DashboardMarketCard {
  symbol: string;
  bookValid: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  spreadBps: number | null;
  sigmaHBps: number | null;
  providerAgeMs: number | null;
  staleThresholdMs: number | null;
  warmedUp: boolean;
  stale: boolean;
  sequence: string;
  qi1: number | null;
  ofi: number | null;
  tfi: number | null;
  efficiency: number | null;
  velocityZ: number | null;
  regime: string | null;
  longScore: number | null;
  shortScore: number | null;
  longPhase: string | null;
  shortPhase: string | null;
  longRule: DashboardRuleDiagnostics | null;
  shortRule: DashboardRuleDiagnostics | null;
  entryReady: boolean;
  blockReasons: readonly string[];
}

export interface DashboardRuleDiagnostics {
  side: number;
  phase: string;
  score: number;
  bookVotes: number;
  flowVotes: number;
  kinematicVotes: number;
  quorumPass: boolean;
  persistence: number;
  confirmationMs: number;
  confirmationEvents: number;
  grossOpportunityBps: number;
  uncertaintyReserveBps: number;
  roundTripCostBps: number;
  lowerBoundNetBps: number;
  healthPass: boolean;
  liquidityPass: boolean;
  regimePass: boolean;
  persistencePass: boolean;
  antiChasePass: boolean;
  costPass: boolean;
  arbitrationPass: boolean;
  reasons: readonly string[];
}

export interface DashboardSnapshot {
  version: 1;
  generatedAtMs: number;
  mode: string;
  paper: boolean;
  strategyVersion: string;
  modelVersion: string;
  configurationVersion: string;
  signalMode: string;
  started: boolean;
  uptimeMs: number;
  overall: HealthTone;
  entriesAllowed: boolean;
  haltReasons: readonly string[];
  equity: number;
  equityHighWater: number;
  realizedSessionPnl: number;
  latencyP95Ms: number;
  liveness: readonly LivenessCheck[];
  database: DatabaseHealth;
  markets: readonly DashboardMarketCard[];
  positions: readonly DashboardPositionCard[];
  orders: readonly DashboardOrderCard[];
  events: readonly DashboardEvent[];
}

export type TelemetryKind = "event" | "health" | "order" | "position" | "decision" | "fill" | "market";
export interface TelemetryRecord {
  kind: TelemetryKind;
  atMs: number;
  payload: unknown;
}

export const disabledDatabaseHealth = (): DatabaseHealth => ({
  connected: false,
  status: "disabled",
  queuedRecords: 0,
  droppedRecords: 0,
  lastPersistedAtMs: null,
  lastError: null,
});
