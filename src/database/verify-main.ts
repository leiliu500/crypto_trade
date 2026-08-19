import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000, application_name: "crypto-trade-verifier" });
try {
  const version = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY applied_at");
  const tables = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  const runCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM engine_runs");
  const recordTables = ["system_events", "health_snapshots", "orders", "order_events", "fills", "positions", "position_events", "decisions", "market_snapshots"] as const;
  const counts = await Promise.all(recordTables.map(async (table) => Number((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]?.count ?? 0)));
  const recordCounts = Object.fromEntries(recordTables.map((table, index) => [table, counts[index]]));
  process.stdout.write(`${JSON.stringify({ status: "ok", migrations: version.rows.map((row) => row.version), tables: tables.rows.map((row) => row.table_name), engineRuns: Number(runCount.rows[0]?.count ?? 0), recordCounts }, null, 2)}\n`);
} finally { await pool.end(); }
