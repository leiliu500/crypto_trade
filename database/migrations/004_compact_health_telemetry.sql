ALTER TABLE health_snapshots
  ADD COLUMN IF NOT EXISTS database_queued_records integer,
  ADD COLUMN IF NOT EXISTS database_dropped_records bigint,
  ADD COLUMN IF NOT EXISTS database_last_persisted_at timestamptz,
  ADD COLUMN IF NOT EXISTS database_error text;

CREATE INDEX IF NOT EXISTS health_snapshots_run_dropped_idx
  ON health_snapshots (run_id, database_dropped_records)
  WHERE database_dropped_records IS NOT NULL;
