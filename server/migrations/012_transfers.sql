-- Transfer jobs (#152): copies and moves between sources. One row per job and one per item (a file or a folder; a
-- folder's children are added when it is listed). The engine (server/src/storage/transfers.ts) resumes jobs that are
-- still `running` at start-up; items it was working on (`active`) start again, verified ones (`done`) are never redone.
CREATE TABLE transfer_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('copy','move')),
  from_source  TEXT NOT NULL,
  to_source    TEXT NOT NULL,
  dir          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_errors','cancelled')),
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX transfer_jobs_user ON transfer_jobs(user_id, created_at);
CREATE INDEX transfer_jobs_status ON transfer_jobs(status);

-- `to_path` is where the item goes; `placed` the path it actually got (a folder's is fixed before it is created, so a
-- resumed job reuses it). `parent` is the folder item it came from (NULL for what the member picked); a move deletes a
-- source folder only when every item beneath it is done. `bytes` is the verified size of a done file.
CREATE TABLE transfer_items (
  job_id       TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  parent       INTEGER,
  from_path    TEXT NOT NULL,
  to_path      TEXT NOT NULL,
  on_collision TEXT NOT NULL CHECK (on_collision IN ('fail','replace','keep-both')),
  type         TEXT CHECK (type IN ('file','directory')),
  placed       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending','active','done','failed','cancelled')),
  error        TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX transfer_items_status ON transfer_items(job_id, status);
CREATE INDEX transfer_items_pending ON transfer_items(status, job_id, seq);
