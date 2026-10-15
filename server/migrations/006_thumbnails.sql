-- The thumbnail cache (#144): one row per generated thumbnail, its bytes in `<DATA_DIR>/thumbs/<id>.webp`.
-- `etag` is the source file's ETag when it was generated; a different one means the file changed and the row is stale.
-- `used_at` is a logical clock for LRU eviction under FILES_THUMB_CACHE_BYTES. Moves, writes and deletes in the app
-- drop the rows of the paths they touch (and their files).
CREATE TABLE thumbnails (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  etag    TEXT NOT NULL,
  bytes   INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  UNIQUE (user_id, path, size)
);
CREATE INDEX thumbnails_used ON thumbnails(used_at);
