-- File requests (#217): anyone with the token uploads into one folder of the owner's source through `/r/<token>`,
-- without seeing it. Optional password (argon2id hash), expiry, and limits on the number of files and their total bytes
-- (NULL = no limit). Revoking sets `revoked_at` (the token then answers 410); home paths follow moves through the
-- PATH_TABLES cascade, and a delete sets `orphaned_at`.
CREATE TABLE file_requests (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  path           TEXT NOT NULL,
  label          TEXT NOT NULL,
  password_hash  TEXT,
  expires_at     TEXT,
  max_files      INTEGER CHECK (max_files IS NULL OR max_files >= 1),
  max_bytes      INTEGER CHECK (max_bytes IS NULL OR max_bytes >= 1),
  ask_name       INTEGER NOT NULL DEFAULT 0 CHECK (ask_name IN (0, 1)),
  created_at     TEXT NOT NULL,
  revoked_at     TEXT,
  orphaned_at    TEXT
);
CREATE UNIQUE INDEX file_requests_token ON file_requests(token);
CREATE INDEX file_requests_owner_path ON file_requests(owner_id, source, path);

-- One file a visitor sends: reserved (no `upload_id` yet) while its tus upload is being opened, then in progress (the
-- owner's `uploads` row `upload_id`), then received (`placed_at`, saved as `placed_name`). Reserved, in-progress and
-- received rows count against the request's limits; one whose upload expired or failed no longer does. `visitor` is
-- the random id in the visitor's session cookie: a visitor sees only their own rows. `seen_at` clears the owner's badge.
CREATE TABLE file_request_uploads (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES file_requests(id) ON DELETE CASCADE,
  visitor      TEXT NOT NULL,
  upload_id    TEXT UNIQUE,
  name         TEXT NOT NULL,
  length       INTEGER NOT NULL CHECK (length >= 0),
  uploader     TEXT,
  created_at   TEXT NOT NULL,
  placed_name  TEXT,
  placed_at    TEXT,
  seen_at      TEXT
);
CREATE INDEX file_request_uploads_request ON file_request_uploads(request_id);
