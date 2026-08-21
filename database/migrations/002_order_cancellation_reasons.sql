BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancel_request_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE order_events
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

CREATE INDEX IF NOT EXISTS orders_cancellation_reason_time_idx
  ON orders (cancellation_reason, updated_at DESC);

COMMIT;
