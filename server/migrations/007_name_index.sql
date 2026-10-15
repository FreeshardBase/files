-- Name search (#145): one row per file or folder in a member's home. Written in the transaction of every write
-- (upload, mkdir, copy, move, rename, restore); moves and deletes reach it through the PATH_TABLES cascade.
-- `name_fold` is the item's own name, NFC and lower case, matched with instr() (no LIKE, so no wildcards).
-- The primary key starts with user_id, so it also serves every per-member lookup.
CREATE TABLE name_index (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  name_fold TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('file','directory')),
  size      INTEGER NOT NULL,
  modified  TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
) WITHOUT ROWID;
