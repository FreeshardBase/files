-- A file request takes at most 1000 files (#401, `MAX_REQUEST_FILES`); a larger limit set before stands at the ceiling,
-- so the owner sees the limit in force and can save the request again.
UPDATE file_requests SET max_files = 1000 WHERE max_files > 1000;
-- A visitor's file whose upload was dropped before it was placed (overrun, expired) counts nowhere; it went with the
-- upload from now on (#401), and the ones left behind before go here.
DELETE FROM file_request_uploads WHERE placed_at IS NULL AND upload_id IS NOT NULL AND upload_id NOT IN (SELECT id FROM uploads);
