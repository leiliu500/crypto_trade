BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL,
  paper boolean NOT NULL,
  strategy_version text NOT NULL,
  model_version text NOT NULL,
  symbols text[] NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS system_events (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  symbol text,
  client_order_id text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL,
  overall_status text NOT NULL,
  public_stream boolean NOT NULL,
  private_stream boolean NOT NULL,
  account_reconciled boolean NOT NULL,
  book_valid boolean NOT NULL,
  clock_valid boolean NOT NULL,
  risk_recomputed boolean NOT NULL,
  database_connected boolean NOT NULL,
  halt_reasons text[] NOT NULL DEFAULT '{}',
  equity numeric(30, 12),
  equity_high_water numeric(30, 12),
  uptime_ms bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS orders (
  client_order_id text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  venue_order_id text,
  symbol text NOT NULL,
  side smallint NOT NULL CHECK (side IN (-1, 1)),
  style text NOT NULL,
  time_in_force text NOT NULL,
  status text NOT NULL,
  requested_qty numeric(30, 12) NOT NULL,
  filled_qty numeric(30, 12) NOT NULL DEFAULT 0,
  average_fill_price numeric(30, 12),
  limit_price numeric(30, 12) NOT NULL,
  expected_value numeric(30, 12),
  fill_probability numeric(20, 12),
  reduce_only_intent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  client_order_id text NOT NULL,
  venue_order_id text,
  event_type text NOT NULL,
  status text,
  event_qty numeric(30, 12),
  event_price numeric(30, 12),
  filled_qty numeric(30, 12),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS fills (
  execution_id text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  client_order_id text NOT NULL,
  symbol text NOT NULL,
  side smallint NOT NULL CHECK (side IN (-1, 1)),
  qty numeric(30, 12) NOT NULL,
  price numeric(30, 12) NOT NULL,
  final boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS positions (
  run_id uuid NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side smallint NOT NULL CHECK (side IN (-1, 1)),
  qty numeric(30, 12) NOT NULL,
  entry_price numeric(30, 12) NOT NULL,
  current_price numeric(30, 12),
  unrealized_pnl numeric(30, 12),
  phase text NOT NULL,
  floor_price numeric(30, 12) NOT NULL,
  stop_price numeric(30, 12),
  mfe numeric(30, 12) NOT NULL,
  mae numeric(30, 12) NOT NULL,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, symbol)
);

CREATE TABLE IF NOT EXISTS position_events (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  action text NOT NULL,
  reason text,
  qty numeric(30, 12),
  current_price numeric(30, 12),
  floor_price numeric(30, 12),
  hold_edge_bps numeric(20, 10),
  reversal_probability numeric(20, 12),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  decision_type text NOT NULL,
  symbol text NOT NULL,
  side smallint CHECK (side IN (-1, 1)),
  regime text,
  probability numeric(20, 12),
  predicted_gross_bps numeric(20, 10),
  lower_bound_net_bps numeric(20, 10),
  expected_cost_bps numeric(20, 10),
  action text,
  reason text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  captured_at timestamptz NOT NULL,
  mid numeric(30, 12),
  best_bid numeric(30, 12),
  best_ask numeric(30, 12),
  spread_bps numeric(20, 10),
  sigma_h_bps numeric(20, 10),
  provider_age_ms numeric(20, 4),
  regime text,
  book_valid boolean NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS system_events_run_time_idx ON system_events (run_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS system_events_type_time_idx ON system_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS order_events_client_time_idx ON order_events (client_order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS health_snapshots_run_time_idx ON health_snapshots (run_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS position_events_symbol_time_idx ON position_events (symbol, occurred_at DESC);
CREATE INDEX IF NOT EXISTS market_snapshots_symbol_time_idx ON market_snapshots (symbol, captured_at DESC);
CREATE INDEX IF NOT EXISTS decisions_symbol_time_idx ON decisions (symbol, occurred_at DESC);

INSERT INTO schema_migrations (version) VALUES ('001_initial') ON CONFLICT (version) DO NOTHING;

COMMIT;
