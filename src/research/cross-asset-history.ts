import { Pool } from "pg";
import { CROSS_ASSET_SYMBOLS, type CrossAssetQuote } from "./cross-asset-model.js";

export const CROSS_ASSET_HISTORY_LOOKBACK_MS = 48 * 3_600_000;

/** Bounded read-only stream. Invalid records remain in chronological order so
 * quote gaps, bad books and unclean runs cannot disappear from training. */
export async function* readCrossAssetHistory(connectionString: string, cutoffMs: number): AsyncGenerator<CrossAssetQuote> {
  if (!Number.isFinite(cutoffMs) || cutoffMs > Date.now()) throw new Error("INVALID_HISTORY_CUTOFF");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000, options: "-c default_transaction_read_only=on", application_name: "cross-asset-startup-history" });
  pool.on("error", () => undefined);
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(`DECLARE cross_asset_history NO SCROLL CURSOR FOR
      WITH health AS (
        SELECT run_id,max(database_dropped_records) AS dropped FROM health_snapshots
        WHERE captured_at < $3 GROUP BY run_id)
      SELECT m.symbol,floor(extract(epoch FROM m.captured_at)*1000)::double precision AS "atMs",
        m.best_bid::double precision AS bid,m.best_ask::double precision AS ask,
        COALESCE(m.book_valid AND m.features->>'stale'='false'
          AND m.provider_age_ms BETWEEN 0 AND 2000 AND h.dropped=0
          AND r.metadata->>'venue'='kraken_futures' AND r.mode IN ('paper','shadow','record')
          AND COALESCE(r.metadata->>'paperEntryExercise','false') <> 'true',false) AS valid
      FROM market_snapshots m LEFT JOIN health h ON h.run_id=m.run_id LEFT JOIN engine_runs r ON r.id=m.run_id
      WHERE m.symbol=ANY($1::text[]) AND m.captured_at >= $2 AND m.captured_at < $3
      ORDER BY m.captured_at,m.id`, [[...CROSS_ASSET_SYMBOLS], new Date(cutoffMs - CROSS_ASSET_HISTORY_LOOKBACK_MS), new Date(cutoffMs)]);
    let count = 0;
    const startedMs = Date.now();
    while (true) {
      const batch = await client.query<CrossAssetQuote>("FETCH FORWARD 10000 FROM cross_asset_history");
      if (!batch.rows.length) break;
      count += batch.rows.length;
      if (count > 1_000_000 || Date.now() - startedMs > 60_000) throw new Error("HISTORY_WARMUP_LIMIT_EXCEEDED");
      for (const row of batch.rows) yield row;
    }
  } finally {
    // ROLLBACK also closes the read-only cursor on early termination or error.
    if (client) { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
    await pool.end();
  }
}
