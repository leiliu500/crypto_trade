import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import type {
  DashboardEvent, DashboardMarketCard, DashboardOrderCard, DashboardPositionCard, DashboardSnapshot,
  DatabaseHealth, TelemetryRecord,
} from "../dashboard/types.js";
import type { HistoricalFillRecord } from "../kraken/paper-history.js";
import type { Position } from "../strategy/position-manager.js";
import { runMigrations } from "./migrations.js";
import { CalibratedEdgeTable, type CalibratedEdgeBucket } from "../calibration/calibrated-edge-table.js";
import type { PolicyPositionSpec } from "../research/trading-policy.js";

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

export interface PersistedDecisionVenueLatency { atMs: number; milliseconds: number; }
export interface HistoricalBackfillResult { ordersInserted: number; fillsInserted: number; }

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
      const incomingPriority = telemetryPriority(record);
      let evictionIndex = -1;
      let evictionPriority = incomingPriority;
      for (let index = 0; index < this.queue.length; index += 1) {
        const priority = telemetryPriority(this.queue[index]!);
        if (priority >= evictionPriority) continue;
        evictionIndex = index;
        evictionPriority = priority;
        if (priority === 0) break;
      }
      if (evictionIndex >= 0) {
        this.queue.splice(evictionIndex, 1);
        this.droppedRecords += 1;
        this.lastError = `Telemetry queue full (${this.options.maximumQueue}); lower-priority record evicted`;
        this.status = "degraded";
        this.publishHealth();
      } else {
        this.droppedRecords += 1;
        this.lastError = `Telemetry queue full (${this.options.maximumQueue}); newest record dropped`;
        this.status = "degraded";
        this.publishHealth();
        return;
      }
    }
    this.queue.push(record);
    if (this.queue.length >= 250) void this.flush();
  }

  public health(): DatabaseHealth {
    return { connected: this.status === "connected", status: this.status, queuedRecords: this.queue.length,
      droppedRecords: this.droppedRecords, lastPersistedAtMs: this.lastPersistedAtMs, lastError: this.lastError };
  }

  public async loadOrders(sinceMs: number, untilMs: number): Promise<readonly DashboardOrderCard[]> {
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs < 0 || sinceMs >= untilMs) {
      throw new Error("Invalid order-history interval");
    }
    const result = await this.pool.query<PersistedOrderRow>(
      `SELECT client_order_id,status,cancel_request_reason,cancellation_reason,created_at,updated_at,plan
       FROM orders
       WHERE created_at >= $1 AND created_at < $2
       ORDER BY created_at DESC, updated_at DESC, client_order_id DESC`,
      [date(sinceMs), date(untilMs)],
    );
    return result.rows.flatMap((row) => {
      const restored = restoreOrder(row);
      return restored ? [restored] : [];
    });
  }

  /**
   * Idempotently restores simulator-owned history when PostgreSQL was cleared but
   * the durable paper account file survived. Unknown original run ids remain NULL.
   */
  public async backfillHistoricalOrders(orders: readonly DashboardOrderCard[], fills: readonly HistoricalFillRecord[]): Promise<HistoricalBackfillResult> {
    if (orders.length === 0 && fills.length === 0) return { ordersInserted: 0, fillsInserted: 0 };
    const client = await this.pool.connect();
    let ordersInserted = 0, fillsInserted = 0;
    try {
      await client.query("BEGIN");
      for (const order of orders) {
        const inserted = await client.query(`INSERT INTO orders
          (client_order_id,run_id,venue_order_id,symbol,side,style,time_in_force,status,cancel_request_reason,
           cancellation_reason,requested_qty,filled_qty,average_fill_price,limit_price,expected_value,
           fill_probability,reduce_only_intent,created_at,expires_at,updated_at,plan)
          VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
          ON CONFLICT (client_order_id) DO NOTHING`,
        [order.clientOrderId, order.venueOrderId, order.symbol, order.side, order.style, order.timeInForce,
          order.status, order.cancelRequestReason, order.cancellationReason, order.requestedQty, order.filledQty,
          order.averageFillPx || null, order.limitPx, order.expectedValue, order.fillProbability,
          order.reduceOnlyIntent, date(order.createdMs), date(order.expiresMs), date(order.updatedMs), json(order)]);
        ordersInserted += inserted.rowCount ?? 0;
        if ((inserted.rowCount ?? 0) === 0) {
          // A previous startup may already have restored the order before
          // position replay was available. Refresh only simulator-owned rows;
          // never overwrite normal telemetry associated with a real run.
          await client.query(`UPDATE orders SET plan=$2::jsonb
            WHERE client_order_id=$1 AND run_id IS NULL AND plan IS DISTINCT FROM $2::jsonb`,
          [order.clientOrderId, json(order)]);
        }
        await client.query(`INSERT INTO order_events
          (run_id,client_order_id,venue_order_id,event_type,status,cancellation_reason,event_qty,event_price,
           filled_qty,occurred_at,payload)
          SELECT NULL,$1,$2,'history_import',$3,$4,NULL,$5,$6,$7,$8::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM order_events WHERE client_order_id=$1 AND event_type='history_import'
          )`,
        [order.clientOrderId, order.venueOrderId, order.status, order.cancellationReason,
          order.averageFillPx || null, order.filledQty, date(order.updatedMs), json(order)]);
      }
      for (const fill of fills) {
        const inserted = await client.query(`INSERT INTO fills
          (execution_id,run_id,client_order_id,symbol,side,qty,price,final,occurred_at,payload)
          VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
          ON CONFLICT (execution_id) DO NOTHING`,
        [fill.id, fill.clientOrderId, fill.symbol, fill.side, fill.qty, fill.price, fill.final, date(fill.atMs), json(fill)]);
        fillsInserted += inserted.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { ordersInserted, fillsInserted };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  public async loadLatestPositionStates(symbols: readonly string[]): Promise<readonly Position[]> {
    if (symbols.length === 0) return [];
    const result = await this.pool.query<PersistedPositionStateRow>(
      `WITH event_positions AS (
         SELECT symbol,position,occurred_at AS observed_at,NULL::text AS round_trip_bps,
           NULL::text AS economic_horizon_ms,NULL::text AS execution_path,NULL::text AS entry_family
         FROM (
           SELECT DISTINCT ON (run_id,symbol) symbol,run_id,payload->'position' AS position,occurred_at
           FROM system_events
           WHERE event_type = 'positionDecision' AND symbol = ANY($1::text[])
             AND occurred_at >= now() - interval '1 day' AND payload ? 'position'
           ORDER BY run_id,symbol,occurred_at DESC,id DESC
         ) latest_run_positions
       ), snapshot_positions AS (
         SELECT p.symbol,p.payload AS position,p.updated_at AS observed_at,
           entry.round_trip_bps,entry.economic_horizon_ms,entry.execution_path,entry.entry_family
         FROM positions p
         LEFT JOIN LATERAL (
           SELECT o.plan#>>'{expectedCost,roundTripBps}' AS round_trip_bps,
             o.plan->>'economicHorizonMs' AS economic_horizon_ms,o.plan->>'executionPath' AS execution_path,
             o.plan->>'entryFamily' AS entry_family
           FROM orders o
           WHERE o.symbol = p.symbol AND o.status = 'FILLED' AND NOT o.reduce_only_intent
             AND o.side = COALESCE((p.payload->>'side')::smallint,p.side)
             AND abs(o.average_fill_price - COALESCE((p.payload->>'entryPx')::numeric,p.entry_price))
               <= greatest(.000000001,COALESCE((p.payload->>'entryPx')::numeric,p.entry_price) * .000001)
             AND abs(extract(epoch FROM (o.updated_at - COALESCE(
               to_timestamp((p.payload->>'openedMs')::double precision / 1000),p.opened_at)))) <= 300
           ORDER BY abs(extract(epoch FROM (o.updated_at - COALESCE(
             to_timestamp((p.payload->>'openedMs')::double precision / 1000),p.opened_at)))),o.updated_at DESC
           LIMIT 1
         ) entry ON true
         WHERE p.symbol = ANY($1::text[]) AND p.updated_at >= now() - interval '1 day'
       )
       SELECT DISTINCT ON (symbol) position,round_trip_bps,economic_horizon_ms,execution_path,entry_family,symbol,observed_at
       FROM (
         SELECT * FROM event_positions
         UNION ALL
         SELECT * FROM snapshot_positions
       ) candidates
       WHERE NOT EXISTS (
         SELECT 1 FROM positions closed
         WHERE closed.symbol = candidates.symbol AND closed.closed_at IS NOT NULL
           AND closed.closed_at >= candidates.observed_at
       )
       ORDER BY symbol,observed_at DESC`,
      [[...symbols]],
    );
    return result.rows.flatMap((row) => {
      const restored = restorePositionState(row.position, row);
      return restored ? [restored] : [];
    });
  }

  public async loadRealizedSessionPnl(sinceMs: number): Promise<number> {
    if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new Error("Invalid realized session P&L start time");
    const result = await this.pool.query<PersistedSessionPnlRow>(
      `SELECT COALESCE(sum(realized_pnl),0) AS realized_pnl FROM (
         SELECT DISTINCT ON (plan#>>'{livePosition,exitOrderId}')
           (plan#>>'{livePosition,realizedPnl}')::numeric AS realized_pnl
         FROM orders
         WHERE created_at >= $1 AND status = 'FILLED' AND plan->>'reduceOnlyIntent' = 'true'
           AND plan#>>'{livePosition,entryOrderId}' IS NOT NULL
           AND plan#>>'{livePosition,exitOrderId}' IS NOT NULL
           AND plan#>>'{livePosition,realizedPnl}' IS NOT NULL
         ORDER BY plan#>>'{livePosition,exitOrderId}',updated_at DESC,client_order_id DESC
       ) closed_trades`,
      [date(sinceMs)],
    );
    return number(result.rows[0]?.realized_pnl, 0);
  }

  public async loadDecisionVenueLatencies(sinceMs: number, untilMs: number): Promise<readonly PersistedDecisionVenueLatency[]> {
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
      throw new Error("Invalid decision-to-venue latency interval");
    }
    const result = await this.pool.query<PersistedDecisionVenueLatencyRow>(
      `SELECT occurred_at,payload#>>'{plan,createdMs}' AS decision_ms
       FROM system_events
       WHERE event_type = 'orderAccepted' AND occurred_at >= $1 AND occurred_at <= $2
         AND payload#>>'{plan,createdMs}' IS NOT NULL
       ORDER BY occurred_at,id`,
      [date(sinceMs), date(untilMs)],
    );
    return result.rows.flatMap((row) => {
      const atMs = new Date(row.occurred_at).getTime();
      const decisionMs = Number(row.decision_ms);
      const milliseconds = atMs - decisionMs;
      return Number.isFinite(atMs) && Number.isFinite(decisionMs) && Number.isFinite(milliseconds) && milliseconds >= 0
        ? [{ atMs, milliseconds }] : [];
    });
  }

  public async loadPromotedAlphaBuckets(configurationVersion: string): Promise<readonly CalibratedEdgeBucket[]> {
    const result = await this.pool.query<{ calibrated_bucket: unknown }>(
      `SELECT calibrated_bucket FROM alpha_calibrations
       WHERE configuration_version=$1 AND promoted=true AND calibrated_bucket IS NOT NULL
       ORDER BY cohort_key`, [configurationVersion]);
    const buckets = result.rows.map((row) => row.calibrated_bucket as CalibratedEdgeBucket);
    // Construction validates every identity field and numeric range before a
    // persisted research result can affect runtime order qualification.
    new CalibratedEdgeTable(buckets);
    return buckets;
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
    if (event.type === "entryRouteShadowStarted") await this.persistAlphaSignal(client, event.payload, runId, atMs);
    if (event.type === "entryRouteShadowMark") await this.persistAlphaMarkout(client, event.payload, runId, atMs);
    if (event.type === "policyObservation") {
      const value = object(event.payload);
      await client.query(
        `INSERT INTO policy_observations(id,run_id,configuration_version,policy_version,symbol,policy_id,signal_at,status,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,payload=EXCLUDED.payload
           WHERE policy_observations.status='PENDING'`,
        [value.id,runId,value.configurationVersion,value.policyVersion,value.symbol,value.policyId,
          date(number(value.signalAtMs,atMs)),value.status,json(value)]);
    }
  }

  private async persistAlphaSignal(client: PoolClient, payload: unknown, runId: string, atMs: number): Promise<void> {
    const value = object(payload);
    const decisionId = typeof value.decisionId === "string" ? value.decisionId : null;
    const symbol = typeof value.symbol === "string" ? value.symbol : null;
    const family = typeof value.family === "string" ? value.family : null;
    if (!decisionId || !symbol || !family) return;
    const makerPlan = object(value.makerPlan), takerPlan = object(value.takerPlan);
    const selectedPlan = value.selectedStyle === "taker" ? takerPlan
      : value.selectedStyle === "maker" ? makerPlan
        : Object.keys(makerPlan).length > 0 ? makerPlan : takerPlan;
    const predictedCostBps = nullableNumber(value.predictedCostBps ?? selectedPlan.roundTripCostBps);
    const predictedLowerBoundNetBps = nullableNumber(value.predictedLowerBoundNetBps
      ?? selectedPlan.conservativeNetEdgeBps);
    await client.query(
      `INSERT INTO alpha_signals
        (decision_id,run_id,configuration_version,strategy_version,symbol,strategy_class,family,side,regime,
         regime_pass,edge_source,edge_effective_sample_count,economic_horizon_ms,selected_style,signal_at,
         signal_bid,signal_ask,signal_spread_bps,signal_quality,predicted_gross_bps,
         predicted_lower_bound_net_bps,predicted_cost_bps,maker_plan,taker_plan,features,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25::jsonb,$26::jsonb)
       ON CONFLICT (decision_id) DO UPDATE SET
         run_id=EXCLUDED.run_id,signal_bid=COALESCE(EXCLUDED.signal_bid,alpha_signals.signal_bid),
         signal_ask=COALESCE(EXCLUDED.signal_ask,alpha_signals.signal_ask),
         signal_spread_bps=COALESCE(EXCLUDED.signal_spread_bps,alpha_signals.signal_spread_bps),
         signal_quality=COALESCE(EXCLUDED.signal_quality,alpha_signals.signal_quality),
         predicted_gross_bps=COALESCE(EXCLUDED.predicted_gross_bps,alpha_signals.predicted_gross_bps),
         predicted_lower_bound_net_bps=COALESCE(EXCLUDED.predicted_lower_bound_net_bps,alpha_signals.predicted_lower_bound_net_bps),
         predicted_cost_bps=COALESCE(EXCLUDED.predicted_cost_bps,alpha_signals.predicted_cost_bps),
         maker_plan=EXCLUDED.maker_plan,taker_plan=EXCLUDED.taker_plan,features=EXCLUDED.features,payload=EXCLUDED.payload`,
      [decisionId, runId, String(value.configurationVersion ?? "unknown"), String(value.strategyVersion ?? "unknown"),
        symbol, strategyClass(family), family, number(value.side, 0), String(value.regime ?? "UNKNOWN"),
        Boolean(value.regimePass), String(value.edgeSource ?? "UNRESOLVED"),
        number(value.edgeEffectiveSampleCount, 0), nullableNumber(value.economicHorizonMs ?? selectedPlan.economicHorizonMs),
        value.selectedStyle ?? null, date(number(value.signalAtMs, atMs)), nullableNumber(value.signalBid),
        nullableNumber(value.signalAsk), nullableNumber(value.signalSpreadBps), nullableNumber(value.signalQuality),
        nullableNumber(value.predictedGrossBps ?? (predictedLowerBoundNetBps !== null && predictedCostBps !== null
          ? predictedLowerBoundNetBps + predictedCostBps : null)),
        predictedLowerBoundNetBps, predictedCostBps, json(value.makerPlan), json(value.takerPlan),
        json(value.features), json(value)],
    );
  }

  private async persistAlphaMarkout(client: PoolClient, payload: unknown, runId: string, atMs: number): Promise<void> {
    const value = object(payload);
    const decisionId = typeof value.decisionId === "string" ? value.decisionId : null;
    const horizonMs = nullableNumber(value.horizonMs);
    if (!decisionId || horizonMs === null || horizonMs <= 0) return;
    await client.query(
      `INSERT INTO alpha_markouts
        (decision_id,horizon_ms,run_id,signal_at,marked_at,mark_delay_ms,signal_bid,signal_ask,mark_bid,mark_ask,
         maker_available,taker_available,maker_fill_probability,maker_filled_qty,maker_fill_fraction,
         maker_fill_latency_ms,maker_expired,maker_entry_price,taker_entry_price,maker_modeled_cost_bps,
         taker_modeled_cost_bps,maker_predicted_net_bps,taker_predicted_net_bps,maker_net_bps,taker_net_bps,
         maker_minus_taker_bps,missed_taker_alpha_bps,maker_executable_exit_price,taker_executable_exit_price,payload)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb
       WHERE EXISTS (SELECT 1 FROM alpha_signals WHERE decision_id=$1)
       ON CONFLICT (decision_id,horizon_ms) DO UPDATE SET
         run_id=EXCLUDED.run_id,marked_at=EXCLUDED.marked_at,mark_delay_ms=EXCLUDED.mark_delay_ms,
         signal_bid=COALESCE(EXCLUDED.signal_bid,alpha_markouts.signal_bid),
         signal_ask=COALESCE(EXCLUDED.signal_ask,alpha_markouts.signal_ask),
         mark_bid=COALESCE(EXCLUDED.mark_bid,alpha_markouts.mark_bid),
         mark_ask=COALESCE(EXCLUDED.mark_ask,alpha_markouts.mark_ask),
         maker_fill_probability=EXCLUDED.maker_fill_probability,maker_filled_qty=EXCLUDED.maker_filled_qty,
         maker_fill_fraction=EXCLUDED.maker_fill_fraction,maker_fill_latency_ms=EXCLUDED.maker_fill_latency_ms,
         maker_expired=EXCLUDED.maker_expired,maker_net_bps=EXCLUDED.maker_net_bps,
         taker_net_bps=EXCLUDED.taker_net_bps,maker_minus_taker_bps=EXCLUDED.maker_minus_taker_bps,
         missed_taker_alpha_bps=EXCLUDED.missed_taker_alpha_bps,payload=EXCLUDED.payload`,
      [decisionId, horizonMs, runId, date(number(value.signalAtMs, atMs - horizonMs)),
        date(number(value.markedAtMs, atMs)), number(value.markDelayMs, 0), nullableNumber(value.signalBid),
        nullableNumber(value.signalAsk), nullableNumber(value.markBid), nullableNumber(value.markAsk),
        Boolean(value.makerAvailable), Boolean(value.takerAvailable), nullableNumber(value.makerFillProbability),
        number(value.makerFilledQty, 0), nullableNumber(value.makerFillFraction), nullableNumber(value.makerFillLatencyMs),
        Boolean(value.makerExpired), nullableNumber(value.makerEntryPx), nullableNumber(value.takerEntryPx),
        nullableNumber(value.makerModeledCostBps), nullableNumber(value.takerModeledCostBps),
        nullableNumber(value.makerPredictedNetBps), nullableNumber(value.takerPredictedNetBps),
        nullableNumber(value.makerNetBps), nullableNumber(value.takerNetBps), nullableNumber(value.makerMinusTakerBps),
        nullableNumber(value.missedTakerAlphaBps), nullableNumber(value.makerExecutableExitPx),
        nullableNumber(value.takerExecutableExitPx), json(value)],
    );
  }

  private async persistHealth(client: PoolClient, snapshot: DashboardSnapshot, runId: string, atMs: number): Promise<void> {
    const live = new Map(snapshot.liveness.map((item) => [item.id, item.healthy]));
    await client.query("INSERT INTO health_snapshots (run_id,captured_at,overall_status,public_stream,private_stream,account_reconciled,book_valid,clock_valid,risk_recomputed,database_connected,database_queued_records,database_dropped_records,database_last_persisted_at,database_error,halt_reasons,equity,equity_high_water,uptime_ms,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)",
      [runId, date(atMs), snapshot.overall, live.get("public") ?? false, live.get("private") ?? false, live.get("account") ?? false,
        live.get("book") ?? false, live.get("clock") ?? false, live.get("risk") ?? false, snapshot.database.connected,
        snapshot.database.queuedRecords, snapshot.database.droppedRecords,
        snapshot.database.lastPersistedAtMs === null ? null : date(snapshot.database.lastPersistedAtMs), snapshot.database.lastError,
        [...snapshot.haltReasons], snapshot.equity, snapshot.equityHighWater, Math.floor(snapshot.uptimeMs), json(compactHealthSnapshot(snapshot))]);
  }

  private async persistOrder(client: PoolClient, order: DashboardOrderCard, runId: string): Promise<void> {
    await client.query(`INSERT INTO orders (client_order_id,run_id,venue_order_id,symbol,side,style,time_in_force,status,cancel_request_reason,cancellation_reason,requested_qty,filled_qty,average_fill_price,limit_price,expected_value,fill_probability,reduce_only_intent,created_at,expires_at,updated_at,plan)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT (client_order_id) DO UPDATE SET venue_order_id=EXCLUDED.venue_order_id,status=EXCLUDED.status,cancel_request_reason=EXCLUDED.cancel_request_reason,cancellation_reason=EXCLUDED.cancellation_reason,filled_qty=EXCLUDED.filled_qty,average_fill_price=EXCLUDED.average_fill_price,updated_at=EXCLUDED.updated_at,plan=EXCLUDED.plan`,
      [order.clientOrderId, runId, order.venueOrderId, order.symbol, order.side, order.style, order.timeInForce, order.status,
        order.cancelRequestReason, order.cancellationReason, order.requestedQty, order.filledQty, order.averageFillPx || null,
        order.limitPx, order.expectedValue, order.fillProbability, order.reduceOnlyIntent, date(order.createdMs), date(order.expiresMs),
        date(order.updatedMs), json(order)]);
    if (this.lastOrderStatus.get(order.clientOrderId) !== order.status) {
      await client.query("INSERT INTO order_events (run_id,client_order_id,venue_order_id,event_type,status,cancellation_reason,event_qty,event_price,filled_qty,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
        [runId, order.clientOrderId, order.venueOrderId, "state_change", order.status, order.cancellationReason, null,
          order.averageFillPx || null, order.filledQty, date(order.updatedMs), json(order)]);
      this.lastOrderStatus.set(order.clientOrderId, order.status);
    }
  }

  private async persistPosition(client: PoolClient, position: DashboardPositionCard, runId: string, atMs: number): Promise<void> {
    const closedAtMs = position.active ? null : position.closedAtMs ?? atMs;
    await client.query(`INSERT INTO positions (run_id,symbol,side,qty,entry_price,current_price,unrealized_pnl,phase,floor_price,stop_price,mfe,mae,opened_at,updated_at,closed_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (run_id,symbol) DO UPDATE SET side=EXCLUDED.side,qty=EXCLUDED.qty,entry_price=EXCLUDED.entry_price,
        current_price=EXCLUDED.current_price,unrealized_pnl=EXCLUDED.unrealized_pnl,phase=EXCLUDED.phase,
        floor_price=EXCLUDED.floor_price,stop_price=EXCLUDED.stop_price,mfe=EXCLUDED.mfe,mae=EXCLUDED.mae,
        opened_at=EXCLUDED.opened_at,updated_at=EXCLUDED.updated_at,closed_at=EXCLUDED.closed_at,payload=EXCLUDED.payload
      WHERE positions.opened_at <= EXCLUDED.opened_at`,
      [runId, position.symbol, position.side, position.qty, position.entryPx, position.currentPx, position.unrealizedPnl, position.phase,
        position.floorPx, position.stopPx, position.mfePx, position.maePx, date(position.openedMs), date(atMs),
        closedAtMs === null ? null : date(closedAtMs), json(position)]);
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
    const wrapper = object(payload); const event = object(wrapper.event); const nestedPlan = object(event.plan);
    const plan = nestedPlan;
    const intent = object(event.deterministicIntent ?? event.intent); const regime = object(event.regime); const decision = object(event.decision);
    const symbol = String(plan.cryptoSymbol ?? plan.symbol ?? object(event.position).symbol ?? event.cryptoSymbol ?? event.symbol ?? "unknown");
    const side = plan.side === "buy" ? 1 : plan.side === "sell" ? -1 : nullableNumber(plan.side ?? intent.side);
    await client.query("INSERT INTO decisions (decision_id,run_id,decision_type,symbol,side,regime,probability,predicted_gross_bps,lower_bound_net_bps,expected_cost_bps,action,reason,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT (decision_id) DO NOTHING",
      [String(plan.decisionId ?? intent.decisionId ?? event.decisionId ?? randomUUID()), runId, String(wrapper.type ?? "decision"), symbol, side,
        regime.name ?? regime.regime ?? null, nullableNumber(intent.probability), nullableNumber(intent.grossOpportunityBps ?? intent.predictedGrossBps), nullableNumber(intent.lowerBoundNetBps),
        nullableNumber(object(plan.expectedCost).roundTripBps), plan.purpose ?? decision.action ?? event.action ?? null,
        plan.reason ?? decision.reason ?? event.reason ?? null, date(atMs), json(wrapper)]);
  }

  private publishHealth(): void { this.emit("health", this.health()); }
}

export function compactHealthSnapshot(snapshot: DashboardSnapshot): Record<string, unknown> {
  return {
    version: snapshot.version,
    generatedAtMs: snapshot.generatedAtMs,
    mode: snapshot.mode,
    paper: snapshot.paper,
    paperEntryExercise: snapshot.paperEntryExercise ?? false,
    policyEngineEnabled: snapshot.policyEngineEnabled ?? false,
    policyModelsInstalled: snapshot.policyModelsInstalled ?? 0,
    strategyVersion: snapshot.strategyVersion,
    modelVersion: snapshot.modelVersion,
    configurationVersion: snapshot.configurationVersion,
    signalMode: snapshot.signalMode,
    started: snapshot.started,
    uptimeMs: snapshot.uptimeMs,
    overall: snapshot.overall,
    entriesAllowed: snapshot.entriesAllowed,
    haltReasons: [...snapshot.haltReasons],
    equity: snapshot.equity,
    equityHighWater: snapshot.equityHighWater,
    sessionStartingEquity: snapshot.sessionStartingEquity,
    sessionPnl: snapshot.sessionPnl,
    sessionRealizedPnl: snapshot.sessionRealizedPnl,
    sessionUnrealizedPnl: snapshot.sessionUnrealizedPnl,
    realizedSessionPnl: snapshot.realizedSessionPnl,
    realizedSessionBreakdown: snapshot.realizedSessionBreakdown,
    latencyP95Ms: snapshot.latencyP95Ms,
    liveness: snapshot.liveness,
    database: snapshot.database,
  };
}

function telemetryPriority(record: TelemetryRecord): number {
  if (record.kind === "fill") return 3;
  if (record.kind === "position" && object(record.payload).active === false) return 2;
  if (["order", "decision"].includes(record.kind)) return 2;
  if (record.kind === "event") {
    const eventType = object(record.payload).type;
    if (typeof eventType === "string" && ["entryRouteShadowStarted", "entryRouteShadowMark", "policyObservation"].includes(eventType)) return 2;
    return typeof eventType === "string" && ["fill", "orderAccepted", "orderUpdate", "orderRejected",
      "orderCancelRequested", "exitDecision", "engineError", "watchdogFault"].includes(eventType) ? 2 : 1;
  }
  return 0;
}

function date(ms: number): Date { return new Date(ms); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function number(value: unknown, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function json(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : typeof item === "number" && !Number.isFinite(item) ? null : item ?? null); }
function strategyClass(family: string): "trend" | "breakout" | "mean_reversion" {
  return family === "CONTINUATION" ? "trend" : family === "EARLY_BREAKOUT" ? "breakout" : "mean_reversion";
}

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

interface PersistedPositionStateRow {
  position: unknown;
  round_trip_bps: string | number | null;
  economic_horizon_ms: string | number | null;
  execution_path: string | null;
  entry_family: string | null;
}
interface PersistedSessionPnlRow { realized_pnl: string | number; }
interface PersistedDecisionVenueLatencyRow { occurred_at: Date | string; decision_ms: string | number; }

function restorePositionState(value: unknown, fallback?: Partial<PersistedPositionStateRow>): Position | null {
  const position = object(value);
  const symbol = typeof position.symbol === "string" ? position.symbol : "";
  const side = Number(position.side);
  const qty = Number(position.qty);
  const entryPx = Number(position.entryPx);
  const openedMs = Number(position.openedMs);
  const initialRiskPx = Number(position.initialRiskPx);
  const persistedRoundTripCostPx = Number(position.roundTripCostPx);
  const fallbackRoundTripBps = fallback?.round_trip_bps === null || fallback?.round_trip_bps === undefined
    ? Number.NaN : Number(fallback.round_trip_bps);
  const roundTripCostPx = Number.isFinite(persistedRoundTripCostPx) && persistedRoundTripCostPx >= 0
    ? persistedRoundTripCostPx : entryPx * fallbackRoundTripBps / 10_000;
  const mfePx = Number(position.mfePx);
  const maePx = Number(position.maePx);
  const floorPx = Number(position.floorPx);
  if (!symbol || ![side, qty, entryPx, openedMs, initialRiskPx, roundTripCostPx, mfePx, maePx, floorPx].every(Number.isFinite)
    || (side !== 1 && side !== -1) || qty <= 0 || entryPx <= 0 || openedMs <= 0 || initialRiskPx <= 0 || roundTripCostPx < 0) return null;
  const phase = ["OPEN", "RECOVERY", "PROTECTED", "TREND_HOLD", "EXITING"].includes(String(position.phase))
    ? position.phase as Position["phase"] : "OPEN";
  const selectedHorizonMs = Number(position.selectedHorizonMs ?? fallback?.economic_horizon_ms);
  const lastReductionProbability = Number(position.lastReductionProbability);
  const persistedExecutionPath = position.executionPath ?? fallback?.execution_path;
  const executionPath = typeof persistedExecutionPath === "string"
    && ["MAKER_MAKER", "MAKER_TAKER", "MAKER_MAKER_TAKER_FALLBACK", "TAKER_TAKER"].includes(persistedExecutionPath)
    ? persistedExecutionPath as NonNullable<Position["executionPath"]> : null;
  const persistedEntryFamily = position.entryFamily ?? fallback?.entry_family;
  const entryFamily = persistedEntryFamily === "CONTINUATION" || persistedEntryFamily === "PULLBACK_RECOVERY"
    || persistedEntryFamily === "EARLY_BREAKOUT"
    ? persistedEntryFamily : null;
  return {
    symbol, side, qty, entryPx, openedMs, initialRiskPx, roundTripCostPx, mfePx, maePx, floorPx,
    breakEvenArmed: Boolean(position.breakEvenArmed), phase,
    ...(entryFamily === null ? {} : { entryFamily }),
    // Preserve even unknown versions so PositionManager fails closed on them;
    // silently dropping the field would restore the incompatible legacy exits.
    ...(position.policy && typeof position.policy === "object" ? { policy: position.policy as PolicyPositionSpec } : {}),
    ...(Number.isFinite(selectedHorizonMs) && selectedHorizonMs > 0 ? { selectedHorizonMs } : {}),
    ...(executionPath === null ? {} : { executionPath }),
    ...(Number.isFinite(lastReductionProbability) ? { lastReductionProbability } : {}),
  };
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
