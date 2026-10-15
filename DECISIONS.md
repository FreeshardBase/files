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

## 2026-10-15: start as root, chown only `/data`, drop to uid 1000 in Node

On a shard the Docker daemon creates the `/data` bind mount as root, and the image used to run as `node`, so Files could not write there. `user: 0:0` in the app template would run the whole server as root, so the image now has no `USER`. `main.ts` checks whether it is uid 0. If it is, it chowns `/data` to 1000:1000, plus any parents it had to create, and never recurses into existing contents. Then it calls `setgroups`/`setgid`/`setuid` and verifies the drop, all before the database or any route exists. Doing this in Node rather than in a shell entrypoint with `gosu`/`setpriv` adds no package. It keeps one process as PID 1, so SIGTERM handling is unchanged, and the steps can be unit-tested (`server/test/dataDir.test.ts`). A container started as a non-root user skips the root step. Either way, startup then checks that `/data`, `files.db` and `homes/` are writable, and exits 1 naming the path if they are not. Leftovers owned by root from an earlier root run need a one-time `chown -R` on the host. Chowning them on every start would be slow on large trees and would silently rewrite ownership of user data.
