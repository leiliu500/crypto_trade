import { Pool } from "pg";
import type { PolicyObservation } from "./policy-collector.js";
import { evaluatePolicies, type PolicyReport } from "./policy-validation.js";
import { POLICY_VERSION } from "./trading-policy.js";

export class PolicyStore {
  private readonly pool: Pool;
  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000, statement_timeout: 30_000, application_name: "crypto-policy-research" });
    // Transient idle-connection failures are handled by the next refresh, not
    // an unhandled EventEmitter error that could terminate the trading engine.
    this.pool.on("error", () => undefined);
  }
  public async evaluate(configurationVersion: string, persist = true): Promise<PolicyReport> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize refreshes so an older concurrent evaluation cannot replace a newer one.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`policy:${configurationVersion}`]);
      const result = await client.query<{ payload: PolicyObservation; clean: boolean }>(
        `WITH run_health AS (
           SELECT run_id,max(database_dropped_records) AS dropped FROM health_snapshots GROUP BY run_id
         )
         SELECT o.payload,COALESCE(h.dropped=0,false)
           AND COALESCE(r.metadata->>'paperEntryExercise','false') <> 'true' AS clean
         FROM policy_observations o LEFT JOIN run_health h ON h.run_id=o.run_id
         LEFT JOIN engine_runs r ON r.id=o.run_id
         WHERE o.configuration_version=$1 AND o.policy_version=$2 ORDER BY o.signal_at,o.id`,
        [configurationVersion, POLICY_VERSION]);
      const rows = result.rows.map(({ payload, clean }) => clean ? payload
        : { ...payload, status: "INVALID" as const, reason: "UNCLEAN_TELEMETRY_RUN" });
      const report = evaluatePolicies(rows, configurationVersion);
      if (persist) {
        await client.query("INSERT INTO policy_evaluations(configuration_version,policy_version,evaluated_at,report) VALUES ($1,$2,$3,$4::jsonb)",
          [configurationVersion, POLICY_VERSION, new Date(report.generatedAtMs), JSON.stringify(report)]);
        await client.query("DELETE FROM policy_models WHERE configuration_version=$1 AND policy_version=$2", [configurationVersion, POLICY_VERSION]);
        for (const model of report.models) await client.query(
          "INSERT INTO policy_models(model_key,configuration_version,policy_version,evaluated_at,expires_at,model) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [model.key, configurationVersion, POLICY_VERSION, new Date(report.generatedAtMs), new Date(model.expiresAtMs), JSON.stringify(model)]);
      }
      await client.query("COMMIT");
      return report;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  public async close(): Promise<void> { await this.pool.end(); }
}
