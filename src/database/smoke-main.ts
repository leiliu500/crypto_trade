import { Pool } from "pg";
import { loadConfig } from "../config.js";
import type { DashboardEvent } from "../dashboard/types.js";
import { loadLocalEnv } from "../env.js";
import { PostgresTelemetryStore } from "./postgres-store.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const store = new PostgresTelemetryStore({ connectionString: cfg.databaseUrl, flushIntervalMs: 50, maximumQueue: 100 });
await store.start({ mode: "replay", paper: true, strategyVersion: cfg.strategyVersion, modelVersion: cfg.modelVersion,
  symbols: cfg.symbols, metadata: { purpose: "database-smoke-test" } });
const atMs = Date.now();
const event: DashboardEvent = { id: `smoke-${atMs}`, type: "databaseSmokeTest", severity: "info", atMs,
  symbol: null, clientOrderId: null, summary: "Asynchronous telemetry writer verified", payload: { synthetic: true } };
store.enqueue({ kind: "event", atMs, payload: event });
await store.flush();
await store.close();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000, application_name: "crypto-trade-smoke-verifier" });
try {
  const result = await pool.query<{ run_id: string; event_count: string }>(`SELECT r.id::text AS run_id, count(e.id)::text AS event_count
    FROM engine_runs r LEFT JOIN system_events e ON e.run_id = r.id
    WHERE r.metadata->>'purpose' = 'database-smoke-test'
    GROUP BY r.id, r.started_at ORDER BY r.started_at DESC LIMIT 1`);
  const row = result.rows[0];
  if (!row || Number(row.event_count) < 1) throw new Error("Database smoke event was not persisted");
  process.stdout.write(`${JSON.stringify({ status: "ok", runId: row.run_id, eventCount: Number(row.event_count) })}\n`);
} finally { await pool.end(); }
