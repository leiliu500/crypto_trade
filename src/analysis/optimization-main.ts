import { Pool } from "pg";
import { loadConfig } from "../config.js";
import type { DashboardPnlPoint } from "../dashboard/types.js";
import { loadLocalEnv } from "../env.js";
import { analyzeTradeOptimization, type OptimizationLivePosition, type OptimizationOrder,
  type OptimizationRouteShadowMark } from "./trade-optimization.js";

interface OrderRow {
  client_order_id: string;
  run_id: string | null;
  dropped_records: string | number | null;
  symbol: string;
  side: string | number;
  style: string;
  status: string;
  requested_qty: string | number;
  filled_qty: string | number;
  fill_probability: string | number | null;
  reduce_only_intent: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  cancellation_reason: string | null;
  plan: unknown;
}

interface RouteShadowRow {
  run_id: string | null;
  dropped_records: string | number | null;
  payload: unknown;
}

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
  application_name: "crypto-trade-optimization-report" });
try {
  const result = await pool.query<OrderRow>(`
    WITH run_health AS (
      SELECT run_id,max(database_dropped_records) AS dropped_records
      FROM health_snapshots
      WHERE database_dropped_records IS NOT NULL
      GROUP BY run_id
    )
    SELECT o.client_order_id,o.run_id,rh.dropped_records,o.symbol,o.side,o.style,o.status,
      o.requested_qty,o.filled_qty,o.fill_probability,o.reduce_only_intent,o.created_at,o.updated_at,
      o.cancellation_reason,o.plan
    FROM orders o
    LEFT JOIN run_health rh ON rh.run_id = o.run_id
    ORDER BY o.created_at,o.client_order_id`);
  const routeShadowResult = await pool.query<RouteShadowRow>(`
    WITH run_health AS (
      SELECT run_id,max(database_dropped_records) AS dropped_records
      FROM health_snapshots
      WHERE database_dropped_records IS NOT NULL
      GROUP BY run_id
    )
    SELECT e.run_id,rh.dropped_records,e.payload
    FROM system_events e
    LEFT JOIN run_health rh ON rh.run_id = e.run_id
    WHERE e.event_type = 'entryRouteShadowMark'
    ORDER BY e.occurred_at,e.id`);
  const orders = result.rows.flatMap(optimizationOrder);
  const routeShadows = routeShadowResult.rows.flatMap(optimizationRouteShadow);
  const minimumSamples = Math.max(...cfg.symbols.map((symbol) =>
    cfg.symbolConfigs[symbol]?.deterministicSignal.minimumEffectiveSampleCount ?? 0));
  const defaultShadowUnproductiveExitMs = Math.min(10 * 60_000, cfg.position.unproductiveExitMs - 1);
  const shadowUnproductiveExitMs = envPositiveInteger("OPTIMIZATION_SHADOW_UNPRODUCTIVE_EXIT_MS",
    defaultShadowUnproductiveExitMs);
  const maximumEconomicHorizonMs = Math.max(...cfg.symbols.flatMap((symbol) =>
    cfg.symbolConfigs[symbol]?.deterministicSignal.analyticHorizons.map((item) => item.horizonMs) ?? []));
  const routeShadowDecisionHorizonMs = envPositiveInteger("OPTIMIZATION_ROUTE_SHADOW_HORIZON_MS",
    maximumEconomicHorizonMs);
  const routeShadowMaximumMarkDelayMs = envNonNegativeInteger("OPTIMIZATION_ROUTE_SHADOW_MAX_DELAY_MS", 1_000);
  const report = analyzeTradeOptimization(orders, {
    minimumDurationMs: cfg.recall.minimumTuningDurationMs,
    minimumSamples,
    shadowUnproductiveExitMs,
    activeUnproductiveExitMs: cfg.position.unproductiveExitMs,
    routeShadowDecisionHorizonMs,
    routeShadowMaximumMarkDelayMs,
  }, routeShadows);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { await pool.end(); }

function optimizationOrder(row: OrderRow): OptimizationOrder[] {
  const plan = object(row.plan);
  const side = Number(row.side);
  const requestedQty = Number(row.requested_qty);
  const filledQty = Number(row.filled_qty);
  const createdMs = new Date(row.created_at).getTime();
  const updatedMs = new Date(row.updated_at).getTime();
  if ((side !== 1 && side !== -1) || !Number.isFinite(requestedQty) || !Number.isFinite(filledQty)
    || !Number.isFinite(createdMs) || !Number.isFinite(updatedMs)) return [];
  const rawProbability = row.fill_probability === null ? null : Number(row.fill_probability);
  return [{
    clientOrderId: row.client_order_id,
    runId: row.run_id,
    telemetryDroppedRecords: row.dropped_records === null ? null : Number(row.dropped_records),
    symbol: row.symbol,
    side,
    style: row.style,
    status: row.status,
    requestedQty,
    filledQty,
    fillProbability: rawProbability !== null && Number.isFinite(rawProbability) ? rawProbability : null,
    reduceOnlyIntent: row.reduce_only_intent,
    createdMs,
    updatedMs,
    entryFamily: text(plan.entryFamily),
    cancellationReason: row.cancellation_reason,
    exitReason: text(plan.exitReason),
    livePosition: livePosition(plan.livePosition),
  }];
}

function optimizationRouteShadow(row: RouteShadowRow): OptimizationRouteShadowMark[] {
  const payload = object(row.payload);
  const signalAtMs = Number(payload.signalAtMs);
  const horizonMs = Number(payload.horizonMs);
  const markDelayMs = Number(payload.markDelayMs);
  const side = Number(payload.side);
  const decisionId = text(payload.decisionId);
  const symbol = text(payload.symbol);
  const family = text(payload.family);
  if (decisionId === null || symbol === null || !Number.isFinite(signalAtMs)
    || family === null || (side !== 1 && side !== -1) || !Number.isInteger(horizonMs) || horizonMs <= 0
    || !Number.isFinite(markDelayMs) || markDelayMs < 0) return [];
  return [{
    runId: row.run_id,
    telemetryDroppedRecords: row.dropped_records === null ? null : finiteNumber(row.dropped_records),
    decisionId,
    symbol,
    side,
    family,
    configurationVersion: text(payload.configurationVersion),
    regime: text(payload.regime),
    regimePass: typeof payload.regimePass === "boolean" ? payload.regimePass : null,
    edgeSource: text(payload.edgeSource),
    edgeEffectiveSampleCount: nullableFiniteNumber(payload.edgeEffectiveSampleCount),
    economicHorizonMs: nullablePositiveInteger(payload.economicHorizonMs),
    signalAtMs,
    horizonMs,
    markDelayMs,
    makerAvailable: payload.makerAvailable === true,
    takerAvailable: payload.takerAvailable === true,
    makerFillFraction: nullableFiniteNumber(payload.makerFillFraction),
    makerNetBps: nullableFiniteNumber(payload.makerNetBps),
    takerNetBps: nullableFiniteNumber(payload.takerNetBps),
  }];
}

function livePosition(value: unknown): OptimizationLivePosition | null {
  const position = object(value);
  if (Object.keys(position).length === 0) return null;
  const openedMs = Number(position.openedMs);
  const closedAtMs = position.closedAtMs === null ? null : Number(position.closedAtMs);
  const realizedPnl = position.realizedPnl === null ? null : Number(position.realizedPnl);
  if (!Number.isFinite(openedMs) || (closedAtMs !== null && !Number.isFinite(closedAtMs))
    || (realizedPnl !== null && !Number.isFinite(realizedPnl))) return null;
  const pnlHistory = Array.isArray(position.pnlHistory) ? position.pnlHistory.flatMap(pnlPoint) : [];
  return { openedMs, closedAtMs, realizedPnl, entryOrderId: text(position.entryOrderId), pnlHistory };
}

function pnlPoint(value: unknown): DashboardPnlPoint[] {
  const point = object(value);
  const atMs = Number(point.atMs), currentPx = Number(point.currentPx), unrealizedPnl = Number(point.unrealizedPnl),
    unrealizedPnlBps = Number(point.unrealizedPnlBps), changePnl = point.changePnl === null ? null : Number(point.changePnl);
  if (![atMs, currentPx, unrealizedPnl, unrealizedPnlBps].every(Number.isFinite)
    || (changePnl !== null && !Number.isFinite(changePnl))) return [];
  const kind = point.kind === "mark" || point.kind === "close" ? point.kind : undefined;
  return [{ atMs, currentPx, unrealizedPnl, unrealizedPnlBps, changePnl, ...(kind === undefined ? {} : { kind }) }];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function finiteNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function nullableFiniteNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : finiteNumber(value);
}
function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}
function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function envNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
