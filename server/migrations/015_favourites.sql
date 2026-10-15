-- Favourites (#155): one row per item a member pinned, in any of their sources (`home`, `conn:<id>`, `share:<id>`).
-- Home paths follow moves and go with deletes through the PATH_TABLES cascade; other sources follow the moves and
-- deletes made through the app. When the whole source is gone (an unlinked connection) `gone_at` is set: the row stays
-- in the list as unavailable and is never resolved again, even if the account is connected again.
CREATE TABLE favourites (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  path       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('file','directory')),
  created_at TEXT NOT NULL,
  gone_at    TEXT,
  UNIQUE (user_id, source, path)
);
