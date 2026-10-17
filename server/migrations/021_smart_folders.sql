-- Smart folders (#214): a member's saved, structured query (`query`, the JSON of `SmartQuery` from shared/, parsed again
-- whenever it is read), evaluated on every open. Nothing of its result is stored.
CREATE TABLE smart_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX smart_folders_user ON smart_folders(user_id, created_at);
