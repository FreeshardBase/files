-- One row per item moved to <home>/.files/trash/<id>; written in the same transaction as the move (#137).
-- Listing, restore and expiry are #138.
CREATE TABLE trash (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_path TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('file','directory')),
  size          INTEGER NOT NULL,
  deleted_at    TEXT NOT NULL
);
CREATE INDEX trash_user ON trash(user_id, deleted_at);
