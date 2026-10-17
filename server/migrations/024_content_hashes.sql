-- Duplicate finder (#216): the SHA-256 of a home file, computed lazily by a scan and valid while the file still has the
-- `size` and `mtime` it was hashed at. In PATH_TABLES: a move takes the row along, a delete removes it. A delete of a
-- duplicate never trusts this row; it hashes the file again.
CREATE TABLE content_hashes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  mtime   TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
);
