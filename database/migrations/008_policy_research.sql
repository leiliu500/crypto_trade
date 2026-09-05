BEGIN;

CREATE TABLE IF NOT EXISTS policy_observations (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
  configuration_version text NOT NULL,
  policy_version text NOT NULL,
  symbol text NOT NULL,
  policy_id text NOT NULL,
  signal_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','COMPLETE','INVALID')),
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_observations_config_time_idx
  ON policy_observations(configuration_version,policy_version,signal_at);

CREATE TABLE IF NOT EXISTS policy_evaluations (
  id bigserial PRIMARY KEY,
  configuration_version text NOT NULL,
  policy_version text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  report jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_models (
  model_key text PRIMARY KEY,
  configuration_version text NOT NULL,
  policy_version text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  model jsonb NOT NULL
);

-- Legacy fixed-horizon labels do not reproduce the execution exit policy.
-- Keep their diagnostic history but revoke their authority to affect orders.
UPDATE alpha_calibrations SET promoted=false,calibrated_bucket=NULL,
  rejection_reasons=array_append(rejection_reasons,'LEGACY_MARKOUT_DIAGNOSTIC_ONLY');
COMMIT;
