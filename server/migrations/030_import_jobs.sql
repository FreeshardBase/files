-- Imports of export archives (#322) are transfer jobs of kind `import`; an archive entry they leave out (a photo export)
-- is an item with status `skipped`. SQLite cannot widen a CHECK, so both tables are rebuilt with their rows, as in 023.
CREATE TABLE transfer_jobs_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('copy','move')),
  from_source     TEXT NOT NULL,
  to_source       TEXT NOT NULL,
  dir             TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_errors','cancelled')),
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  kind            TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer','migration','cleanup','rename','import')),
  origin          TEXT REFERENCES transfer_jobs_new(id) ON DELETE SET NULL,
  cleanup_token   TEXT,
  cleanup_expires TEXT
);
CREATE TABLE transfer_items_new (
  job_id       TEXT NOT NULL REFERENCES transfer_jobs_new(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  parent       INTEGER,
  from_path    TEXT NOT NULL,
  to_path      TEXT NOT NULL,
  on_collision TEXT NOT NULL CHECK (on_collision IN ('fail','replace','keep-both')),
  type         TEXT CHECK (type IN ('file','directory')),
  placed       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','active','done','failed','cancelled','skipped')),
  error        TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  src_modified TEXT,
  verified     TEXT,
  PRIMARY KEY (job_id, seq)
);
INSERT INTO transfer_jobs_new (id, user_id, mode, from_source, to_source, dir, status, created_at, finished_at, kind, origin,
  cleanup_token, cleanup_expires)
  SELECT id, user_id, mode, from_source, to_source, dir, status, created_at, finished_at, kind, origin, cleanup_token, cleanup_expires
  FROM transfer_jobs;
INSERT INTO transfer_items_new (job_id, seq, parent, from_path, to_path, on_collision, type, placed, status, error, bytes, sha256,
  src_modified, verified)
  SELECT job_id, seq, parent, from_path, to_path, on_collision, type, placed, status, error, bytes, sha256, src_modified, verified
  FROM transfer_items;
DROP TABLE transfer_items;
DROP TABLE transfer_jobs;
ALTER TABLE transfer_jobs_new RENAME TO transfer_jobs;
ALTER TABLE transfer_items_new RENAME TO transfer_items;
CREATE INDEX transfer_jobs_user ON transfer_jobs(user_id, created_at);
CREATE INDEX transfer_jobs_status ON transfer_jobs(status);
CREATE INDEX transfer_jobs_origin ON transfer_jobs(origin);
CREATE INDEX transfer_items_status ON transfer_items(job_id, status);
CREATE INDEX transfer_items_pending ON transfer_items(status, job_id, seq);
