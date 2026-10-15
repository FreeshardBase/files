-- Migrations from a cloud connection to the home and their cleanups (#153), as kinds of transfer jobs. A cleanup's
-- `origin` is its migration; `cleanup_token` holds the SHA-256 of the migration's single-use confirmation token, valid
-- until `cleanup_expires`.
ALTER TABLE transfer_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer','migration','cleanup'));
ALTER TABLE transfer_jobs ADD COLUMN origin TEXT REFERENCES transfer_jobs(id) ON DELETE SET NULL;
ALTER TABLE transfer_jobs ADD COLUMN cleanup_token TEXT;
ALTER TABLE transfer_jobs ADD COLUMN cleanup_expires TEXT;
CREATE INDEX transfer_jobs_origin ON transfer_jobs(origin);

-- What a file item was received as: `sha256` of the bytes sent (stored with `placed`), the source's `src_modified`, and
-- `verified`, the checks it passed (`size sha256 md5`). A cleanup item carries the same values from its migration item
-- and checks them again before it deletes the original.
ALTER TABLE transfer_items ADD COLUMN sha256 TEXT;
ALTER TABLE transfer_items ADD COLUMN src_modified TEXT;
ALTER TABLE transfer_items ADD COLUMN verified TEXT;
