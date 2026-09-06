import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { auditModelTrades, type ModelAuditOrder } from "./model-trade-audit.js";

loadLocalEnv();
if (process.argv.length > 2) throw new Error("This report takes no options; it audits the configured version at a fixed cutoff");
const cfg = loadConfig(process.env, "replay"), cutoffMs = Date.now();
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000, options: "-c default_transaction_read_only=on", application_name: "model-trade-audit" });
try {
  const result = await pool.query<{ plan: ModelAuditOrder }>(`
    WITH health AS (SELECT run_id,max(database_dropped_records) AS dropped
      FROM health_snapshots WHERE captured_at <= $2 GROUP BY run_id),
    entries AS (SELECT client_order_id FROM orders
      WHERE NOT reduce_only_intent AND plan->>'configurationVersion'=$1)
    SELECT o.plan || jsonb_build_object('telemetryDroppedRecords',h.dropped,
      'clientOrderId',o.client_order_id,'symbol',o.symbol,'side',o.side,
      'filledQty',o.filled_qty,'averageFillPx',o.average_fill_price,'reduceOnlyIntent',o.reduce_only_intent,
      'createdMs',extract(epoch FROM o.created_at)*1000,'updatedMs',extract(epoch FROM o.updated_at)*1000) AS plan
    FROM orders o LEFT JOIN health h ON h.run_id=o.run_id
    WHERE o.created_at <= $2 AND (o.client_order_id IN (SELECT client_order_id FROM entries)
      OR o.plan#>>'{livePosition,entryOrderId}' IN (SELECT client_order_id FROM entries))
    ORDER BY o.created_at,o.client_order_id`, [cfg.configurationVersion, new Date(cutoffMs)]);
  process.stdout.write(`${JSON.stringify(auditModelTrades(result.rows.map(r => r.plan), cfg.configurationVersion, cutoffMs), null, 2)}\n`);
} finally { await pool.end(); }
