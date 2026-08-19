import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { runMigrations } from "./migrations.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000, application_name: "crypto-trade-migrator" });
try {
  const applied = await runMigrations(pool);
  process.stdout.write(`${JSON.stringify({ status: "ok", applied, message: applied.length ? "Database migrations applied" : "Database schema already current" })}\n`);
} finally { await pool.end(); }
