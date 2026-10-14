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
