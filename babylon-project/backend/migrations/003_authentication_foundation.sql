ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (
  status IN (
    'invited', 'pending_verification', 'active', 'suspended', 'locked',
    'disabled', 'pending_deletion', 'tombstoned',
    -- Compatibility with transactions created by migrations 001-002.
    'pending_email', 'email_verified'
  )
);
ALTER TABLE users
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_reason text,
  ADD COLUMN security_version bigint NOT NULL DEFAULT 1 CHECK (security_version > 0),
  ADD COLUMN deleted_at timestamptz;
UPDATE users SET status='pending_verification' WHERE status IN ('pending_email','email_verified');

CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('email', 'oidc', 'saml', 'external')),
  issuer text NOT NULL DEFAULT 'babylon',
  subject text NOT NULL,
  normalized_subject text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  disabled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (type, issuer, normalized_subject)
);
CREATE INDEX identities_user_idx ON identities(user_id) WHERE disabled_at IS NULL;

INSERT INTO identities(user_id,type,subject,normalized_subject,verified_at,created_at)
SELECT id,'email',email,email,email_verified_at,created_at FROM users;

ALTER TABLE passkey_credentials
  ADD COLUMN name text NOT NULL DEFAULT 'Passkey' CHECK (length(name) BETWEEN 1 AND 80),
  ADD COLUMN backup_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN authenticator_attachment text,
  ADD COLUMN compromise_suspected_at timestamptz,
  ADD COLUMN revoked_reason text;

ALTER TABLE devices
  ADD COLUMN app_version text,
  ADD COLUMN trust_state text NOT NULL DEFAULT 'registered'
    CHECK (trust_state IN ('registered', 'trusted', 'restricted', 'revoked')),
  ADD COLUMN key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  ADD COLUMN public_key bytea,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN revoked_reason text;

ALTER TABLE sessions
  ADD COLUMN last_refreshed_at timestamptz,
  ADD COLUMN inactivity_expires_at timestamptz,
  ADD COLUMN authentication_method text NOT NULL DEFAULT 'webauthn_uv',
  ADD COLUMN assurance_level text NOT NULL DEFAULT 'aal2'
    CHECK (assurance_level IN ('aal1', 'aal2', 'aal3')),
  ADD COLUMN authenticated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN step_up_at timestamptz,
  ADD COLUMN ip_prefix_hash bytea,
  ADD COLUMN user_agent_family text,
  ADD COLUMN client_version text,
  ADD COLUMN revoked_reason text,
  ADD COLUMN security_version bigint NOT NULL DEFAULT 1 CHECK (security_version > 0);
UPDATE sessions SET last_refreshed_at=created_at, inactivity_expires_at=expires_at;
ALTER TABLE sessions ALTER COLUMN last_refreshed_at SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN inactivity_expires_at SET NOT NULL;
CREATE INDEX sessions_active_user_idx ON sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE auth_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN (
    'recovery', 'step_up', 'email_change', 'passkey_add', 'sensitive_action'
  )),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  identity_id uuid REFERENCES identities(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  state_hash bytea,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX auth_transactions_active_idx ON auth_transactions(purpose,expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE recovery_code_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  created_by_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX recovery_code_sets_one_active_idx ON recovery_code_sets(user_id)
  WHERE invalidated_at IS NULL;

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES recovery_code_sets(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE security_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  outcome text NOT NULL CHECK (outcome IN ('success','failure','blocked','detected')),
  actor_user_id uuid REFERENCES users(id),
  subject_user_id uuid REFERENCES users(id),
  session_id uuid,
  device_id uuid,
  request_id text,
  correlation_id text,
  source_ip_hash bytea,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_state text NOT NULL DEFAULT 'pending'
    CHECK (notification_state IN ('pending','not_required'))
);
CREATE INDEX security_events_subject_time_idx ON security_events(subject_user_id,occurred_at DESC);

CREATE TABLE security_event_deliveries (
  event_id bigint NOT NULL REFERENCES security_events(id) ON DELETE CASCADE,
  destination text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  PRIMARY KEY(event_id,destination)
);

CREATE TABLE abuse_counters (
  scope text NOT NULL,
  key_hash bytea NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(scope,key_hash)
);
CREATE INDEX abuse_counters_cleanup_idx ON abuse_counters(updated_at);

ALTER TABLE audit_log
  ADD COLUMN action text NOT NULL DEFAULT 'legacy',
  ADD COLUMN outcome text NOT NULL DEFAULT 'success',
  ADD COLUMN session_id uuid,
  ADD COLUMN correlation_id text,
  ADD COLUMN security_context jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE FUNCTION reject_security_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only';
END;
$$;
CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION reject_security_event_mutation();
