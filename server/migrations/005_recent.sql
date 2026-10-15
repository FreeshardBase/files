-- The Recent view (#141): one row per item a member wrote in their home (upload, copy, move, rename, restore).
-- `path` is kept current by the move/delete cascade (PATH_TABLES); a newer write of the same path replaces the row,
-- so `id` order is newest first. Capped per member when a row is written.
CREATE TABLE recent (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('file','directory')),
  changed_at TEXT NOT NULL,
  UNIQUE (user_id, path)
);
CREATE INDEX recent_user ON recent(user_id, id);
