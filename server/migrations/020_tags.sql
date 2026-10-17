-- Tags (#212): one row per tag on one item of a member, in any of their sources (`home`, `conn:<id>`, `share:<id>`).
-- A tag is the set of a member's rows with one `name_fold`; it has no row of its own. Home paths follow moves through the
-- PATH_TABLES cascade; a delete to the trash sets `trash_id` (the rows come back with a restore and go with the purge,
-- TRASH_TABLES). Other sources follow the moves and deletes made through the app. When the whole source is gone (an
-- unlinked connection) `gone_at` is set and the row is never resolved again.
CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  path       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('file','directory')),
  name       TEXT NOT NULL,
  name_fold  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trash_id   TEXT,
  gone_at    TEXT
);
-- One live row per tag and item; rows in the trash may repeat what a new item at the same path carries.
CREATE UNIQUE INDEX tags_item ON tags(user_id, source, path, name_fold) WHERE trash_id IS NULL;
CREATE INDEX tags_name ON tags(user_id, name_fold);
CREATE INDEX tags_trash ON tags(trash_id) WHERE trash_id IS NOT NULL;
