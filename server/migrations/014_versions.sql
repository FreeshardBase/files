-- #154: the earlier content of a file that was overwritten, kept in <home>/.files/versions/<id>.
-- `path` follows moves of the file (PATH_TABLES). While the file is in the trash, `trash_id` names its trash row: the
-- version is not live, comes back with a restore and is purged with the row (TRASH_TABLES).
CREATE TABLE versions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  modified   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trash_id   TEXT REFERENCES trash(id)
);
CREATE INDEX versions_path ON versions(user_id, path);
CREATE INDEX versions_trash ON versions(trash_id);
