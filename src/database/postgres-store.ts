import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import type { DashboardEvent, DashboardMarketCard, DashboardOrderCard, DashboardPositionCard, DashboardSnapshot, DatabaseHealth, TelemetryRecord } from "../dashboard/types.js";
import { runMigrations } from "./migrations.js";

export interface PostgresStoreOptions {
  connectionString: string;
  flushIntervalMs: number;
  maximumQueue: number;
}

export interface EngineRunMetadata {
  mode: string;
  paper: boolean;
  strategyVersion: string;
  modelVersion: string;
  symbols: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface PersistedMarketMid {
  symbol: string;
  atMs: number;
  mid: number;
}

/** Bounded, batched writer: enqueue never performs network I/O on strategy callbacks. */
export class PostgresTelemetryStore extends EventEmitter {
  private readonly pool: Pool;
  private readonly queue: TelemetryRecord[] = [];
  private timer?: NodeJS.Timeout;
  private runId: string | null = null;
  private droppedRecords = 0;
  private lastPersistedAtMs: number | null = null;
  private lastError: string | null = null;
  private status: DatabaseHealth["status"] = "connecting";
  private activeFlush: Promise<void> | null = null;
  private closing = false;
  private readonly lastOrderStatus = new Map<string, string>();

  public constructor(private readonly options: PostgresStoreOptions) {
    super();
    this.pool = new Pool({ connectionString: options.connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: "crypto-trade-engine" });
    this.pool.on("error", (error) => { this.lastError = error.message; this.status = "degraded"; this.publishHealth(); });
  }

  public async start(metadata: EngineRunMetadata): Promise<readonly string[]> {
    this.status = "connecting"; this.publishHealth();
    const migrations = await runMigrations(this.pool);
    this.runId = randomUUID();
    await this.pool.query(
      "INSERT INTO engine_runs (id, mode, paper, strategy_version, model_version, symbols, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [this.runId, metadata.mode, metadata.paper, metadata.strategyVersion, metadata.modelVersion, [...metadata.symbols], json(metadata.metadata ?? {})],
    );
    this.status = "connected";
    this.lastError = null;
    this.timer = setInterval(() => { void this.flush(); }, this.options.flushIntervalMs);
    this.timer.unref();
    this.publishHealth();
    return migrations;
  }

  public enqueue(record: TelemetryRecord): void {
    if (this.closing) return;
    if (this.queue.length >= this.options.maximumQueue) {
      this.droppedRecords += 1;
      this.lastError = `Telemetry queue full (${this.options.maximumQueue}); newest record dropped`;
      this.status = "degraded";
      this.publishHealth();
      return;
    }
    this.queue.push(record);
    if (this.queue.length >= 250) void this.flush();
  }

  public health(): DatabaseHealth {
    return { connected: this.status === "connected", status: this.status, queuedRecords: this.queue.length,
      droppedRecords: this.droppedRecords, lastPersistedAtMs: this.lastPersistedAtMs, lastError: this.lastError };
  }

  public async loadOrders(): Promise<readonly DashboardOrderCard[]> {
    const result = await this.pool.query<PersistedOrderRow>(
      "SELECT client_order_id,status,cancel_request_reason,cancellation_reason,created_at,updated_at,plan FROM orders ORDER BY created_at DESC, updated_at DESC, client_order_id DESC",
    );
    return result.rows.flatMap((row) => {
      const restored = restoreOrder(row);
      return restored ? [restored] : [];
    });
  }

  public async loadRecentMarketMids(symbols: readonly string[], sinceMs: number, untilMs: number): Promise<readonly PersistedMarketMid[]> {
    if (symbols.length === 0) return [];
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
      throw new Error("Invalid persisted market-history interval");
    }
    const result = await this.pool.query<PersistedMarketMidRow>(
      `SELECT symbol,captured_at,mid
       FROM market_snapshots
       WHERE symbol = ANY($1::text[]) AND captured_at >= $2 AND captured_at <= $3 AND mid > 0
       ORDER BY symbol,captured_at,id`,
      [[...symbols], date(sinceMs), date(untilMs)],
    );
    return result.rows.flatMap((row) => {
      const atMs = new Date(row.captured_at).getTime();
      const mid = Number(row.mid);
      return Number.isFinite(atMs) && Number.isFinite(mid) && mid > 0
        ? [{ symbol: row.symbol, atMs, mid }] : [];
    });
  }

  public async flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (!this.runId || this.queue.length === 0) return;
    const task = this.flushBatch();
    this.activeFlush = task;
    try { await task; } finally { this.activeFlush = null; }
  }

  public async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    delete this.timer;
    if (this.activeFlush) await this.activeFlush;
    const maximumAttempts = Math.ceil(this.options.maximumQueue / 500) + 1;
    for (let attempt = 0; this.queue.length > 0 && attempt < maximumAttempts; attempt += 1) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length >= before) break;
    }
    if (this.queue.length > 0) { this.droppedRecords += this.queue.length; this.queue.length = 0; }
    if (this.runId) await this.pool.query("UPDATE engine_runs SET stopped_at = now() WHERE id = $1", [this.runId]);
    await this.pool.end();
    this.status = "disabled";
    this.publishHealth();
  }

  private async flushBatch(): Promise<void> {
    const batch = this.queue.splice(0, Math.min(500, this.queue.length));
    if (batch.length === 0 || !this.runId) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of batch) await this.persist(client, record, this.runId);
      await client.query("COMMIT");
      this.lastPersistedAtMs = Date.now();
      this.lastError = null;
      this.status = "connected";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.lastOrderStatus.clear();
      const capacity = Math.max(0, this.options.maximumQueue - this.queue.length);
      const recoverable = batch.slice(0, capacity);
      this.queue.unshift(...recoverable);
      this.droppedRecords += batch.length - recoverable.length;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.status = "degraded";
    } finally {
      client.release();
      this.publishHealth();
    }
  }

  private async persist(client: PoolClient, record: TelemetryRecord, runId: string): Promise<void> {
    if (record.kind === "event") return this.persistEvent(client, record.payload as DashboardEvent, runId, record.atMs);
    if (record.kind === "health") return this.persistHealth(client, record.payload as DashboardSnapshot, runId, record.atMs);
    if (record.kind === "order") return this.persistOrder(client, record.payload as DashboardOrderCard, runId);
    if (record.kind === "position") return this.persistPosition(client, record.payload as DashboardPositionCard, runId, record.atMs);
    if (record.kind === "market") return this.persistMarket(client, record.payload as DashboardMarketCard, runId, record.atMs);
    if (record.kind === "fill") return this.persistFill(client, record.payload, runId, record.atMs);
    if (record.kind === "decision") return this.persistDecision(client, record.payload, runId, record.atMs);
  }

  private async persistEvent(client: PoolClient, event: DashboardEvent, runId: string, atMs: number): Promise<void> {
    await client.query("INSERT INTO system_events (run_id,event_type,severity,symbol,client_order_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [runId, event.type, event.severity, event.symbol, event.clientOrderId, date(atMs), json(event.payload)]);
  }

  private async persistHealth(client: PoolClient, snapshot: DashboardSnapshot, runId: string, atMs: number): Promise<void> {
    const live = new Map(snapshot.liveness.map((item) => [item.id, item.healthy]));
    await client.query("INSERT INTO health_snapshots (run_id,captured_at,overall_status,public_stream,private_stream,account_reconciled,book_valid,clock_valid,risk_recomputed,database_connected,halt_reasons,equity,equity_high_water,uptime_ms,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)",
      [runId, date(atMs), snapshot.overall, live.get("public") ?? false, live.get("private") ?? false, live.get("account") ?? false,
        live.get("book") ?? false, live.get("clock") ?? false, live.get("risk") ?? false, snapshot.database.connected,
        [...snapshot.haltReasons], snapshot.equity, snapshot.equityHighWater, Math.floor(snapshot.uptimeMs), json(snapshot)]);
  }

  private async persistOrder(client: PoolClient, order: DashboardOrderCard, runId: string): Promise<void> {
    await client.query(`INSERT INTO orders (client_order_id,run_id,alpaca_order_id,symbol,side,style,time_in_force,status,cancel_request_reason,cancellation_reason,requested_qty,filled_qty,average_fill_price,limit_price,expected_value,fill_probability,reduce_only_intent,created_at,expires_at,updated_at,plan)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT (client_order_id) DO UPDATE SET alpaca_order_id=EXCLUDED.alpaca_order_id,status=EXCLUDED.status,cancel_request_reason=EXCLUDED.cancel_request_reason,cancellation_reason=EXCLUDED.cancellation_reason,filled_qty=EXCLUDED.filled_qty,average_fill_price=EXCLUDED.average_fill_price,updated_at=EXCLUDED.updated_at,plan=EXCLUDED.plan`,
      [order.clientOrderId, runId, order.alpacaOrderId, order.symbol, order.side, order.style, order.timeInForce, order.status,
        order.cancelRequestReason, order.cancellationReason, order.requestedQty, order.filledQty, order.averageFillPx || null,
        order.limitPx, order.expectedValue, order.fillProbability, order.reduceOnlyIntent, date(order.createdMs), date(order.expiresMs),
        date(order.updatedMs), json(order)]);
    if (this.lastOrderStatus.get(order.clientOrderId) !== order.status) {
      await client.query("INSERT INTO order_events (run_id,client_order_id,alpaca_order_id,event_type,status,cancellation_reason,event_qty,event_price,filled_qty,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
        [runId, order.clientOrderId, order.alpacaOrderId, "state_change", order.status, order.cancellationReason, null,
          order.averageFillPx || null, order.filledQty, date(order.updatedMs), json(order)]);
      this.lastOrderStatus.set(order.clientOrderId, order.status);
    }
  }

  private async persistPosition(client: PoolClient, position: DashboardPositionCard, runId: string, atMs: number): Promise<void> {
    await client.query(`INSERT INTO positions (run_id,symbol,side,qty,entry_price,current_price,unrealized_pnl,phase,floor_price,stop_price,mfe,mae,opened_at,updated_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (run_id,symbol) DO UPDATE SET qty=EXCLUDED.qty,current_price=EXCLUDED.current_price,unrealized_pnl=EXCLUDED.unrealized_pnl,phase=EXCLUDED.phase,floor_price=EXCLUDED.floor_price,stop_price=EXCLUDED.stop_price,mfe=EXCLUDED.mfe,mae=EXCLUDED.mae,updated_at=EXCLUDED.updated_at,payload=EXCLUDED.payload`,
      [runId, position.symbol, position.side, position.qty, position.entryPx, position.currentPx, position.unrealizedPnl, position.phase,
        position.floorPx, position.stopPx, position.mfePx, position.maePx, date(position.openedMs), date(atMs), json(position)]);
    await client.query("INSERT INTO position_events (run_id,symbol,action,reason,qty,current_price,floor_price,hold_edge_bps,reversal_probability,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      [runId, position.symbol, position.latestAction, position.latestReason, position.qty, position.currentPx, position.floorPx,
        position.holdEdgeBps, position.reversalProbability, date(atMs), json(position)]);
  }

  private async persistMarket(client: PoolClient, market: DashboardMarketCard, runId: string, atMs: number): Promise<void> {
    await client.query("INSERT INTO market_snapshots (run_id,symbol,captured_at,mid,best_bid,best_ask,spread_bps,sigma_h_bps,provider_age_ms,regime,book_valid,features) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
      [runId, market.symbol, date(atMs), market.mid, market.bestBid, market.bestAsk, market.spreadBps, market.sigmaHBps,
        market.providerAgeMs, market.regime, market.bookValid, json(market)]);
  }

  private async persistFill(client: PoolClient, payload: unknown, runId: string, atMs: number): Promise<void> {
    const value = object(payload);
    await client.query("INSERT INTO fills (execution_id,run_id,client_order_id,symbol,side,qty,price,final,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (execution_id) DO NOTHING",
      [String(value.id ?? randomUUID()), runId, String(value.clientOrderId ?? "unknown"), String(value.symbol ?? "unknown"), number(value.side, 1),
        number(value.qty, 0), number(value.price, 0), Boolean(value.final), date(atMs), json(value)]);
  }

  private async persistDecision(client: PoolClient, payload: unknown, runId: string, atMs: number): Promise<void> {
    const wrapper = object(payload); const event = object(wrapper.event); const plan = object(event.plan);
    const intent = object(event.deterministicIntent ?? event.intent); const regime = object(event.regime); const decision = object(event.decision);
    const symbol = String(plan.symbol ?? object(event.position).symbol ?? event.symbol ?? "unknown");
    await client.query("INSERT INTO decisions (decision_id,run_id,decision_type,symbol,side,regime,probability,predicted_gross_bps,lower_bound_net_bps,expected_cost_bps,action,reason,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT (decision_id) DO NOTHING",
      [String(plan.decisionId ?? intent.decisionId ?? event.decisionId ?? randomUUID()), runId, String(wrapper.type ?? "decision"), symbol, nullableNumber(plan.side ?? intent.side),
        regime.name ?? regime.regime ?? null, nullableNumber(intent.probability), nullableNumber(intent.grossOpportunityBps ?? intent.predictedGrossBps), nullableNumber(intent.lowerBoundNetBps),
        nullableNumber(object(plan.expectedCost).roundTripBps), decision.action ?? event.action ?? null, decision.reason ?? event.reason ?? null, date(atMs), json(wrapper)]);
  }

  private publishHealth(): void { this.emit("health", this.health()); }
}

function date(ms: number): Date { return new Date(ms); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function number(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function nullableNumber(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function json(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : typeof item === "number" && !Number.isFinite(item) ? null : item ?? null); }

interface PersistedOrderRow {
  client_order_id: string;
  status: string;
  cancel_request_reason: string | null;
  cancellation_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  plan: unknown;
}

interface PersistedMarketMidRow {
  symbol: string;
  captured_at: Date | string;
  mid: string | number;
}

function restoreOrder(row: PersistedOrderRow): DashboardOrderCard | null {
  const payload = object(row.plan);
  const clientOrderId = String(payload.clientOrderId ?? row.client_order_id ?? "");
  const symbol = String(payload.symbol ?? "");
  if (!clientOrderId || !symbol) return null;
  const status = String(row.status || payload.status || "UNKNOWN");
  const cancelRequestReason = nullableText(row.cancel_request_reason ?? payload.cancelRequestReason) as DashboardOrderCard["cancelRequestReason"];
  const cancellationReason = nullableText(row.cancellation_reason ?? payload.cancellationReason) as DashboardOrderCard["cancellationReason"];
  return {
    ...(payload as unknown as DashboardOrderCard),
    clientOrderId,
    historical: true,
    symbol,
    status,
    statusLabel: String(payload.statusLabel ?? restoredStatusLabel(status, cancellationReason ?? cancelRequestReason)),
    terminal: Boolean(payload.terminal ?? ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(status)),
    createdMs: milliseconds(payload.createdMs, row.created_at),
    updatedMs: milliseconds(payload.updatedMs, row.updated_at),
    cancelRequestReason,
    cancellationReason,
    timeline: Array.isArray(payload.timeline) ? payload.timeline as DashboardOrderCard["timeline"] : [],
    livePosition: payload.livePosition && typeof payload.livePosition === "object"
      ? payload.livePosition as DashboardOrderCard["livePosition"] : null,
  };
}

function nullableText(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function milliseconds(value: unknown, fallback: Date | string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(fallback).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function restoredStatusLabel(status: string, cancellationReason: string | null): string {
  const value = status === "CANCELED" && cancellationReason ? cancellationReason : status;
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
