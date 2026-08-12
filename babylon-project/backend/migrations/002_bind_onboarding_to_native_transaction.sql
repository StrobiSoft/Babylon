ALTER TABLE email_verification_tokens
  ADD COLUMN transaction_id uuid REFERENCES native_auth_transactions(id) ON DELETE CASCADE;

ALTER TABLE enrollment_grants
  ADD COLUMN transaction_id uuid REFERENCES native_auth_transactions(id) ON DELETE CASCADE;

CREATE INDEX email_tokens_transaction_idx ON email_verification_tokens (transaction_id);
CREATE INDEX enrollment_transaction_idx ON enrollment_grants (transaction_id);

