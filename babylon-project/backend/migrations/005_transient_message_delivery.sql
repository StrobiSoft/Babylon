CREATE TABLE message_deliveries (
  request_id uuid NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload bytea,
  payload_format text NOT NULL CHECK (payload_format IN ('transport-v1')),
  state text NOT NULL CHECK (state IN ('pending', 'delivered', 'expired', 'failed')),
  failure_code text CHECK (failure_code IN ('recipient_unavailable', 'invalid_payload', 'retry_exhausted')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  terminal_at timestamptz,
  PRIMARY KEY (sender_user_id, request_id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'pending' AND payload IS NOT NULL AND terminal_at IS NULL) OR
         (state <> 'pending' AND payload IS NULL AND terminal_at IS NOT NULL))
);

CREATE INDEX message_deliveries_recipient_pending_idx
  ON message_deliveries (recipient_user_id, created_at) WHERE state = 'pending';
CREATE INDEX message_deliveries_expiry_idx
  ON message_deliveries (expires_at) WHERE state = 'pending';
CREATE INDEX message_deliveries_terminal_cleanup_idx
  ON message_deliveries (terminal_at) WHERE state <> 'pending';

COMMENT ON TABLE message_deliveries IS
  'Transient opaque delivery envelopes and bounded terminal tombstones; never conversation history.';
