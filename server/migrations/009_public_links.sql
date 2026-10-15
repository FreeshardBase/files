-- Public links (#147): anyone with the token reaches one item of the owner's source through `/s/<token>`, proxied by
-- the shard. Optional password (argon2id hash), expiry and a download limit counted on the server (`downloads` against
-- `max_downloads`; NULL = no limit, 0 = no downloads). Home paths follow moves through the PATH_TABLES cascade; a
-- delete sets `orphaned_at` (the link then answers SHARE_ORPHANED) instead of removing the row.
CREATE TABLE public_links (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  path           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('file','directory')),
  label          TEXT NOT NULL,
  password_hash  TEXT,
  expires_at     TEXT,
  max_downloads  INTEGER CHECK (max_downloads IS NULL OR max_downloads >= 0),
  downloads      INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  created_at     TEXT NOT NULL,
  orphaned_at    TEXT
);
-- Visitors look up by token; the cascade and the owner's list of links on an item by owner and path.
CREATE UNIQUE INDEX public_links_token ON public_links(token);
CREATE INDEX public_links_owner_path ON public_links(owner_id, source, path);
