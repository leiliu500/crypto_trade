import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { CROSS_ASSET_SYMBOLS } from "./cross-asset-model.js";

loadLocalEnv();
const args = process.argv.slice(2);
if (args.length > 1 || args.some((a) => !a.startsWith("--end="))) throw new Error("Use only --end=ISO_TIMESTAMP");
const endMs = args.length ? Date.parse(args[0]!.slice(6)) : Date.now();
if (!Number.isFinite(endMs) || endMs > Date.now()) throw new Error("Invalid historical cutoff");
const cfg = loadConfig(process.env, "replay");
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000, options: "-c default_transaction_read_only=on", application_name: "cross-asset-quote-export" });
try {
  const result = await pool.query(`WITH health AS (
      SELECT run_id,max(database_dropped_records) AS dropped FROM health_snapshots GROUP BY run_id)
    SELECT m.symbol,floor(extract(epoch FROM m.captured_at)*1000)::double precision AS "atMs",
      m.best_bid::double precision AS bid,m.best_ask::double precision AS ask,
      COALESCE(m.book_valid AND (m.features->>'stale')::boolean=false
        AND m.provider_age_ms BETWEEN 0 AND 2000 AND h.dropped=0
        AND COALESCE(r.metadata->>'paperEntryExercise','false') <> 'true',false) AS valid
    FROM market_snapshots m LEFT JOIN health h ON h.run_id=m.run_id LEFT JOIN engine_runs r ON r.id=m.run_id
    WHERE m.symbol=ANY($1::text[]) AND m.captured_at >= $2 AND m.captured_at < $3
    ORDER BY m.captured_at,m.id`, [[...CROSS_ASSET_SYMBOLS], new Date(endMs - 14 * 86_400_000), new Date(endMs)]);
  for (const row of result.rows) process.stdout.write(`${JSON.stringify(row)}\n`);
} finally { await pool.end(); }
