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

A file is identified by `{source, path}`. Only `home` (the member's own shard storage) exists today; `conn:<id>` (own cloud connection) and `share:<id>` (shared with me) come later. Every source route gets its backend and the caller's access (`read` or `edit`) from `resolveSource(req, source)` (`server/src/storage/resolveSource.ts`) before reading any input; no route builds a backend itself, and mutating routes answer `FORBIDDEN` without `edit`. An unknown or malformed source id is `SOURCE_NOT_FOUND` (404), never a fallback to `home` (#95). The API is one route family under `/api/v1/sources/:source/`: `list`, `stat`, `content` (GET with Range, PUT streaming upload), `mkdir`, `move` (also rename), `copy`, `delete` (to the trash); plus `/api/v1/me`, `/auth/*` and `/healthz`. Errors are `{ code, params }`; codes and HTTP statuses live in `shared/` and the client translates them.

All data-root locations (`files.db`, `homes/<userId>`) are derived in `server/src/paths.ts`.

Content is served inline only for an allowlist (images except SVG, video, audio, PDF, `text/plain`) with `Content-Security-Policy: sandbox`; everything else is an attachment.

## Storage interface

All file access goes through `StorageBackend` (`server/src/storage/backend.ts`): `list`, `stat`, `read` (with range; returns the `Entry`, the stream and the ETag in one call, resolving the range against the opened file's size), `write` (streaming, with a collision policy, a byte limit, an optional declared `size` and an optional `ifMatch` ETag), `mkdir`, `move`, `copy` (both with a collision policy) and `delete` (a batch, to the trash). `LocalBackend` implements it on `<DATA_DIR>/homes/<userId>`, together with a `HomeIndex` (the database, the user id and the path-dependent tables). Every path passes `resolveInRoot(root, userPath)`:

- it rejects NUL and control characters, bidi controls, ill-formed UTF-16, `..` segments, absolute paths and over-long paths;
- it `lstat`s every existing component and rejects symlinks;
- it `realpath`s the deepest existing ancestor and checks it lies under the root with a trailing separator.

Writes stream into a hidden temp file `.<16hex>.upload` in the target directory, are `fsync`ed and then renamed (or hard-linked for "keep both"/"fail if exists"). The target directory is `fsync`ed after that, so the new entry survives a crash. "Fail if exists" answers `FILE_EXISTS` with the taken `name` in `params` before the body is read, so the SPA can ask the collision question without uploading twice. "Keep both" names are `name (n).ext`, starting at `(1)`, within 255 bytes, cut at whole characters; the extension is dropped only when not even one character of the name fits before it. Temp files left behind by a crash are removed by a sweep over every home in an `onReady` hook, so it finishes before the server listens; it removes only regular files with exactly that name and never follows symlinks. `<root>/.files/` is reserved for trash, copy staging (`tmp/`) and versions and cannot be addressed by users; the backend reaches it only through `resolveInRoot`.

Moves, deletes and "replace" run in one SQLite `BEGIN IMMEDIATE` transaction around synchronous renames, which are undone in reverse if anything after them fails, so files and rows never disagree (spec §3.6). "Replace" sends the old item to the trash, never deletes it. Delete renames the item to `.files/trash/<id>` and writes a `trash` row; a batch is all or nothing. A folder never moves or copies into itself or a descendant (`TARGET_INSIDE_SOURCE`). Copies are built in `.files/tmp/` with `copyFile` (kernel copy, no buffer) and renamed into place; the startup sweep empties `.files/tmp/`. Rows that point at home paths (shares, favourites, search, versions; none exist yet) are listed in `PATH_TABLES` (`server/src/storage/pathRefs.ts`): a move rewrites the item's rows and those beneath it, a delete removes them, in the same transaction. Names that are not canonical on disk (NFD, control characters, invalid UTF-8) are skipped in listings. No code outside this layer builds filesystem paths, and no backend holds a whole file in memory.

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
| `paths.ts` | The single data-root module: `dbPath`, `homesDir`, `homeRoot`. |
| `users.ts` | Upserts users from OIDC claims (`iss`, `sub`) and looks them up by internal id. |
| `auth/cookies.ts` | Chooses `__Host-` or plain cookie names from the public URL scheme. |
| `auth/guard.ts` | Deny-by-default hook, session loading, CSRF checks, `requireUser`. |
| `auth/oidc.ts` | `openid-client` wrapper: discovery, authorization URL, code exchange, PKCE helpers. |
| `auth/routes.ts` | `/auth/login`, `/auth/callback` (failures redirect to `/?loginError=1`), `/auth/logout`, `/api/v1/me`, safe `returnTo`. |
| `auth/sessions.ts` | Session and login-attempt rows (hashed ids, TTLs, single-use take, purge). |
| `http/range.ts` | Parses a `Range` header into a byte range or `unsatisfiable`. Invalid specs (first > last, multi-range, other units) are ignored: whole file, 200. |
| `routes/sources.ts` | The sources API: list, stat, content GET/PUT, mkdir; content-type gate and inline allowlist. |
| `storage/backend.ts` | The `StorageBackend` interface, write options, `RangeNotSatisfiable`. |
| `storage/resolveSource.ts` | `resolveSource`: source id to backend and access level; `conn:`/`share:` extension points. |
| `storage/local.ts` | `LocalBackend`, fs error mapping, atomic streaming writes; move, copy and trash in one transaction with undoable renames. |
| `storage/pathRefs.ts` | `PATH_TABLES` and the move/delete cascade for rows that point at home paths. |
| `storage/resolveInRoot.ts` | The only place user paths become filesystem paths. |
| `storage/mime.ts` | Extension to MIME lookup. |
| `storage/uploadSweep.ts` | Startup sweep that removes orphaned `.<16hex>.upload` temp files and interrupted copies in `.files/tmp/` from every home. |

### `web/src`

| File | Purpose |
| :--- | :--- |
| `main.ts` | SPA entry: Pinia, router, i18n, `<html lang>` sync. |
| `App.vue` | Shell: header, session load, startup error, failed-login alert. |
| `router.ts` | `/:source(home)/:path…` to the folder view; `/` and unknown paths redirect to `/home`. |
| `format.ts` | `Intl`-based size and date formatting. |
| `env.d.ts` | Type shim for `.vue` imports. |
| `api/client.ts` | Handwritten fetch wrapper: CSRF header, error codes as `ApiFailure`, redirect to login on 401 (not while `loginError=1`). |
| `api/paths.ts` | `sourceApi(source)` for API URLs and `folderRoute(source, path)` for SPA URLs. |
| `stores/session.ts` | Pinia store for `/api/v1/me`. |
| `stores/folder.ts` | Pinia store for the current folder and its source: list, upload, mkdir, move/copy, trash, the move/copy clipboard, race-free loading. |
| `views/FolderView.vue` | The folder page: breadcrumbs, upload, selection bar, list, states; one collision loop for upload, move and copy. |
| `components/FileList.vue` | File table with roving tabindex, arrow keys, selection (Space, Ctrl/Shift+click), F2, Delete, Ctrl+C/X/V, row action menus and drag & drop onto folders. |
| `components/ItemMenu.vue` | A row's action menu (menu button pattern); the touch path to every action. |
| `components/RenameDialog.vue` | New name for one item, stem preselected. |
| `dnd.ts` | Drag & drop payload of list items (own MIME type). |
| `components/Breadcrumbs.vue` | Path navigation; every crumb is a drop target. |
| `components/UploadButton.vue` | File picker emitting chosen files; exposes its input as the focus target for dialogs it causes. |
| `components/AppDialog.vue` | The only dialog primitive (lint-enforced): `role="dialog"`, `aria-modal`, labelled title, focus trap, inert background, root scroll lock, Esc emits `close`, focus restored on unmount. |
| `components/CollisionDialog.vue` | Replace / keep both / skip for one taken name, with "apply to all remaining"; Esc skips this item only. Used by upload, rename, move and copy; restore later. |
| `i18n/index.ts` | vue-i18n setup and `resolveLocale` (stored, browser, default Deutsch Du). |
| `i18n/htmlLang.ts` | Keeps `<html lang>` in step with the locale. |
| `i18n/de-du.json`, `de-sie.json`, `en.json` | The three UI languages; every key in every file. |
| `styles/tokens.css` | Design tokens from the guide, light and dark. |
| `styles/components.css` | Component recipes from the guide. |
| `styles/app.css` | Fonts, layout, mask-based line icons. |

## Known drift

- Only the `home` source exists; `conn:` and `share:` are parsed by `resolveSource` but answer `SOURCE_NOT_FOUND` until #148 and #146.
- No locale setting or platform preference yet (freeshard#168); the language comes from the browser or a stored choice.
- No trash view, restore or expiry (#138), no moves between sources (#152), no versions, thumbnails, search, sharing or WebDAV. Move and copy within a source are direct requests, not the persistent jobs of spec §3.4. See spec §2.1 and the Phase D queue.
- The details drawer and transfer panel from spec §3.8 are not built.
- Routes Zod-parse params, query and body, but there are no Zod response schemas and no generated OpenAPI document (spec §3.3).
- The web API client is handwritten (`web/src/api/client.ts`), not generated from `shared/` (spec §3.8).
- No fake cloud-provider server scaffold exists yet (spec §3.9, Phase B); it arrives with the first cloud backend.
- Uploads are checked against `FILES_MAX_UPLOAD_BYTES` only; there is no per-member quota check before an upload is accepted (spec §3.7).
