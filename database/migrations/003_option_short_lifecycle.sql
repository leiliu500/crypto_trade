BEGIN;

CREATE TABLE IF NOT EXISTS option_short_orders (
  client_order_id text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  alpaca_order_id text,
  crypto_symbol text NOT NULL,
  proxy_symbol text,
  contract_symbol text NOT NULL,
  expiration_date date,
  purpose text NOT NULL CHECK (purpose IN ('OPEN_SHORT', 'CLOSE_SHORT')),
  side text CHECK (side IN ('buy', 'sell')),
  position_intent text CHECK (position_intent IN ('buy_to_open', 'sell_to_close')),
  order_type text,
  time_in_force text NOT NULL DEFAULT 'day',
  status text NOT NULL,
  requested_qty numeric(20, 8),
  filled_qty numeric(20, 8) NOT NULL DEFAULT 0,
  average_fill_premium numeric(20, 8),
  limit_premium numeric(20, 8),
  maximum_premium_risk numeric(30, 8),
  decision_id text,
  reason text,
  market_data text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS option_short_order_events (
  id bigserial PRIMARY KEY,
  source_event_id text NOT NULL UNIQUE,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  client_order_id text NOT NULL REFERENCES option_short_orders(client_order_id) ON DELETE CASCADE,
  alpaca_order_id text,
  event_type text NOT NULL,
  purpose text CHECK (purpose IN ('OPEN_SHORT', 'CLOSE_SHORT')),
  status text,
  event_qty numeric(20, 8),
  event_price numeric(20, 8),
  filled_qty numeric(20, 8),
  reason text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS option_short_trades (
  trade_key text PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  crypto_symbol text NOT NULL,
  proxy_symbol text NOT NULL,
  contract_symbol text NOT NULL,
  expiration_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  qty numeric(20, 8) NOT NULL,
  entry_premium numeric(20, 8) NOT NULL,
  premium_at_risk numeric(30, 8) NOT NULL,
  entry_crypto_price numeric(30, 12),
  current_premium numeric(20, 8),
  unrealized_pnl numeric(30, 8),
  unrealized_pnl_bps numeric(20, 8),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS option_short_pnl_events (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  trade_key text NOT NULL REFERENCES option_short_trades(trade_key) ON DELETE CASCADE,
  crypto_symbol text NOT NULL,
  contract_symbol text NOT NULL,
  captured_at timestamptz NOT NULL,
  current_premium numeric(20, 8) NOT NULL,
  unrealized_pnl numeric(30, 8) NOT NULL,
  unrealized_pnl_bps numeric(20, 8) NOT NULL,
  change_pnl numeric(30, 8),
  mark_kind text NOT NULL DEFAULT 'mark',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (trade_key, captured_at, current_premium, unrealized_pnl)
);

CREATE INDEX IF NOT EXISTS option_short_orders_crypto_time_idx
  ON option_short_orders (crypto_symbol, updated_at DESC);
CREATE INDEX IF NOT EXISTS option_short_orders_contract_time_idx
  ON option_short_orders (contract_symbol, updated_at DESC);
CREATE INDEX IF NOT EXISTS option_short_order_events_client_time_idx
  ON option_short_order_events (client_order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS option_short_order_events_type_time_idx
  ON option_short_order_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS option_short_trades_crypto_time_idx
  ON option_short_trades (crypto_symbol, opened_at DESC);
CREATE INDEX IF NOT EXISTS option_short_pnl_trade_time_idx
  ON option_short_pnl_events (trade_key, captured_at DESC);

COMMIT;
