import type { CostEstimate } from "../strategy/cost.js";
import type { EntryPipelineSnapshot } from "../engine/entry-pipeline-audit.js";
import type { FeatureStaleReason, KinematicsResetReason } from "../core/market.js";
import type { OrderCancellationReason, OrderCancelRequestReason } from "../execution/order-state.js";
import type { EntryFamily } from "../economics/types.js";

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

export interface DashboardPnlPoint {
  atMs: number;
  currentPx: number;
  unrealizedPnl: number;
  unrealizedPnlBps: number;
  changePnl: number | null;
  kind?: "mark" | "close";
}

export interface DashboardLivePosition {
  active: boolean;
  closedAtMs: number | null;
  openedMs: number;
  ageMs: number;
  qty: number;
  entryPx: number;
  currentPx: number;
  unrealizedPnl: number;
  unrealizedPnlBps: number;
  realizedPnl: number | null;
  realizedPnlBps: number | null;
  closePx: number | null;
  entryOrderId: string | null;
  exitOrderId: string | null;
  phase: string;
  latestAction: string;
  latestReason: string | null;
  pnlHistory: readonly DashboardPnlPoint[];
}

export interface DashboardOrderCard {
  clientOrderId: string;
  alpacaOrderId: string | null;
  historical: boolean;
  symbol: string;
  side: 1 | -1;
  style: string;
  entryFamily?: EntryFamily | null;
  timeInForce: string;
  status: string;
  statusLabel: string;
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
  cancelRequestReason: OrderCancelRequestReason | null;
  cancellationReason: OrderCancellationReason | null;
  timeline: readonly OrderTimelineEntry[];
  livePosition: DashboardLivePosition | null;
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
  slowTrendReady: boolean;
  trendFastBps: number | null;
  trendMediumBps: number | null;
  trendSlowBps: number | null;
  slowTrendAlignment: number | null;
  slowTrendEfficiency: number | null;
  longPullbackReady: boolean;
  longPullbackDepthBps: number | null;
  longPullbackRecoveryBps: number | null;
  longPullbackRemainingRoomBps: number | null;
  providerAgeMs: number | null;
  staleThresholdMs: number | null;
  warmedUp: boolean;
  kinematicsReady: boolean;
  kinematicsResetReason: KinematicsResetReason | null;
  stale: boolean;
  staleReason: FeatureStaleReason | null;
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
  candidateReady: boolean;
  candidateSide: number | null;
  entryReady: boolean;
  liquidityTradeThresholdBps: number | null;
  liquidityStressThresholdBps: number | null;
  liquidityReasons: readonly string[];
  entryPipeline: EntryPipelineSnapshot | null;
  blockReasons: readonly string[];
}

export interface DashboardRuleDiagnostics {
  family: string;
  side: number;
  phase: string;
  score: number;
  bookVotes: number;
  flowVotes: number;
  kinematicVotes: number;
  quorumPass: boolean;
  persistence: number;
  evidence: number;
  confirmationMs: number;
  confirmationEvents: number;
  deltaMicroBps: number;
  sensorThresholdBps: number;
  microNoiseBps: number;
  chaseBps: number;
  grossOpportunityBps: number;
  uncertaintyReserveBps: number;
  roundTripCostBps: number;
  robustCostBps: number;
  lowerBoundNetBps: number;
  costShortfallBps: number;
  continuationQuality: number;
  requiredContinuationQuality: number | null;
  economicSizeScale: number;
  edgeHorizonMs: number;
  executionPath: string | null;
  scorePass: boolean;
  rawDirectionalPass: boolean;
  candidatePass: boolean;
  healthPass: boolean;
  liquidityPass: boolean;
  regimePass: boolean;
  persistencePass: boolean;
  antiChasePass: boolean;
  exposurePass: boolean;
  cooldownPass: boolean;
  costPass: boolean;
  arbitrationPass: boolean;
  slowTrendPass: boolean;
  continuationTrendPass: boolean;
  pullbackRecoveryPass: boolean;
  tradeThresholdBps: number;
  stressThresholdBps: number;
  liquidityReasons: readonly string[];
  reasons: readonly string[];
}

export interface DashboardSnapshot {
  version: 1;
  generatedAtMs: number;
  mode: string;
  paper: boolean;
  paperEntryExercise?: boolean;
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
