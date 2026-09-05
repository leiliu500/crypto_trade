import { Pool, type PoolClient } from "pg";
import { CalibratedEdgeTable, type CalibratedEdgeBucket } from "../calibration/calibrated-edge-table.js";
import type { Direction } from "../core/market.js";
import type { EntryFamily, ExecutionPath } from "../economics/types.js";
import type { RegimeName } from "../strategy/deterministic-regime.js";
import type { AlphaCohortEvaluation, AlphaResearchObservation, AlphaResearchReport } from "./alpha-research.js";

interface JoinedAlphaRow {
  decision_id: string;
  configuration_version: string;
  symbol: string;
  family: string;
  side: number;
  regime: string;
  signal_at: Date | string;
  signal_spread_bps: string | number | null;
  signal_quality: string | number | null;
  horizon_ms: string | number;
  maker_available: boolean;
  taker_available: boolean;
  maker_fill_probability: string | number | null;
  maker_fill_fraction: string | number | null;
  maker_expired: boolean;
  maker_net_bps: string | number | null;
  taker_net_bps: string | number | null;
  maker_execution_path: string | null;
  maker_modeled_cost_bps: string | number | null;
  taker_modeled_cost_bps: string | number | null;
  maker_predicted_net_bps: string | number | null;
  taker_predicted_net_bps: string | number | null;
}

interface BucketRow { calibrated_bucket: unknown }

export class AlphaResearchStore {
  private readonly pool: Pool;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000, application_name: "crypto-trade-alpha-research" });
  }

  public async loadObservations(configurationVersion?: string): Promise<AlphaResearchObservation[]> {
    const result = await this.pool.query<JoinedAlphaRow>(
      `SELECT s.decision_id,s.configuration_version,s.symbol,s.family,s.side,s.regime,s.signal_at,
         s.signal_spread_bps,s.signal_quality,m.horizon_ms,m.maker_available,m.taker_available,
         m.maker_fill_probability,m.maker_fill_fraction,m.maker_expired,m.maker_net_bps,m.taker_net_bps,
         s.maker_plan->>'executionPath' AS maker_execution_path,
         COALESCE(m.maker_modeled_cost_bps,(s.maker_plan->>'roundTripCostBps')::numeric) AS maker_modeled_cost_bps,
         COALESCE(m.taker_modeled_cost_bps,(s.taker_plan->>'roundTripCostBps')::numeric) AS taker_modeled_cost_bps,
         COALESCE(m.maker_predicted_net_bps,(s.maker_plan->>'conservativeNetEdgeBps')::numeric) AS maker_predicted_net_bps,
         COALESCE(m.taker_predicted_net_bps,(s.taker_plan->>'conservativeNetEdgeBps')::numeric) AS taker_predicted_net_bps
       FROM alpha_signals s JOIN alpha_markouts m ON m.decision_id=s.decision_id
       WHERE ($1::text IS NULL OR s.configuration_version=$1)
       ORDER BY s.signal_at,s.decision_id,m.horizon_ms`,
      [configurationVersion ?? null],
    );
    return result.rows.flatMap((row) => expandRoutes(row));
  }

  public async saveReport(report: AlphaResearchReport,
    evaluatedConfigurationVersions: readonly string[] = report.configurationVersions): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const versions = [...new Set(evaluatedConfigurationVersions.filter(Boolean))];
      if (versions.length > 0) {
        // A fresh run is authoritative for its exact configuration scope. This
        // prevents a cohort omitted by newer/invalid data from staying active.
        await client.query(
          `UPDATE alpha_calibrations SET promoted=false,calibrated_bucket=NULL,
             rejection_reasons=ARRAY['SUPERSEDED_BY_NEW_EVALUATION'],evaluated_at=$2
           WHERE configuration_version=ANY($1::text[])`,
          [versions, new Date(report.generatedAtMs)],
        );
      }
      for (const cohort of report.cohorts) await saveCohort(client, { ...cohort, promoted: false,
        calibratedBucket: null, rejectionReasons: [...cohort.rejectionReasons, "LEGACY_MARKOUT_DIAGNOSTIC_ONLY"] }, report.generatedAtMs);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadPromotedBuckets(configurationVersion: string): Promise<CalibratedEdgeBucket[]> {
    const result = await this.pool.query<BucketRow>(
      `SELECT calibrated_bucket FROM alpha_calibrations
       WHERE configuration_version=$1 AND promoted=true AND calibrated_bucket IS NOT NULL
       ORDER BY cohort_key`, [configurationVersion]);
    const buckets = result.rows.map((row) => row.calibrated_bucket as CalibratedEdgeBucket);
    new CalibratedEdgeTable(buckets);
    return buckets;
  }

  public async close(): Promise<void> { await this.pool.end(); }
}

function expandRoutes(row: JoinedAlphaRow): AlphaResearchObservation[] {
  const common = {
    decisionId: row.decision_id,
    configurationVersion: row.configuration_version,
    symbol: row.symbol,
    family: row.family as EntryFamily,
    side: row.side as Direction,
    regime: row.regime as RegimeName,
    horizonMs: numeric(row.horizon_ms, 0),
    signalAtMs: new Date(row.signal_at).getTime(),
    signalSpreadBps: nullable(row.signal_spread_bps),
    signalQuality: nullable(row.signal_quality),
  };
  const observations: AlphaResearchObservation[] = [];
  if (row.maker_available) {
    observations.push({ ...common,
      executionPath: validExecutionPath(row.maker_execution_path) ? row.maker_execution_path : "MAKER_MAKER_TAKER_FALLBACK",
      routeStyle: "maker", predictedNetBps: nullable(row.maker_predicted_net_bps),
      modeledCostBps: numeric(row.maker_modeled_cost_bps, 0),
      // An unfilled maker uses no capital and earns zero. This preserves the
      // complete route policy instead of conditioning returns on fills.
      realizedNetBps: nullable(row.maker_net_bps) ?? 0,
      makerFillProbability: nullable(row.maker_fill_probability),
      makerFilled: numeric(row.maker_fill_fraction, 0) > 0,
      makerFillOutcomeKnown: numeric(row.maker_fill_fraction, 0) > 0 || row.maker_expired,
    });
  }
  const takerNetBps = nullable(row.taker_net_bps);
  if (row.taker_available && takerNetBps !== null) {
    observations.push({ ...common, executionPath: "TAKER_TAKER", routeStyle: "taker",
      predictedNetBps: nullable(row.taker_predicted_net_bps), modeledCostBps: numeric(row.taker_modeled_cost_bps, 0),
      realizedNetBps: takerNetBps, makerFillProbability: null, makerFilled: null, makerFillOutcomeKnown: null });
  }
  return observations;
}

async function saveCohort(client: PoolClient, cohort: AlphaCohortEvaluation,
  evaluatedAtMs: number): Promise<void> {
  await client.query(
    `INSERT INTO alpha_calibrations
      (cohort_key,configuration_version,symbol,family,side,regime,execution_path,route_style,horizon_ms,
       independent_samples,out_of_sample_samples,coverage_ms,validation_folds,mean_out_of_sample_net_bps,
       lower_confidence_net_bps,predicted_realized_correlation,prediction_mae_bps,maker_fill_auc,promoted,
       rejection_reasons,calibrated_bucket,evaluated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)
     ON CONFLICT (cohort_key) DO UPDATE SET
       independent_samples=EXCLUDED.independent_samples,out_of_sample_samples=EXCLUDED.out_of_sample_samples,
       coverage_ms=EXCLUDED.coverage_ms,validation_folds=EXCLUDED.validation_folds,
       mean_out_of_sample_net_bps=EXCLUDED.mean_out_of_sample_net_bps,
       lower_confidence_net_bps=EXCLUDED.lower_confidence_net_bps,
       predicted_realized_correlation=EXCLUDED.predicted_realized_correlation,
       prediction_mae_bps=EXCLUDED.prediction_mae_bps,maker_fill_auc=EXCLUDED.maker_fill_auc,
       promoted=EXCLUDED.promoted,rejection_reasons=EXCLUDED.rejection_reasons,
       calibrated_bucket=EXCLUDED.calibrated_bucket,evaluated_at=EXCLUDED.evaluated_at`,
    [cohort.cohortKey, cohort.configurationVersion, cohort.symbol, cohort.family, cohort.side, cohort.regime,
      cohort.executionPath, cohort.routeStyle, cohort.horizonMs, cohort.independentSamples,
      cohort.outOfSampleSamples, cohort.coverageMs, cohort.validationFolds, cohort.meanOutOfSampleNetBps,
      cohort.lowerConfidenceNetBps, cohort.predictedRealizedCorrelation, cohort.predictionMaeBps,
      cohort.makerFillAuc, cohort.promoted, [...cohort.rejectionReasons],
      JSON.stringify(cohort.calibratedBucket), new Date(evaluatedAtMs)],
  );
}

function numeric(value: string | number | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function nullable(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function validExecutionPath(value: string | null): value is ExecutionPath {
  return value !== null && ["MAKER_MAKER", "MAKER_TAKER", "MAKER_MAKER_TAKER_FALLBACK", "TAKER_TAKER"].includes(value);
}
