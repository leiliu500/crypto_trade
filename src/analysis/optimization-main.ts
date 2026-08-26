import { Pool } from "pg";
import { loadConfig } from "../config.js";
import type { DashboardPnlPoint } from "../dashboard/types.js";
import { loadLocalEnv } from "../env.js";
import { analyzeTradeOptimization, type OptimizationLivePosition, type OptimizationOrder } from "./trade-optimization.js";

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
  const orders = result.rows.flatMap(optimizationOrder);
  const minimumSamples = Math.max(...cfg.symbols.map((symbol) =>
    cfg.symbolConfigs[symbol]?.deterministicSignal.minimumEffectiveSampleCount ?? 0));
  const shadowUnproductiveExitMs = envPositiveInteger("OPTIMIZATION_SHADOW_UNPRODUCTIVE_EXIT_MS", 15 * 60_000);
  const report = analyzeTradeOptimization(orders, {
    minimumDurationMs: cfg.recall.minimumTuningDurationMs,
    minimumSamples,
    shadowUnproductiveExitMs,
    activeUnproductiveExitMs: cfg.position.unproductiveExitMs,
  });
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
function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
