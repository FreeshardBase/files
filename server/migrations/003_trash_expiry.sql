-- The expiry job (#138) looks for expired items across all members by deletion time.
CREATE INDEX trash_deleted_at ON trash(deleted_at);
