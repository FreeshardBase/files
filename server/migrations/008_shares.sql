-- Internal shares (#146): the owner grants one member `read` or `edit` on an item of one of their sources. The
-- grantee reaches it as the source `share:<id>`; every request re-reads this row. Home paths follow moves through the
-- PATH_TABLES cascade; a delete sets `orphaned_at` (the share then answers SHARE_ORPHANED) instead of removing the row.
CREATE TABLE shares (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  path        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('file','directory')),
  grantee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access      TEXT NOT NULL CHECK (access IN ('read','edit')),
  created_at  TEXT NOT NULL,
  orphaned_at TEXT,
  CHECK (grantee_id <> owner_id)
);
-- The cascade and the owner's "who has access" look up by owner and path; "Shared with me" by grantee.
CREATE INDEX shares_owner_path ON shares(owner_id, source, path);
CREATE INDEX shares_grantee ON shares(grantee_id);
-- One live share per item and grantee; sharing again changes its access.
CREATE UNIQUE INDEX shares_live ON shares(owner_id, source, path, grantee_id) WHERE orphaned_at IS NULL;
