CREATE TABLE auth_security_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0)
);
INSERT INTO auth_security_generation(singleton,generation) VALUES (true,1);

CREATE FUNCTION advance_auth_security_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE auth_security_generation SET generation=generation+1 WHERE singleton=true;
  RETURN NULL;
END;
$$;

CREATE TRIGGER auth_security_users_row_lifecycle
  AFTER INSERT OR DELETE ON users
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();
CREATE TRIGGER auth_security_users_update
  AFTER UPDATE OF email,status,security_version ON users
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();

CREATE TRIGGER auth_security_devices_row_lifecycle
  AFTER INSERT OR DELETE ON devices
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();
CREATE TRIGGER auth_security_devices_update
  AFTER UPDATE OF user_id,name,platform,revoked_at,trust_state,key_version ON devices
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();

CREATE TRIGGER auth_security_sessions_row_lifecycle
  AFTER INSERT OR DELETE ON sessions
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();
CREATE TRIGGER auth_security_sessions_update
  AFTER UPDATE OF user_id,device_id,family_id,access_token_hash,access_expires_at,expires_at,
    inactivity_expires_at,revoked_at,security_version,authenticated_at,step_up_at,
    assurance_level,authentication_method ON sessions
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();

CREATE TRIGGER auth_security_families_row_lifecycle
  AFTER INSERT OR DELETE ON refresh_token_families
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();
CREATE TRIGGER auth_security_families_update
  AFTER UPDATE OF user_id,device_id,revoked_at,replay_detected_at ON refresh_token_families
  FOR EACH STATEMENT EXECUTE FUNCTION advance_auth_security_generation();
