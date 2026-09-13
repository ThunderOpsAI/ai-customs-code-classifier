ALTER TABLE api_keys ADD COLUMN key_fingerprint TEXT;
CREATE INDEX idx_api_keys_fingerprint
  ON api_keys (key_fingerprint)
  WHERE revoked_at IS NULL;
