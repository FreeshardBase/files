# DECISIONS

Dated decisions, newest last. The spec is `docs/superpowers/specs/2026-10-14-files-rebuild-design.md`; this file records what was decided after or beside it.

## 2026-10-14: rebuild in the same repo

The rebuild happens in this repository, so history and issues stay. The old tree is kept at tag `archive/gemini-2026-10-14` and is reference only.

## 2026-10-14: no local accounts, no bypass

There are no local accounts and no auth bypass. Development, tests and E2E sign in through a fake OIDC provider (`server/test/support/fakeIdp.ts`) using the real login flow.

## 2026-10-14: admin role from a configurable claim

The admin role comes from the claim named in `FILES_OIDC_ROLE_CLAIM` matching `FILES_OIDC_ADMIN_VALUE`. The claim that shard_core will send (freeshard#147-149) is not fixed yet, so it is configuration, not code.

## 2026-10-14: locale has no platform source yet

The platform preference for language does not exist yet (freeshard#168). `resolveLocale` takes the parameter once the source exists.

## 2026-10-14: deferred features in one issue

Features deferred by spec §2.2 are tracked in one issue labelled `deferred`, which links each to its old issue.

## 2026-10-14: deny-by-default is route-based

The guard decides on the matched route pattern (`req.routeOptions.url`), not on the raw URL. Review found that `/%61pi/...` bypassed a `startsWith('/api/')` check on `req.url`, because the router decodes the path. The SPA fallback likewise decides on the decoded pathname.

## 2026-10-14: `__Host-` session cookies

On https the cookies are `__Host-fs_sid` and `__Host-fs_login` (Secure, Path=/, no Domain). Sibling apps on the same shard domain could otherwise toss cookies into Files. Plain names are used only on http loopback, where browsers reject Secure cookies.

## 2026-10-14: returnTo is same-origin only

`returnTo` after login must be a same-origin path. Dot segments and `//` prefixes are rejected, and anything unparsable falls back to `/`. This closes open redirects through the login flow.

## 2026-10-14: inline content only from an allowlist

File content is served inline only for images (not SVG), video, audio, PDF and `text/plain`, always with `Content-Security-Policy: sandbox`. Everything else is an attachment. HTML, SVG and XML in a user's folder must never run in the app's origin.

## 2026-10-14: non-canonical names are skipped in listings

On-disk names that are not canonical (NFD-normalised, containing control characters, or invalid UTF-8) are skipped in listings. They cannot round-trip through the API's path rules, so showing them would offer entries the user cannot open.

## 2026-10-14: upload content-type gate before body parsing

The upload route checks the content type (`application/octet-stream`) in `onRequest`, before any body parser runs. Otherwise a JSON or text content type would make Fastify buffer the whole body in memory, which is a denial of service.

## 2026-10-14: TypeScript pinned to 6.x

TypeScript stays on 6.x until typescript-eslint supports 7. Lint is part of the gate, so the compiler cannot get ahead of it.

## 2026-10-14: pnpm 12 with `allowBuilds`

The workspace uses pnpm 12. Dependency build scripts are denied unless listed under `allowBuilds` in `pnpm-workspace.yaml`, so a new native dependency needs an explicit, reviewed entry.

## 2026-10-15: encryption key derived from a shard secret

The shard's app template can only fill in `{{ secret('…') }}` (32 characters of `[A-Za-z0-9]`), so `FILES_ENCRYPTION_KEY` takes any secret of at least 32 characters. Startup refuses a shorter one. The AES-256 key is derived with HKDF-SHA256, using salt `freeshard-files`, info `files/encryption-key/v1` and 32 bytes of output (`server/src/config.ts`). A base64 key from before this change is still accepted, but it is now treated as a secret and hashed, so it yields a different key. Nothing has been deployed and nothing has been encrypted yet, so there is no migration path. Changing the salt or info later would orphan encrypted refresh tokens and needs a versioned re-encryption.

## 2026-10-15: admin role claim is optional

shard_core's OIDC provider sends `sub`, `name`, `preferred_username` and `email`, but no role claim, so the app template cannot fill in `FILES_OIDC_ROLE_CLAIM` / `FILES_OIDC_ADMIN_VALUE`. Both variables are now optional, but only as a pair: setting one without the other refuses to start. Without them every login maps to `member` and admin-only features stay unavailable (least privilege). An earlier admin is demoted on their next login, because the role is written on every login. Guessing a claim or making the first user admin would grant rights the platform never asserted. Once freeshard#251 lands, the template sets the claim (`freeshard_role` = `owner`).

## 2026-10-15: startup sweep of upload temp files

Question: where does the sweep run, which homes does it visit, and how does it handle errors? It runs in an `onReady` hook in `buildApp`, because both `listen()` and `inject()` wait for that hook. No request can arrive before it finishes, and the test harness exercises the same path. It visits every directory under `homes/` (`paths.ts`), not only the users in the database, so a home whose user row is gone is cleaned too. It recurses into `.files/` as well, since temp files are swept wherever they sit. #140 must therefore not store resumable tus state under the `.<16hex>.upload` name. Only regular files that match exactly are removed; symlinks are neither followed nor removed. An unreadable directory or a failed unlink is logged at warn with the home id and the home-relative path, and the sweep goes on. A sweep failure does not stop startup, because a leftover temp file only wastes disk space. The info line carries only the counts `removed` and `failed`.

## 2026-10-15: start as root, chown only `/data`, drop to uid 1000 in Node

On a shard the Docker daemon creates the `/data` bind mount as root, and the image used to run as `node`, so Files could not write there. `user: 0:0` in the app template would run the whole server as root, so the image now has no `USER`. `main.ts` checks whether it is uid 0. If it is, it chowns `/data` to 1000:1000, plus any parents it had to create, and never recurses into existing contents. Then it calls `setgroups`/`setgid`/`setuid` and verifies the drop, all before the database or any route exists. Doing this in Node rather than in a shell entrypoint with `gosu`/`setpriv` adds no package. It keeps one process as PID 1, so SIGTERM handling is unchanged, and the steps can be unit-tested (`server/test/dataDir.test.ts`). A container started as a non-root user skips the root step. Either way, startup then checks that `/data`, `files.db` and `homes/` are writable, and exits 1 naming the path if they are not. Leftovers owned by root from an earlier root run need a one-time `chown -R` on the host. Chowning them on every start would be slow on large trees and would silently rewrite ownership of user data.

## 2026-10-15: login-error cleanup, concurrent migrations, keep-both names (#134)

Question: when does the SPA drop `?loginError=1`, what does a second process do with a migration that another one is applying, and what does "keep both" do with an extension that does not fit?

The SPA drops the flag only after `/api/v1/me` has answered. The 401 handler skips the login redirect while the flag is in the URL, so dropping it earlier would bring the redirect loop back. It uses `router.replace` (history replace, no reload).

Each migration is checked and applied inside one `BEGIN IMMEDIATE` transaction. A second process waits on the lock (`busy_timeout`), then finds the migration recorded, so both start. Failing loudly would also be safe, but it would turn a routine overlapping start, such as a restart, into a crash.

"Keep both" keeps `name (n).ext` within 255 bytes and cuts the stem at whole code points. If not even one character of the stem fits before the extension, the extension is treated as part of the name and the whole name is cut. Cutting the extension instead would make up a file type the original never had.

## 2026-10-15: one `resolveSource`, conditional and sized writes, one-trip reads (#135)

Question: what source ids are valid, what answers an unknown one, where is access checked, and what do the new `write` options `size` and `ifMatch` mean?

`resolveSource(req, source)` in `server/src/storage/resolveSource.ts` is the only place a source id becomes a backend and an access level. The grammar is exact: `home`, `conn:<id>` or `share:<id>` with `<id>` of 1–64 characters from `[A-Za-z0-9_-]`. Nothing is normalised, so `HOME`, `home:<userId>`, a bare user id, an empty id or an unknown prefix are all `SOURCE_NOT_FOUND` (404), never the caller's home (#95). A malformed id gets the same answer as an unknown one, so it reveals nothing about which ids exist. `conn:` and `share:` answer `SOURCE_NOT_FOUND` until #148 and #146 fill them in. `home` is always the caller's own home with `edit`. Every source route resolves its source before it reads any input, and the mutating ones (`PUT content`, `mkdir`) answer `FORBIDDEN` (403) unless the access is `edit`. A framework 404 still maps to the generic `NOT_FOUND`, because only `resolveSource` throws `SOURCE_NOT_FOUND`.

`ifMatch` is allowed only with `onCollision: replace` (otherwise `VALIDATION`): a conditional write replaces exactly the version the client saw, and "fail" or "keep both" would contradict that. A missing file or a different ETag is `PRECONDITION_FAILED` (412). The check runs before the body is read and again right before the rename, which narrows the lost-update window but does not close it, since there is no lock. The route takes it from the `If-Match` header and compares it as an exact string. `*` and weak tags are not supported, because no client sends them. `size` is the declared length. The route passes `Content-Length` when there is one. More or fewer streamed bytes are `SIZE_MISMATCH` (400), and the temp file is removed. A declared size above `maxBytes` is `PAYLOAD_TOO_LARGE` before any byte is read.

`read` returns the `Entry` with the stream and the ETag. The Range is resolved against the size of the file actually opened (a function range), so `GET content` needs one backend call. The old stat/read race on `Content-Range: bytes */<size>` cannot happen any more.

## 2026-10-15: collision dialog and `<AppDialog>` (#136)

Question: what do Esc, "apply to all" and "keep both" do, and how does the SPA find out about a collision without sending a file twice?

Esc (closing the dialog) counts as "skip" for the current item only. Closing must never overwrite anything or decide for items the user has not seen. The batch goes on, and the summary reports skipped items separately from failures (`upload.summarySkipped`). The scrim does not close the dialog on click, so a stray tap cannot skip a file.

"Apply to all remaining" is offered only when items follow. With "replace" or "keep both" for all, the remaining files are sent with that policy straight away. With "skip" for all, each one is still sent with `fail` first, so a file whose name is free is uploaded as usual and only the taken ones are skipped.

The SPA always sends `onCollision=fail` first. `LocalBackend.write` now answers `FILE_EXISTS` with `{ name }` in `params` before it reads the body, and the route closes the connection on any rejection that leaves the body unread. The SPA sends the file a second time only after the user has chosen. The hard-link in `place()` still catches a name that is taken between that check and the rename.

The first "keep both" name is `name (1).ext`, as the issue states, not `(2)` as before. Nothing has been deployed, so nothing depends on the old numbering. The dialog shows the name from the server's `params`, because the server decides which entry conflicts.

`<AppDialog>` is open while it is mounted. It makes every other child of `<body>` `inert`, sets `overflow: hidden` on `<html>`, traps Tab, and restores focus on unmount to `returnFocus` (for an upload, the upload button's input) or to the element focused before. It uses no native `<dialog>`, because `showModal()` lets Tab leave into the browser chrome and it would be a second code path to keep accessible. The lint config bans `role="dialog"`/`alertdialog`, a bound `:role` and `<dialog>` outside `AppDialog.vue`.

## 2026-10-15: rename, move, copy and delete in the home (#137)

Question: what does "replace" do to the old item, how are the filesystem and the database kept consistent, which path-dependent tables does the cascade cover, and how do keyboard and touch users reach the actions?

"Replace" never destroys anything: the existing target goes to the trash (with its trash row) in the same transaction as the move or copy. Moving an item onto itself is a no-op (200). A folder cannot be moved or copied into itself or a descendant (`TARGET_INSIDE_SOURCE`, 409), and "replace" is refused the same way when the target holds the source, because the source would go to the trash with it. Copying onto the item's own name is allowed and is how "duplicate" works: the collision dialog offers "keep both", which gives `name (1).ext`.

Every move and delete runs one `BEGIN IMMEDIATE` SQLite transaction around synchronous `rename`s. The renames are recorded and undone in reverse when anything after them fails, including the commit, so neither a ghost row nor a lost file is left (#117). The immediate lock also serialises concurrent moves and deletes from this app. Uploads do not take it, so a name check against a concurrent upload still has a small window (for files, `rename` would replace; this is the same window the upload's own hard-link closes for uploads). A batch delete is all or nothing: one missing path keeps every item in place, and the route answers its error. Items beneath another selected item go with it.

Copies are built in `<home>/.files/tmp/<id>` (files through `copyFile`, i.e. `copy_file_range` in the kernel, each file and folder fsynced) and renamed into place in the transaction, so a half-done copy is never visible. The startup sweep now also empties `.files/tmp/`, without following a symlinked `.files` or `tmp`. A symlink or special file inside a copied folder fails the copy with `PATH_SYMLINK`/`PATH_INVALID` instead of being skipped silently. Trashed items live at `<home>/.files/trash/<32hex>` with a `trash` row (original path, type, size, time); listing, restore and expiry are #138.

No path-dependent table exists yet (shares, favourites, the search index and versions come later). The cascade is the list `PATH_TABLES` in `server/src/storage/pathRefs.ts`: a move rewrites the rows of the item and everything beneath it (prefix match with `substr`, so `/a` never matches `/ab`), a delete or a replaced target removes them. Each issue that adds such a table appends it there and extends `server/test/transfer.test.ts`, which already asserts the cascade per table through the app for single delete, multi delete, replace and move, using two stand-in tables passed in through the harness.

UI: Space now toggles the selection of the focused row (it used to open a folder; Enter still opens), Ctrl/Cmd+click toggles, Shift+click selects a range, Ctrl+A selects all. F2 renames, Delete moves to the trash without asking (the trash makes it reversible, and `confirm()` is banned), Ctrl+C/X mark items and Ctrl+V pastes into the open folder. Marked items survive navigation; the selection bar then offers "Move here"/"Copy here" as the forward action, which is how an empty folder, the mouse and touch paste. Each row has an action menu (menu button pattern; also on right-click, the context-menu key and Shift+F10) with rename, move, copy and trash, so every action works on a phone without a keyboard. Drag & drop moves onto folder rows and breadcrumbs (desktop; touch uses the menu). The dragged payload is our own MIME type, so files dragged in from the desktop are never taken for a move.

## 2026-10-15: local trash, restore, permanent delete and expiry (#138)

Question: where does the trash live and what counts towards usage, how does restore treat a taken name or a vanished folder, what is "one code path" for permanent deletes, and how does the expiry job run?

The trash lives under the home (`<home>/.files/trash/<32hex>`, one `trash` row each), so trashed bytes count towards the member's usage until purged without any extra bookkeeping; the trash view shows the sum. A folder's row records the bytes of its whole tree, measured before the delete transaction. The API is `/api/v1/trash` (list), `trash/restore` (one item per request), `trash/delete` (ids) and `trash/empty`, with no source segment: only the home has a local trash, cloud deletes go to the provider's trash.

Restore takes the stored original path through the same resolver as any user path (a symlink or a file on the way is refused), recreates missing parent folders, and uses the move's collision rules: `fail` answers `FILE_EXISTS` and changes nothing (#111), `keep-both` gives `name (1).ext`, `replace` sends the taken item to the trash. The SPA asks with `fail` first and shows the collision dialog; Esc skips.

`LocalBackend.purge` is the only way out of the trash: single delete, "empty trash" and the expiry job all call it. Per item it removes the bytes first, then deletes the row and the rows hanging off it (`TRASH_TABLES` in `pathRefs.ts`, empty today) in one transaction. If the bytes cannot be removed the row stays, the error is logged with the trash id, and the item is reported as failed: the routes answer `PURGE_FAILED` (500) with the count, the job lists it in `failed` and retries next run (#102, #112). Bytes that are already gone count as removed, so a row without bytes can always be cleared. Restore and purge of one member take an in-process per-member lock, so a purge never removes bytes a restore is moving; the app runs as one process.

Expiry uses `deleted_at` plus `FILES_TRASH_RETENTION_DAYS` (default 30, 1–3650), so a changed setting applies to items already in the trash. The job runs once after the startup sweep and then hourly, skips a tick while a run is in flight, and is awaited on shutdown. Items whose row vanished meanwhile (restored) are skipped, not errors. A new index on `trash(deleted_at)` serves its query (migration 003).

Permanent deletes ask first in an `<AppDialog>` ("Cancel" has the initial focus); moving to the trash still does not ask, since it is reversible. The sidebar ("My storage", "Trash") is the start of the spec §3.8 source sidebar; on phone width it is a row of tabs under the header.

## 2026-10-15: folder and selection as a streamed ZIP (#139)

Question: what does the archive contain and how is it laid out, which ZIP features does it use, what happens when something goes wrong after the first byte, and how does a selection reach a `GET`?

`GET /api/v1/sources/:source/zip?path=…` takes `path` once (a folder, a file, or `/` for the whole source) or repeated (a selection). Up to 1000 paths are accepted; a selection longer than the URL allows is downloaded as its folder instead. Paths beneath another selected path come with it; whatever is left must share one parent folder (`VALIDATION` otherwise), because entry names are relative to that folder: a folder `/a/b` gives `b/…`, a selection gives its items at the top. The file is called `<name>.zip` for one item, `<folder>.zip` for a selection, and `files.zip` for the whole source or a selection at its top level. Each path is stat'ed before the first byte, so a missing path, a symlink or the internal area still answers a JSON error.

The writer (`server/src/storage/zip.ts`) is our own, about 150 lines, with no dependency. It walks only through the backend's `list` and `read`. So the archive holds exactly what a listing shows: no symlinks, no `<root>/.files/`, no upload temp files, no non-canonical names. Every path passes `resolveInRoot`, and the same code will serve cloud sources later. `.files` is internal only at the home root; a folder of that name deeper down is the member's own and is included. Entries are stored, not deflated. Most bulky content on a shard (photos, video) is already compressed, deflate would cost CPU on small hardware, and the CRC is computed as the bytes pass. Every file entry is ZIP64 from the start (sizes `0xFFFFFFFF` plus a ZIP64 extra in the local header, then a 64-bit data descriptor), because its size is only known once it has been read. A ZIP64 end record is always written. All names carry the UTF-8 flag. The only state that grows is the central directory, about 100 bytes per entry. There is no `Content-Length`, because a file may change while it is read.

Once the first byte is out, the status can no longer change. A failed read then aborts the response (Fastify destroys the socket and logs it) and no end record is written, so the client sees a failed download, never a short archive that looks complete. A client disconnect returns the generator, which destroys the open file stream. Nothing is written to disk, so nothing is left behind.

UI: the selection bar has a "Download" link. One selected file downloads as itself, anything else as a ZIP. The row menu has "Download" as its first item, so a folder downloads without selecting it first, also on a phone.

## 2026-10-15: resumable uploads over tus, quota, upload panel, folder upload (#140)

Question: which part of tus is offered and how is it addressed, where do the bytes and the state live, what counts against which limit, how does the collision dialog fit into a resumable upload, what does the panel do, and what happens to the plain `PUT content`?

The server speaks tus 1.0 under `/api/v1/uploads` (`server/src/routes/uploads.ts`), written here without a dependency: `OPTIONS` (discovery), `POST` (creation), `HEAD`, `PATCH`, `DELETE` (termination), and `Upload-Expires` on every answer (expiration). `Upload-Defer-Length` and creation-with-upload are not offered: the length has to be known up front, because size and quota are checked at creation. The target goes in `Upload-Metadata` as `source`, `path` and `onCollision` (default `fail`); other keys such as a client's `filename` are ignored. The source goes through `resolveSource` with `edit` access like every other write; today only `home` resolves. Every route needs a session, the mutating ones also Origin and the CSRF token, like every other route; `Tus-Resumable: 1.0.0` is required (412 otherwise). An id is 32 hex characters and is looked up together with the member, so another member's id, an unknown one and a malformed one all answer 404.

One row per upload in the new `uploads` table (migration 004) holds target, length, policy, expiry and `received`, the bytes that have been fsynced. The bytes collect in `<home>/.files/uploads/<id>`, reached through `resolveInRoot` like the trash; the name is not `.<16hex>.upload`, so the startup sweep leaves a paused upload alone. A `PATCH` truncates the file back to `received`, streams the body after it, then fsyncs and records the new size, also when the connection drops halfway, so the client continues with `HEAD` + `PATCH` from what is really stored. Only one request per upload runs at a time (`UPLOAD_LOCKED`, 423; in-process, since the app is one process). A wrong `Upload-Offset` is `OFFSET_MISMATCH` (409) with the stored offset. An upload expires 24 hours after it was created or last received bytes. An hourly job, started after the startup sweep like the trash expiry, removes the bytes and then the row (`server/src/storage/uploads.ts`) and skips an upload that is receiving bytes right now.

Limits. An `Upload-Length` above `FILES_MAX_UPLOAD_BYTES` is `PAYLOAD_TOO_LARGE`, one above the remaining quota `QUOTA_EXCEEDED` (507), both before a row or a byte exists. A client that sends more than it declared, by `Content-Length` or in a chunked body, is cut off with `SIZE_MISMATCH` and its whole upload is dropped (#113). The issue asks for "the member's remaining quota", but no quota existed, so `users.quota_bytes` is added (NULL = no quota, which is today's behaviour; the admin page that sets it comes with the storage overview). Usage is everything under the member's home, including the trash and staged uploads, plus what the member's other open uploads still have to send (a reservation), so two uploads cannot both take the last free bytes. The reservation check and the insert run in one transaction. Each `PATCH` checks again, so a quota lowered meanwhile stops the upload without storing more. The walk over the home only happens when a quota is set. The plain `PUT content` is held to the same quota, so it is no way around it. Copies are not checked yet (see CONCEPTS, *Known drift*).

Collisions. The policy comes with the creation, and `fail` with a taken name answers `FILE_EXISTS` before any byte is sent, so the SPA asks the #136 question first, as before. If the name is taken while the bytes are on their way, the last `PATCH` answers `FILE_EXISTS` and the complete upload stays. `POST /api/v1/uploads/:id/finish` with the chosen policy then places it without sending the bytes again; "skip" terminates it. `finish` is the one route that is not part of tus. Placement creates missing parent folders and renames or hard-links the staged file in the same transaction that deletes the row. "Replace" overwrites, like `PUT content` always has; versions on overwrite come with the versions issue.

SPA. `web/src/api/tus.ts` is our own small tus client: 8 MiB `PATCH` chunks, so a dropped connection or a buffering proxy loses at most one chunk, two automatic retries after 0.3 s and 1 s (each with `HEAD` first), then the item fails and waits for the user. The upload URL is kept in localStorage under target, size and modification time. Picking the same file again after a reload therefore continues where the server stopped; a browser cannot reopen a file by itself after a reload, so it has to be picked again. The uploads store runs one item at a time in pick order, because the collision question needs an answer before the next item starts. The panel sits above the page in the shell, so it stays when the member navigates, and it asks the collision question itself. Each item shows a progress bar and has pause/resume, cancel (which terminates on the server) and retry. Everything that failed is in one summary with one "Retry all" button, never one message per file and never `alert()` (#119). The status line still reports each pick ("2 of 3 uploaded") once all its items have an outcome; a paused item keeps its pick open. "Clear finished" removes finished items and terminates what the server holds of failed ones.

Folders. "Upload folder" is a second picker (`webkitdirectory`). Dropping files or folders from the desktop onto the folder view uploads them too, and dropped folders are walked through the entries API. Each file keeps its path below the chosen folder, and placement creates the folders. Empty folders are not recreated: the directory picker does not report them, and doing it only for drops would make the two ways differ.

`PUT /api/v1/sources/:source/content` stays for API clients and scripts; the SPA no longer uses it.

## 2026-10-15: the Recent view (#141)

Question: what counts as a recent entry, how many are kept, how do entries follow moves and deletes, what does a row open, and where do cloud sources fit?

An entry is the item a member placed through the app in their home: an upload (`PUT content` or a finished tus upload), the target of a copy, move or rename, and a restored item. `mkdir` is not a change to a file and is not recorded. A folder that is moved, copied or restored is one entry, not one per file inside it, so a large folder cannot push everything else out. Writing a path again moves its entry to the top instead of listing it twice. Each member keeps the newest 100 entries (`RECENT_CAP`), trimmed in the same statement batch as the insert; 100 fills several screens and keeps the table small. Rows are per member and the API answers only the caller's own; an activity feed of other members' actions is not in v1 (#22).

The `recent` table (migration 005) is the first entry in `PATH_TABLES`, so the #137 cascade rewrites entries on a move (including those beneath a moved folder) and removes them on a delete or a replaced target, in the move's or delete's transaction. The entry itself is written inside the same transaction as the write (for `PUT content`, right after the rename, since that path has no transaction around the rename). `UNIQUE (user_id, path)` keeps one row per path. A row can still point at a path that was changed outside the app; a move onto a free target therefore first drops rows at that target, which can only be stale, instead of failing on the unique key. The listing does not stat every row; such a row opens its folder, which shows the truth.

A row's "Open folder" link opens the folder that holds a file, or the folder itself for a folder entry. The empty state is its own sentence ("Nothing here yet …"), never the folder view's "This folder is empty" (#127).

Cloud sources: the item carries `source` (always `home` today). #149–#151 add each provider's recent files to the same list where the provider offers them, live from the provider, not stored in `recent`.

## 2026-10-15: the preview overlay (#142)

Question: how is a file opened for preview instead of downloaded, which types get which viewer, how is a PDF shown, what does "sanitising renderer" mean for Markdown, and how much text is fetched?

Opening. A plain click on a file's name, Enter on its row, or a double click opens the preview. The name stays a link to the download, so "open in new tab" and "save link as" still download, and the row menu, the selection bar and the preview's own "Download" button download too. The preview steps through the files of the open folder in list order: ←/→ and the Previous/Next buttons, with no wrap at the ends. Esc and Close put the focus on the row of the file shown last, not the one that was opened, so the list follows what the member looked at. Recent and the trash do not preview yet; their rows open the folder.

Types. The SPA chooses the viewer from the listed MIME type (`web/src/preview.ts`). PNG, JPEG, GIF, WebP and AVIF are images. `video/*` and `audio/*` play in the browser's own player with `preload="metadata"`. `application/pdf` is a PDF, `text/markdown` is Markdown, and any other `text/*`, JSON or XML is plain text. Plain text sits in a text node, so HTML or XML source is shown and never parsed. SVG (it can carry script), HEIC (no browser decodes it) and everything else show "can't be shown here" with Download as the forward action. A type the browser cannot decode after all (an MKV, say) shows the same failure message. The extension table gains the common text, audio and video extensions and `xml`/`xhtml`/`htm`, so these are typed correctly and HTML/XML stay attachments. AVIF joins the inline allowlist, since it is a raster format like WebP. The server's allowlist (`routes/sources.ts`) is unchanged otherwise and stays the guard; the SPA's choice is only presentation.

PDF. The browser's viewer is not used, because Chromium blocks a PDF served with `CSP: sandbox`, and phones do not show PDFs inline. pdf.js (`pdfjs-dist`, Apache-2.0) draws one page at a time on a canvas, with Previous/Next page buttons. Its worker is a file from the app's own origin, so the CSP stays `script-src 'self'`. It is loaded only when a PDF is opened and fetches the file with Range requests. One page at a time keeps memory flat on a long document. A text layer (selecting text) is not in v1 (superseded by the #143 entry: it is).

Markdown. markdown-it (MIT, CommonMark) parses with `html: false`, so raw HTML is text to it. `web/src/markdown.ts` builds Vue nodes from its tokens itself: an allowlist of elements (paragraphs, headings, lists, quotes, code, tables, emphasis), no HTML string and no `v-html`. Links are kept only for `http(s):` and `mailto:` and open in a new tab with `rel="noopener noreferrer nofollow"`. A relative link has nothing to point at inside the preview, so it is text. An image is never an `<img>`, because a remote image would be fetched as soon as the file is opened. It shows its alt text ("Image: …"), linked to its URL if that is http(s), and only a click loads it, in a new tab.

Text cap. Text and Markdown fetch at most 512 KiB, with a Range request, so the server streams only that much and the browser holds only that much. A longer file shows its start with a note and the Download button. 512 KiB covers any hand-written note and stays fast to render on a phone. An empty file is fetched without a Range, because an empty file has no satisfiable range.

## 2026-10-15: the PDF preview under `CSP: sandbox` in Chromium and Firefox (#143)

Question: does the PDF preview still work in the browsers members use, now that an inline PDF is served with `Content-Security-Policy: sandbox`, and how is "page 1 shows visible text" checked?

Delivery does not change. The browser's own viewer never opens the PDF: pdf.js in the SPA fetches the bytes from the content route (still inline, still `sandbox; default-src 'none'`) and draws them on a canvas, so the untrusted document never becomes a document of the app origin or of any frame, and the sandbox cannot get in its way. Playwright now also runs a `desktop-firefox` project, limited to `e2e/pdf-preview.spec.ts`, because the PDF path is the part that depends on the engine; the rest of the suite stays on the two Chromium projects. The check opens a two-page PDF and asserts page 1's text is in the overlay, that the canvas has ink under that text, that page 2 shows its own text after "Next page", and that no frame, embed or document navigation to the PDF exists.

Text layer. pdf.js's `TextLayer` now lies transparently over the canvas (`web/src/components/PdfView.vue`, rules in `app.css` after pdf.js's own `.textLayer` CSS). This reverses the #142 "not in v1": it is what makes "visible text" checkable without comparing screenshots across engines and fonts, and it gives members selecting, copying and the browser's find on the page, and screen readers the page's words. It comes from the pdf.js chunk that is already loaded, and only the shown page has spans, since one page is drawn at a time. Annotations, links inside a PDF and search across pages stay out.
