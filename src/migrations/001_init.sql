-- 001_init.sql

CREATE TABLE IF NOT EXISTS devices (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             TEXT UNIQUE NOT NULL,
  device_id           TEXT NOT NULL,
  registration_id     INTEGER NOT NULL,
  identity_public_key TEXT NOT NULL,
  signed_prekey       JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES devices(user_id) ON DELETE CASCADE,
  key_id      INTEGER NOT NULL,
  public_key  TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  UNIQUE (user_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_otp_free
  ON one_time_prekeys (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES devices(user_id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS envelopes (
  id                TEXT PRIMARY KEY,
  sender_user_id    TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  ciphertext        BYTEA NOT NULL,
  sent_at           TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_envelopes_queue
  ON envelopes (recipient_user_id, received_at)
  WHERE delivered_at IS NULL;
