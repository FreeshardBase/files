# CONCEPTS

The theory this app is built on: what it is for, the rules that span modules, and the module map. Source of truth for scope is `docs/superpowers/specs/2026-10-14-files-rebuild-design.md`; later decisions are in `DECISIONS.md`. Where the code does not yet do what is written, the statement is the target and the gap is listed under *Known drift*. Recorded at the end of Phase B (2026-10-14).

## What the program is for

Files is a multi-cloud hub for the people of one shard: the owner (shard admin) and members, such as a family or a small team. It gives one interface over the shard's own storage and, later, the cloud accounts each member connects. Moving data from big-tech clouds onto the shard is a first-class flow.

- **Live, not mirrored.** Cloud files are shown live from the provider. Nothing is copied onto the shard unless the user explicitly copies or migrates it. There is no background two-way sync, so there are no sync conflicts.
- **Ownership.** Each member connects their own cloud accounts and only that member sees them. Sharing works the same for local and cloud files.
- **v1 scope** (spec §2.1): shard storage, Google Drive, Dropbox, OneDrive/SharePoint; browse, resumable transfer, migration, trash, versions, preview, search, sharing, WebDAV, PWA, three UI languages, the "Daylight Instrument" look.
- **Deferred, not rejected** (spec §2.2): tracked in one issue labelled `deferred`.
- **Built so far (Phase B):** OIDC login, deny-by-default, `resolveInRoot`, `LocalBackend`, the sources API, a Vue folder view with upload and download, E2E, container. Everything else in the spec is still ahead.
- **Fail fast.** Missing or invalid config stops the process at start-up (`exit(1)`); there are no fallback defaults.

## Identity model

- The only way in is the shard's OIDC provider: authorization code with PKCE. `state`, `nonce` and the verifier live server-side in a `login_attempts` row (cookie `__Host-fs_login`) and are single-use. A missing or mismatched value is rejected.
- Each person gets a stable internal user id (UUID), mapped from (`iss`, `sub`). Nothing is keyed by `sub`, display name or `X-Ptl-Client-Id` (a device id, not a person).
- The `admin` role comes from a configurable claim: `FILES_OIDC_ROLE_CLAIM` equal to / containing `FILES_OIDC_ADMIN_VALUE`. Everyone else is `member`. The pair is optional (both or neither); without it nobody is admin, because shard_core sends no role claim yet (freeshard#251).
- Sessions are rows in SQLite (only a hash of the id is stored), 14 days, revocable; the cookie is `__Host-fs_sid` on https and `fs_sid` on http loopback.
- Mutating requests need `Origin` equal to the public URL and an `X-CSRF-Token` matching the session. The token comes from `GET /api/v1/me`.
- There are no local accounts and no bypass. Dev, tests and E2E use the fake IdP in `server/test/support/fakeIdp.ts`. An `http://` issuer is accepted only for loopback.

## Sources and addressing

A file is identified by `{source, path}`. Only `home` (the member's own shard storage) exists today; `conn:<id>` (own cloud connection) and `share:<id>` (shared with me) come later. Every source route gets its backend and the caller's access (`read` or `edit`) from `resolveSource(req, source)` (`server/src/storage/resolveSource.ts`) before reading any input; no route builds a backend itself, and mutating routes answer `FORBIDDEN` without `edit`. An unknown or malformed source id is `SOURCE_NOT_FOUND` (404), never a fallback to `home` (#95). The API is one route family under `/api/v1/sources/:source/`: `list`, `stat`, `content` (GET with Range, PUT streaming upload), `mkdir`, `move` (also rename), `copy`, `delete` (to the trash), `zip` (a folder or a selection in one folder as a streamed ZIP), `thumbnail`; plus `/api/v1/trash` (list, `restore`, `delete`, `empty`; the home's local trash), `/api/v1/uploads` (resumable uploads over tus 1.0, see below), `/api/v1/recent` (the caller's recent items), `/api/v1/me`, `/auth/*` and `/healthz`. Errors are `{ code, params }`; codes and HTTP statuses live in `shared/` and the client translates them.

All data-root locations (`files.db`, `homes/<userId>`, `thumbs/`) are derived in `server/src/paths.ts`.

Content is served inline only for an allowlist (images except SVG, video, audio, PDF, `text/plain`) with `Content-Security-Policy: sandbox`; everything else is an attachment. The MIME type comes from the extension only (`storage/mime.ts`), never from the bytes.

The preview overlay (#142) loads files through that same content route. Images, video and audio point their element at it. PDFs are drawn by pdf.js on a canvas, because the browser's own viewer refuses a sandboxed document. Text and Markdown are fetched with a Range request capped at 512 KiB. Markdown is parsed by markdown-it with raw HTML off, and `web/src/markdown.ts` builds Vue nodes from an allowlist of elements, so no HTML string ever reaches the DOM and no image is loaded. The SPA picks the viewer from the listed `mime` (`web/src/preview.ts`), and the server's allowlist stays the guard.

Thumbnails (#144) come from `thumbnail` (`size` 128, 256 or 512): a WebP whose longer side has that many pixels. Local ones are generated on first request (`storage/thumbnails.ts`): images by `sharp` in the process, a video frame by ffmpeg, a PDF's first page by `pdftoppm`. Tools get only the absolute path from `resolveInRoot` in an argument array without a shell (after `--`, or as `file:` with a fixed demuxer and only the file protocol), with a time limit and at most two generators at once. They are cached under `<DATA_DIR>/thumbs/` (`paths.ts`), outside every home, with one `thumbnails` row each; a row whose source ETag changed is regenerated, the least recently used ones go once the cache exceeds its cap, and every write, move or delete through the app drops the thumbnails of the paths it touched. Cloud backends will proxy the provider's thumbnail through `StorageBackend.thumbnail?`. The folder view shows them in the list and in the gallery view, whose tiles open the preview overlay as the lightbox.

A ZIP download is built while it is sent. It walks only the backend's own `list` and `read`, so it holds exactly what a listing shows: no symlinks, no `.files/`, no temp files. Entries are stored, every file is ZIP64 with a data descriptor, and names are relative and UTF-8. Nothing is buffered or written to disk except the central directory. An error after the first byte aborts the response instead of ending a short archive.

## Storage interface

All file access goes through `StorageBackend` (`server/src/storage/backend.ts`): `list`, `stat`, `read` (with range; returns the `Entry`, the stream and the ETag in one call, resolving the range against the opened file's size), `write` (streaming, with a collision policy, a byte limit, an optional declared `size` and an optional `ifMatch` ETag), `mkdir`, `move`, `copy` (both with a collision policy) and `delete` (a batch, to the trash). `LocalBackend` implements it on `<DATA_DIR>/homes/<userId>`, together with a `HomeIndex` (the database, the user id and the path-dependent tables). Every path passes `resolveInRoot(root, userPath)`:

- it rejects NUL and control characters, bidi controls, ill-formed UTF-16, `..` segments, absolute paths and over-long paths;
- it `lstat`s every existing component and rejects symlinks;
- it `realpath`s the deepest existing ancestor and checks it lies under the root with a trailing separator.

Writes stream into a hidden temp file `.<16hex>.upload` in the target directory, are `fsync`ed and then renamed (or hard-linked for "keep both"/"fail if exists"). The target directory is `fsync`ed after that, so the new entry survives a crash. "Fail if exists" answers `FILE_EXISTS` with the taken `name` in `params` before the body is read, so the SPA can ask the collision question without uploading twice. "Keep both" names are `name (n).ext`, starting at `(1)`, within 255 bytes, cut at whole characters; the extension is dropped only when not even one character of the name fits before it. Temp files left behind by a crash are removed by a sweep over every home in an `onReady` hook, so it finishes before the server listens; it removes only regular files with exactly that name and never follows symlinks. `<root>/.files/` is reserved for trash, copy staging (`tmp/`), resumable uploads (`uploads/`) and versions and cannot be addressed by users; the backend reaches it only through `resolveInRoot`.

Resumable uploads (tus 1.0: creation, `HEAD`, `PATCH`, termination, expiration) collect their bytes in `<home>/.files/uploads/<id>`; an `uploads` row holds the target, the declared length, the collision policy, the expiry and `received`, the bytes fsynced so far. Everything that can be refused is refused at creation, before a byte exists: the size limit, the quota, the path, a folder in the way and, under `fail`, a taken name. A `PATCH` continues exactly at `received`, never stores more than declared (a client that sends more loses the whole upload), and records what arrived even when the connection drops. Once all bytes are in, they are renamed into place with the policy in the transaction that deletes the row, creating missing parent folders (folder upload); a name taken meanwhile answers `FILE_EXISTS` and keeps the bytes for `finish`. Ids are looked up with the member, so another member's upload is 404. Uploads idle for 24 hours are removed by an hourly job.

A member may have a quota (`users.quota_bytes`; none by default). Usage is everything under the home, trash and staged uploads included, plus what the member's open uploads still have to send. Uploads (tus and `PUT content`) are checked against it before they start and while they stream.

Moves, deletes and "replace" run in one SQLite `BEGIN IMMEDIATE` transaction around synchronous renames, which are undone in reverse if anything after them fails, so files and rows never disagree (spec §3.6). "Replace" sends the old item to the trash, never deletes it. Delete renames the item to `.files/trash/<id>` and writes a `trash` row; a batch is all or nothing. A folder never moves or copies into itself or a descendant (`TARGET_INSIDE_SOURCE`). Copies are built in `.files/tmp/` with `copyFile` (kernel copy, no buffer) and renamed into place; the startup sweep empties `.files/tmp/`. Rows that point at home paths (today `recent`; later shares, favourites, search, versions) are listed in `PATH_TABLES` (`server/src/storage/pathRefs.ts`): a move rewrites the item's rows and those beneath it, a delete removes them, in the same transaction. Rows still pointing at a move's free target are stale (changed outside the app) and give way first.

Recent: every write in the home (upload by `PUT` or tus, copy, move, rename, restore) records the item it placed in a `recent` row of its member, inside the write's transaction (`server/src/storage/recent.ts`). Writing a path again moves it to the top; each member keeps the newest 100. `GET /api/v1/recent` lists only the caller's own rows, newest first; there is no feed of other members' actions.

The trash is part of the home, so trashed bytes count towards the member's usage until purged. A trash row holds the original path, type, size (a folder's whole tree) and deletion time. Restore puts one item back at its original path through `resolveInRoot`, recreating missing parents, with the move's collision rules (never a silent overwrite). `LocalBackend.purge` is the only way out of the trash, for single delete, "empty trash" and expiry alike: bytes first, then the row and the rows in `TRASH_TABLES` in one transaction; if the bytes stay, the row stays, the error is logged and the caller sees the item as failed (`PURGE_FAILED`). The expiry job (`server/src/storage/trash.ts`) runs after start-up and hourly and purges what is older than `FILES_TRASH_RETENTION_DAYS` (default 30). Names that are not canonical on disk (NFD, control characters, invalid UTF-8) are skipped in listings. No code outside this layer builds filesystem paths, and no backend holds a whole file in memory.

## Deny by default

A global `onRequest` hook (`server/src/auth/guard.ts`) loads the session and then decides on the matched route. Every matched route needs a session, and a mutating one also the CSRF check, unless the route carries `config: { public: true }`. The allowlist is `/auth/login`, `/auth/callback`, `/healthz`, the SPA fallback and the static assets; the static plugin is registered in its own encapsulated scope whose `onRoute` hook marks exactly its routes public. Unmatched requests go to the not-found handler, which answers 401 without a session and 404 with one. Raw `req.url` is never used for a security decision, because the router decodes escapes (`/%61pi/`). `server/test/routeInventory.test.ts` walks the whole route table to enforce this.

A failed login (missing or expired attempt, state mismatch, IdP `error=`, failed code exchange) redirects to `/?loginError=1`; the reason is logged, never put in the URL. The SPA then shows `LOGIN_FAILED` with a link to sign in again instead of redirecting to login. Once `/api/v1/me` has answered, it replaces the URL without `loginError` (no reload), so a reload signs in normally instead of repeating the alert.

## Web addressing

SPA URLs are `/<source>/<folder path…>`; today only `/home/…` is routed and `/` redirects to `/home`. The source segment keeps folder names such as `api` or `auth` from colliding with server routes on reload, and leaves room for `conn:<id>` and `share:<id>`. The folder store holds the current `source` and builds every request from it (`web/src/api/paths.ts`).

## Module map

### `shared/src`

| File | Purpose |
| :--- | :--- |
| `index.ts` | Re-exports the shared contract. |
| `errors.ts` | Error code list and code to HTTP status map. |
| `entries.ts` | Zod schemas and types for `Entry`, list responses, `CollisionPolicy`, `Me`. |

### `server/src`

| File | Purpose |
| :--- | :--- |
| `main.ts` | Process entry: crash handlers, config load, data-dir ownership and privilege drop, DB open, listen, graceful shutdown. |
| `dataDir.ts` | Started as root: chowns the data dir itself (never its contents) and drops to uid 1000. Then checks the dir, `files.db` and `homes/` are writable, or exits 1. |
| `dev.ts` | Dev entry: starts the fake IdP on :4000, sets dev env, imports `main.ts`. |
| `app.ts` | `buildApp`: Fastify with logging, helmet, cookies, guard, routes, public static assets and SPA fallback. |
| `config.ts` | Zod-validated config from `FILES_*` env; throws `ConfigError`, no defaults for secrets. |
| `db.ts` | Opens SQLite (WAL) and applies `server/migrations/NNN_name.sql` in order. Each one is checked and applied in one `BEGIN IMMEDIATE` transaction, so processes starting at the same time apply it once. |
| `errors.ts` | `AppError` and the one error handler that maps errors to status and code (framework 4xx by the code that owns the status). |
| `paths.ts` | The single data-root module: `dbPath`, `homesDir`, `homeRoot`, `thumbsDir`. |
| `users.ts` | Upserts users from OIDC claims (`iss`, `sub`) and looks them up by internal id. |
| `auth/cookies.ts` | Chooses `__Host-` or plain cookie names from the public URL scheme. |
| `auth/guard.ts` | Deny-by-default hook, session loading, CSRF checks, `requireUser`. |
| `auth/oidc.ts` | `openid-client` wrapper: discovery, authorization URL, code exchange, PKCE helpers. |
| `auth/routes.ts` | `/auth/login`, `/auth/callback` (failures redirect to `/?loginError=1`), `/auth/logout`, `/api/v1/me`, safe `returnTo`. |
| `auth/sessions.ts` | Session and login-attempt rows (hashed ids, TTLs, single-use take, purge). |
| `http/range.ts` | Parses a `Range` header into a byte range or `unsatisfiable`. Invalid specs (first > last, multi-range, other units) are ignored: whole file, 200. |
| `routes/sources.ts` | The sources API: list, stat, content GET/PUT, mkdir, move, copy, delete, zip, thumbnail; content-type gate and inline allowlist. |
| `storage/thumbnails.ts` | `ThumbnailCache`: lazy generation (sharp, ffmpeg, pdftoppm; time limit, bounded concurrency, file paths only as guarded arguments), the cache under `thumbs/` with ETag check, LRU eviction under the cap, `forget` for writes/moves/deletes, and the startup sweep. |
| `storage/zip.ts` | `zipStream`: a folder walk over any `StorageBackend` as a streamed, stored ZIP64 archive. |
| `routes/trash.ts` | The trash API: list (with total size and retention), restore one item, delete permanently, empty. |
| `storage/trash.ts` | The expiry job: `expireTrash` (through `LocalBackend.purge`) and its hourly schedule. |
| `routes/uploads.ts` | tus 1.0 under `/api/v1/uploads`: `OPTIONS`, creation, `HEAD`, `PATCH` (stream gate before any parser), termination, and `finish` for a name taken at the end. |
| `storage/uploads.ts` | The upload expiry job: `expireUploads` (through `LocalBackend.expireUploads`) and its hourly schedule. |
| `schedule.ts` | `every`: run now and then periodically, skip a tick while a run is in flight, wait for it on stop. |
| `storage/backend.ts` | The `StorageBackend` interface, write options, `RangeNotSatisfiable`. |
| `storage/resolveSource.ts` | `resolveSource`: source id to backend and access level; `conn:`/`share:` extension points; `homeBackend` for the trash routes. |
| `storage/local.ts` | `LocalBackend`, fs error mapping, atomic streaming writes; move, copy and trash in one transaction with undoable renames; trash list, restore and the one purge; resumable uploads (create, append, place, terminate, expire) and the quota. |
| `routes/recent.ts` | `GET /api/v1/recent`: the caller's own recent items. |
| `storage/recent.ts` | `recordRecent` (called inside every home write's transaction, capped per member) and `recentItems`. |
| `storage/pathRefs.ts` | `PATH_TABLES` and the move/delete cascade for rows that point at home paths; `TRASH_TABLES` purged with a trash row. |
| `storage/resolveInRoot.ts` | The only place user paths become filesystem paths. |
| `storage/mime.ts` | Extension to MIME lookup (no sniffing); the inline allowlist and the SPA's preview choice both read it. |
| `storage/uploadSweep.ts` | Startup sweep that removes orphaned `.<16hex>.upload` temp files and interrupted copies in `.files/tmp/` from every home. |

### `web/src`

| File | Purpose |
| :--- | :--- |
| `main.ts` | SPA entry: Pinia, router, i18n, `<html lang>` sync. |
| `App.vue` | Shell: header, source sidebar (My storage, Recent, Trash), upload panel, session load, startup error, failed-login alert. |
| `router.ts` | `/:source(home)/:path…` to the folder view, `/recent` to the recent view, `/trash` to the trash view; `/` and unknown paths redirect to `/home`. |
| `views/RecentView.vue` | Recent: the member's own recent items, newest first, each with "Open folder"; its own empty state. |
| `stores/recent.ts` | Pinia store for `/api/v1/recent`. |
| `views/TrashView.vue` | The trash: list, restore (collision dialog), delete permanently and empty trash (both confirmed). |
| `stores/trash.ts` | Pinia store for `/api/v1/trash`. |
| `components/ConfirmDialog.vue` | Confirmation before an irreversible action; Cancel has the focus, Esc cancels. |
| `format.ts` | `Intl`-based size and date formatting. |
| `env.d.ts` | Type shims for `.vue` and Vite `?url` imports. |
| `api/client.ts` | Handwritten fetch wrapper: CSRF header, error codes as `ApiFailure`, redirect to login on 401 (not while `loginError=1`); `rawRequest` for answers in headers, `sendXhr` for upload progress. |
| `api/tus.ts` | `ResumableUpload`: tus client with 8 MiB chunks, `HEAD` before every retry, pause, discard, and resume after a reload through localStorage. |
| `stores/uploads.ts` | Pinia store for the upload queue: one item at a time, collision question, pause/resume/cancel/retry, per-pick summary for the status line. |
| `components/UploadPanel.vue` | The upload panel: progress per file, item actions, one failure summary with "Retry all", the collision dialog for uploads. |
| `api/paths.ts` | `sourceApi(source)` for API URLs, `downloadHref` (one file as itself, else a ZIP) and `folderRoute(source, path)` for SPA URLs. |
| `stores/session.ts` | Pinia store for `/api/v1/me`. |
| `stores/folder.ts` | Pinia store for the current folder and its source: list, mkdir, move/copy, trash, the move/copy clipboard, race-free loading. |
| `views/FolderView.vue` | The folder page: breadcrumbs, list/gallery toggle (kept in localStorage), upload (pick or desktop drop, into the uploads store), selection bar, list or gallery, states; one collision loop for move and copy. |
| `components/FileList.vue` | File table with roving tabindex, arrow keys, selection (Space, Ctrl/Shift+click), F2, Delete, Ctrl+C/X/V, row action menus and drag & drop onto folders. Enter or a click on a file's name opens the preview; the link itself still downloads (new tab, save link as). |
| `components/PreviewDialog.vue` | The preview overlay on `<AppDialog>`: one file of the folder at a time, ←/→ and Previous/Next, Download, Esc/Close; reports the file shown last so its row gets the focus back. |
| `components/GalleryGrid.vue` | The gallery view: a tile per entry with its thumbnail or line icon; a folder tile opens the folder, a file tile the preview overlay (the lightbox). |
| `components/PdfView.vue` | pdf.js on a canvas, one page at a time, worker from the app's origin, loaded only when a PDF is opened. |
| `components/MarkdownView.vue` | Renders a Markdown source through `markdown.ts`. |
| `markdown.ts` | markdown-it tokens to Vue nodes: allowlisted elements, raw HTML as text, http(s)/mailto links only (new tab, no referrer), images as their alt text. |
| `preview.ts` | `previewKind` (MIME to viewer), `contentHref`, `hasThumbnail`/`thumbnailHref`, and `fetchText` (Range-capped text fetch). |
| `components/ItemMenu.vue` | A row's action menu (menu button pattern); the touch path to every action. |
| `components/RenameDialog.vue` | New name for one item, stem preselected. |
| `dnd.ts` | Drag & drop payload of list items (own MIME type); desktop drops of files and folders (entries walked recursively). |
| `components/Breadcrumbs.vue` | Path navigation; every crumb is a drop target. |
| `components/UploadButton.vue` | File picker and folder picker emitting chosen files with their relative path; exposes the file input as the focus target for dialogs it causes. |
| `components/AppDialog.vue` | The only dialog primitive (lint-enforced): `role="dialog"`, `aria-modal`, labelled title, focus trap, inert background, root scroll lock, Esc emits `close`, focus restored on unmount. |
| `components/CollisionDialog.vue` | Replace / keep both / skip for one taken name, with "apply to all remaining"; Esc skips this item only. Used by upload, rename, move, copy and restore. |
| `i18n/index.ts` | vue-i18n setup and `resolveLocale` (stored, browser, default Deutsch Du). |
| `i18n/htmlLang.ts` | Keeps `<html lang>` in step with the locale. |
| `i18n/de-du.json`, `de-sie.json`, `en.json` | The three UI languages; every key in every file. |
| `styles/tokens.css` | Design tokens from the guide, light and dark. |
| `styles/components.css` | Component recipes from the guide. |
| `styles/app.css` | Fonts, layout, mask-based line icons. |

## Known drift

- Only the `home` source exists; `conn:` and `share:` are parsed by `resolveSource` but answer `SOURCE_NOT_FOUND` until #148 and #146.
- No locale setting or platform preference yet (freeshard#168); the language comes from the browser or a stored choice.
- No moves between sources (#152), no versions, search, sharing or WebDAV. Thumbnails exist only for the home; cloud ones come with #149–#151. Move and copy within a source are direct requests, not the persistent jobs of spec §3.4. See spec §2.1 and the Phase D queue.
- The details drawer and the transfer part of the spec §3.8 panel are not built; the upload panel is.
- Routes Zod-parse params, query and body, but there are no Zod response schemas and no generated OpenAPI document (spec §3.3).
- The web API client is handwritten (`web/src/api/client.ts`), not generated from `shared/` (spec §3.8).
- No fake cloud-provider server scaffold exists yet (spec §3.9, Phase B); it arrives with the first cloud backend.
- The per-member quota (`users.quota_bytes`) has no admin page yet (storage overview), so it is unset unless written to the database. Copies within the home are not checked against it, only uploads.
- Recent covers only the home; cloud sources add their provider's recent files with #149–#151. A row whose file was changed outside the app (not through it) stays until that path is written, moved or deleted through the app.
- tus uploads can target only `home`; a cloud or shared target needs its own placement once those sources exist (#146, #148).
