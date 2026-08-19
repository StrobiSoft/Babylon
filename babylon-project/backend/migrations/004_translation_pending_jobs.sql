CREATE TABLE translation_pending_jobs (
  request_id uuid PRIMARY KEY,
  encrypted_payload bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'poor_network_coverage',
    'model_unavailable',
    'processing_timeout',
    'technical_failure',
    'other'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX translation_pending_jobs_due_idx
  ON translation_pending_jobs (next_attempt_at)
  WHERE attempt_count >= 0;

CREATE INDEX translation_pending_jobs_expiry_idx
  ON translation_pending_jobs (expires_at);

COMMENT ON TABLE translation_pending_jobs IS
  'Short-lived encrypted processing state for accepted translations awaiting retry; not conversation history.';
