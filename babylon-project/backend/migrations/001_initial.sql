CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  status text NOT NULL CHECK (status IN ('pending_email', 'email_verified', 'active', 'disabled')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email)),
  token_hash bytea NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  consumed_by uuid REFERENCES users(id),
  CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);
CREATE INDEX invitations_active_idx ON invitations (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  invalidated_at timestamptz
);
CREATE UNIQUE INDEX email_tokens_one_active_idx ON email_verification_tokens (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX email_tokens_expiry_idx ON email_verification_tokens (expires_at);

CREATE TABLE enrollment_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  invalidated_at timestamptz
);
CREATE UNIQUE INDEX enrollment_one_active_idx ON enrollment_grants (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX enrollment_expiry_idx ON enrollment_grants (expires_at);

CREATE TABLE native_auth_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  client_id text NOT NULL,
  return_profile text NOT NULL,
  pkce_challenge text NOT NULL CHECK (length(pkce_challenge) = 43),
  state_hash bytea NOT NULL,
  operation text NOT NULL CHECK (operation IN ('register', 'authenticate')),
  user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  completed_at timestamptz,
  exchanged_at timestamptz
);
CREATE INDEX native_transactions_expiry_idx ON native_auth_transactions (expires_at);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  transaction_id uuid NOT NULL REFERENCES native_auth_transactions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('registration', 'authentication')),
  challenge text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz
);
CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges (expires_at);

CREATE TABLE passkey_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports jsonb NOT NULL DEFAULT '[]'::jsonb,
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX passkey_user_idx ON passkey_credentials (user_id) WHERE revoked_at IS NULL;

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  platform text NOT NULL CHECK (length(platform) BETWEEN 1 AND 32),
  client_device_key_hash bytea NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (user_id, client_device_key_hash)
);
CREATE INDEX devices_user_idx ON devices (user_id, created_at);

CREATE TABLE refresh_token_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replay_detected_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES refresh_token_families(id) ON DELETE CASCADE,
  access_token_hash bytea NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT session_lifetime CHECK (expires_at > created_at AND access_expires_at <= expires_at)
);
CREATE INDEX sessions_user_device_idx ON sessions (user_id, device_id);
CREATE INDEX sessions_active_idx ON sessions (access_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES refresh_token_families(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  revoked_at timestamptz
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

CREATE TABLE app_return_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL UNIQUE REFERENCES native_auth_transactions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  return_profile text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('register', 'authenticate')),
  pkce_challenge text NOT NULL,
  state_hash bytea NOT NULL,
  code_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz
);
CREATE INDEX return_codes_expiry_idx ON app_return_codes (expires_at);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  subject_user_id uuid REFERENCES users(id),
  device_id uuid REFERENCES devices(id),
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_user_time_idx ON audit_log (subject_user_id, occurred_at DESC);
CREATE INDEX audit_event_time_idx ON audit_log (event_type, occurred_at DESC);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

