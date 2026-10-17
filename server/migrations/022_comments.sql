-- Comments (#213): one row per comment on one item, keyed by where the item lives for its owner: `owner_id`, the owner's
-- `source` (`home` or `conn:<id>`, never `share:<id>`) and the owner's `path`, so the owner and every grantee reach the
-- same thread. Home paths follow moves through the PATH_TABLES cascade; a delete to the trash sets `trash_id` (the rows
-- come back with a restore and go with the purge, TRASH_TABLES). Cloud paths follow the moves and deletes made through
-- the app; unlinking the connection deletes its rows.
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  path       TEXT NOT NULL,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  trash_id   TEXT
);
CREATE INDEX comments_item ON comments(owner_id, source, path) WHERE trash_id IS NULL;
CREATE INDEX comments_trash ON comments(trash_id) WHERE trash_id IS NOT NULL;
