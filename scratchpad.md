# Freeshard Files Repository Working Memory

## Active Work & Verification Summary
- **Issue #93:** Bulk Direct Cloud-to-Cloud Backup Sync (`server/utils/cloud_to_cloud_sync.js`, `server/routes/cloud_sync.js`, `server/test/cloud_to_cloud_sync.test.js`) - PASSED (3/3)
- **Issue #94:** Collaborative Real-Time Presence & Folder Activity Indicators (`server/routes/presence.js`, `server/test/presence_tracking.test.js`) - PASSED (3/3)
- **Issue #95:** Secure Temporary Dropboxes / File Request Portals (`server/routes/file_requests.js`, `server/test/file_request_portal.test.js`) - PASSED (4/4)
- **Issue #96:** Automated Photo Metadata & EXIF Geolocation Extractor (`server/utils/exif_extractor.js`, `server/test/exif_extractor.test.js`) - PASSED (6/6)
- **Issue #97:** WebSockets Real-Time File System Change Push Notifications (`server/utils/sse_events.js`, `server/routes/events.js`, `server/test/sse_events.test.js`) - PASSED (3/3)
- **Issue #98:** High-Availability Storage Node Failover & Redundancy Gateway (`server/providers/failover.js`, `server/routes/storage.js`, `server/test/storage_failover.test.js`) - PASSED (4/4)
- **Issue #99:** Automated Compliance Retention & Legal Hold Policies (`server/routes/legal_hold.js`, `server/test/legal_hold.test.js`) - PASSED (5/5)
- **Issue #100:** Freeshard Ecosystem Universal Search & Cross-App Deep Links (`server/routes/search.js`, `server/test/universal_search.test.js`) - PASSED (4/4)
- **Issue #17:** Design Guide Alignment — Visual Identity & Responsive Theme (`public/css/app.css`) - PASSED (9/9): `--glass-bg/border/blur` vars, `.glass-panel` with `backdrop-filter`, `.micro-hover`, `.micro-bounce`, `@keyframes microPulse`
- **Issue #23:** Photo Gallery Mode — Dedicated Image-Centric Folder View (`server/utils/gallery.js`, `server/routes/files.js`, `server/test/file_viewer.test.js`) - PASSED (11/11): `IMAGE_MIME_TYPES`, `buildGalleryItems()`, `GET /api/files/gallery` endpoint

## Key Architectural Decisions & Patterns
- `searchUniversal(userId, query)` queries full-text file search (`files_fts`), public & internal file shares (`public_shares`, `file_shares`), user file tags (`file_tags`), and ecosystem ingest records (`ecosystem_ingest_log`).
- `GET /api/search/universal` returns categorized search results and formats cross-app deep links for Paperless, Immich, public shares, and files.
- `legal_holds` SQLite table tracks file retention policies, lock expiration dates, reasons, and active/released statuses.
- `checkActiveLegalHold(userId, path)` intercepts deletion (soft/trash/permanent) and file overwrites in `files.js` and `trash.js` returning HTTP 403 when active hold is present.
- `file_requests` SQLite table stores token, owner `user_id`, `target_folder`, expiration, and upload caps (`max_uploads`, `upload_count`).
- High-Availability `FailoverProvider` wraps primary and secondary storage nodes, automatically detecting I/O errors and falling back to replica storage while providing `GET /api/storage/health` telemetry.

## Suite Status
- Total Tests: 394 / 394 passing across 69 test suites.
- Backlog Completion: Issues #1–#100 implemented, tested, and verified.

