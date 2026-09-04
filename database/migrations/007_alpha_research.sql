BEGIN;

CREATE TABLE IF NOT EXISTS alpha_signals (
  decision_id text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  configuration_version text NOT NULL,
  strategy_version text NOT NULL,
  symbol text NOT NULL,
  strategy_class text NOT NULL CHECK (strategy_class IN ('trend', 'breakout', 'mean_reversion')),
  family text NOT NULL,
  side smallint NOT NULL CHECK (side IN (-1, 1)),
  regime text NOT NULL,
  regime_pass boolean NOT NULL,
  edge_source text NOT NULL,
  edge_effective_sample_count numeric(20, 4) NOT NULL DEFAULT 0,
  economic_horizon_ms bigint,
  selected_style text,
  signal_at timestamptz NOT NULL,
  signal_bid numeric(30, 12),
  signal_ask numeric(30, 12),
  signal_spread_bps numeric(20, 10),
  signal_quality numeric(20, 12),
  predicted_gross_bps numeric(20, 10),
  predicted_lower_bound_net_bps numeric(20, 10),
  predicted_cost_bps numeric(20, 10),
  maker_plan jsonb,
  taker_plan jsonb,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS alpha_markouts (
  decision_id text NOT NULL REFERENCES alpha_signals(decision_id) ON DELETE CASCADE,
  horizon_ms bigint NOT NULL,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  signal_at timestamptz NOT NULL,
  marked_at timestamptz NOT NULL,
  mark_delay_ms bigint NOT NULL DEFAULT 0,
  signal_bid numeric(30, 12),
  signal_ask numeric(30, 12),
  mark_bid numeric(30, 12),
  mark_ask numeric(30, 12),
  maker_available boolean NOT NULL,
  taker_available boolean NOT NULL,
  maker_fill_probability numeric(20, 12),
  maker_filled_qty numeric(30, 12) NOT NULL DEFAULT 0,
  maker_fill_fraction numeric(20, 12),
  maker_fill_latency_ms bigint,
  maker_expired boolean NOT NULL DEFAULT false,
  maker_entry_price numeric(30, 12),
  taker_entry_price numeric(30, 12),
  maker_modeled_cost_bps numeric(20, 10),
  taker_modeled_cost_bps numeric(20, 10),
  maker_predicted_net_bps numeric(20, 10),
  taker_predicted_net_bps numeric(20, 10),
  maker_net_bps numeric(20, 10),
  taker_net_bps numeric(20, 10),
  maker_minus_taker_bps numeric(20, 10),
  missed_taker_alpha_bps numeric(20, 10),
  maker_executable_exit_price numeric(30, 12),
  taker_executable_exit_price numeric(30, 12),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (decision_id, horizon_ms)
);

CREATE TABLE IF NOT EXISTS alpha_calibrations (
  cohort_key text PRIMARY KEY,
  configuration_version text NOT NULL,
  symbol text NOT NULL,
  family text NOT NULL,
  side smallint NOT NULL CHECK (side IN (-1, 1)),
  regime text NOT NULL,
  execution_path text NOT NULL,
  route_style text NOT NULL CHECK (route_style IN ('maker', 'taker')),
  horizon_ms bigint NOT NULL,
  independent_samples integer NOT NULL,
  out_of_sample_samples integer NOT NULL,
  coverage_ms bigint NOT NULL,
  validation_folds integer NOT NULL,
  mean_out_of_sample_net_bps numeric(20, 10),
  lower_confidence_net_bps numeric(20, 10),
  predicted_realized_correlation numeric(20, 12),
  prediction_mae_bps numeric(20, 10),
  maker_fill_auc numeric(20, 12),
  promoted boolean NOT NULL DEFAULT false,
  rejection_reasons text[] NOT NULL DEFAULT '{}',
  calibrated_bucket jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alpha_signals_cohort_time_idx
  ON alpha_signals (configuration_version, symbol, family, side, regime, signal_at);
CREATE INDEX IF NOT EXISTS alpha_markouts_time_idx ON alpha_markouts (marked_at, horizon_ms);
CREATE INDEX IF NOT EXISTS alpha_calibrations_promoted_idx
  ON alpha_calibrations (configuration_version, promoted) WHERE promoted;

INSERT INTO alpha_signals (
  decision_id,run_id,configuration_version,strategy_version,symbol,strategy_class,family,side,regime,
  regime_pass,edge_source,edge_effective_sample_count,economic_horizon_ms,selected_style,signal_at,
  predicted_gross_bps,predicted_lower_bound_net_bps,predicted_cost_bps,maker_plan,taker_plan,features,payload
)
SELECT
  event.payload->>'decisionId',event.run_id,event.payload->>'configurationVersion',
  COALESCE(run.strategy_version,'unknown'),event.payload->>'symbol',
  CASE event.payload->>'family'
    WHEN 'CONTINUATION' THEN 'trend'
    WHEN 'EARLY_BREAKOUT' THEN 'breakout'
    ELSE 'mean_reversion'
  END,
  event.payload->>'family',(event.payload->>'side')::smallint,
  COALESCE(NULLIF(event.payload->>'regime',''),'UNKNOWN'),
  COALESCE((event.payload->>'regimePass')::boolean,false),COALESCE(event.payload->>'edgeSource','UNRESOLVED'),
  COALESCE((event.payload->>'edgeEffectiveSampleCount')::numeric,0),
  COALESCE((event.payload#>>'{makerPlan,economicHorizonMs}')::bigint,
    (event.payload#>>'{takerPlan,economicHorizonMs}')::bigint),
  event.payload->>'selectedStyle',event.occurred_at,
  COALESCE((event.payload#>>'{makerPlan,conservativeNetEdgeBps}')::numeric
      + (event.payload#>>'{makerPlan,roundTripCostBps}')::numeric,
    (event.payload#>>'{takerPlan,conservativeNetEdgeBps}')::numeric
      + (event.payload#>>'{takerPlan,roundTripCostBps}')::numeric),
  COALESCE((event.payload#>>'{makerPlan,conservativeNetEdgeBps}')::numeric,
    (event.payload#>>'{takerPlan,conservativeNetEdgeBps}')::numeric),
  COALESCE((event.payload#>>'{makerPlan,roundTripCostBps}')::numeric,
    (event.payload#>>'{takerPlan,roundTripCostBps}')::numeric),
  event.payload->'makerPlan',event.payload->'takerPlan','{}'::jsonb,event.payload
FROM system_events event
LEFT JOIN engine_runs run ON run.id=event.run_id
WHERE event.event_type='entryRouteShadowStarted' AND event.payload->>'decisionId' IS NOT NULL
ON CONFLICT (decision_id) DO NOTHING;

INSERT INTO alpha_markouts (
  decision_id,horizon_ms,run_id,signal_at,marked_at,mark_delay_ms,
  maker_available,taker_available,maker_fill_probability,maker_filled_qty,maker_fill_fraction,
  maker_fill_latency_ms,maker_expired,maker_entry_price,taker_entry_price,maker_modeled_cost_bps,
  taker_modeled_cost_bps,maker_predicted_net_bps,taker_predicted_net_bps,maker_net_bps,taker_net_bps,
  maker_minus_taker_bps,missed_taker_alpha_bps,maker_executable_exit_price,taker_executable_exit_price,payload
)
SELECT
  event.payload->>'decisionId',(event.payload->>'horizonMs')::bigint,event.run_id,
  to_timestamp((event.payload->>'signalAtMs')::double precision/1000),
  to_timestamp((event.payload->>'markedAtMs')::double precision/1000),
  COALESCE((event.payload->>'markDelayMs')::bigint,0),
  COALESCE((event.payload->>'makerAvailable')::boolean,false),
  COALESCE((event.payload->>'takerAvailable')::boolean,false),
  (event.payload->>'makerFillProbability')::numeric,COALESCE((event.payload->>'makerFilledQty')::numeric,0),
  (event.payload->>'makerFillFraction')::numeric,(event.payload->>'makerFillLatencyMs')::bigint,
  COALESCE((event.payload->>'makerExpired')::boolean,false),
  (signal.maker_plan->>'limitPx')::numeric,(signal.taker_plan->>'limitPx')::numeric,
  (signal.maker_plan->>'roundTripCostBps')::numeric,(signal.taker_plan->>'roundTripCostBps')::numeric,
  (signal.maker_plan->>'conservativeNetEdgeBps')::numeric,
  (signal.taker_plan->>'conservativeNetEdgeBps')::numeric,
  (event.payload->>'makerNetBps')::numeric,(event.payload->>'takerNetBps')::numeric,
  (event.payload->>'makerMinusTakerBps')::numeric,(event.payload->>'missedTakerAlphaBps')::numeric,
  (event.payload->>'makerExecutableExitPx')::numeric,(event.payload->>'takerExecutableExitPx')::numeric,event.payload
FROM system_events event
JOIN alpha_signals signal ON signal.decision_id=event.payload->>'decisionId'
WHERE event.event_type='entryRouteShadowMark' AND event.payload->>'horizonMs' IS NOT NULL
ON CONFLICT (decision_id,horizon_ms) DO NOTHING;

COMMIT;
