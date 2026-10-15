-- Resumable uploads (tus, #140): one row per upload in progress; the bytes so far are <home>/.files/uploads/<id>.
-- `received` is what has been fsynced; the next PATCH continues from there.
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  path         TEXT NOT NULL,
  length       INTEGER NOT NULL CHECK (length >= 0),
  received     INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0 AND received <= length),
  on_collision TEXT NOT NULL CHECK (on_collision IN ('fail','replace','keep-both')),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX uploads_user ON uploads(user_id);
-- The expiry job looks for expired uploads across all members.
CREATE INDEX uploads_expires_at ON uploads(expires_at);

-- Per-member storage quota in bytes, set by the admin; NULL means no quota (only the disk limits).
ALTER TABLE users ADD COLUMN quota_bytes INTEGER CHECK (quota_bytes IS NULL OR quota_bytes >= 0);
