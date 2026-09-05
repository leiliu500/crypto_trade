import { Pool } from "pg";
import { EPISODE_VERSION, type EpisodeObservation } from "./execution-stress.js";
import type { PolicyObservation } from "./policy-collector.js";
import { POLICY_VERSION } from "./trading-policy.js";

/** Database-enforced read-only access; neither reports nor replay save models. */
export class EpisodeResearchStore {
  private readonly pool: Pool;
  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
      options: "-c default_transaction_read_only=on", application_name: "after-cost-research-read-only" });
    this.pool.on("error", () => undefined);
  }
  public async loadEpisodes(configurationVersion: string): Promise<EpisodeObservation[]> {
    return this.load(configurationVersion, EPISODE_VERSION, "EPISODE") as Promise<EpisodeObservation[]>;
  }
  public async loadEntries(configurationVersion: string): Promise<PolicyObservation[]> {
    return this.load(configurationVersion, POLICY_VERSION, "ENTRY");
  }
  private async load(configurationVersion: string, version: string, sampling: string): Promise<PolicyObservation[]> {
    const result = await this.pool.query<{ payload: PolicyObservation; clean: boolean }>(`
      WITH health AS (SELECT run_id,max(database_dropped_records) AS dropped FROM health_snapshots GROUP BY run_id)
      SELECT o.payload,COALESCE(h.dropped=0,false)
        AND COALESCE(r.metadata->>'paperEntryExercise','false') <> 'true' AS clean
      FROM policy_observations o LEFT JOIN health h ON h.run_id=o.run_id LEFT JOIN engine_runs r ON r.id=o.run_id
      WHERE o.configuration_version=$1 AND o.policy_version=$2 AND o.payload->>'sampling'=$3
        AND o.signal_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '14 days'
      ORDER BY o.signal_at,o.id`, [configurationVersion, version, sampling]);
    return result.rows.map(({ payload, clean }) => clean ? payload : { ...payload, status: "INVALID", reason: "UNCLEAN_TELEMETRY_RUN" });
  }
  public async close(): Promise<void> { await this.pool.end(); }
}
