CREATE TABLE pending_translation_jobs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN (
    'pending',
    'processing',
    'ready_for_delivery',
    'delivered_acknowledged',
    'expired'
  )),
  encrypted_payload bytea,
  source_language text CHECK (source_language IS NULL OR source_language IN ('en','hu','be')),
  target_language text NOT NULL CHECK (target_language IN ('en','hu','be')),
  style text CHECK (style IS NULL OR style IN ('formal','everyday','casual')),
  input_mode text NOT NULL CHECK (input_mode IN ('text','voice_transcript')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_failure_reason text CHECK (
    last_failure_reason IS NULL OR last_failure_reason IN (
      'poor_network_coverage',
      'model_unavailable',
      'processing_timeout',
      'technical_failure',
      'other'
    )
  ),
  next_attempt_at timestamptz,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    state NOT IN ('delivered_acknowledged','expired')
    OR (encrypted_payload IS NULL AND next_attempt_at IS NULL)
  ),
  CHECK (
    state <> 'ready_for_delivery'
    OR (encrypted_payload IS NOT NULL AND source_language IS NOT NULL)
  )
);

CREATE INDEX pending_translation_jobs_due_idx
  ON pending_translation_jobs(next_attempt_at, created_at)
  WHERE state = 'pending';

CREATE INDEX pending_translation_jobs_lease_idx
  ON pending_translation_jobs(lease_expires_at)
  WHERE state = 'processing';

CREATE INDEX pending_translation_jobs_expiry_idx
  ON pending_translation_jobs(expires_at)
  WHERE state NOT IN ('delivered_acknowledged','expired');
