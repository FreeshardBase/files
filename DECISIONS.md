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
