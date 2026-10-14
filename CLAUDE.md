# Files — agent briefing

Read `docs/superpowers/specs/2026-10-14-files-rebuild-design.md` first. It is the source of truth for scope; `DECISIONS.md` records later decisions; `CONCEPTS.md` explains the model and maps the modules.

## Commands
```bash
export PATH=~/.local/node22/bin:$PATH
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (Vitest)
pnpm e2e                                    # build + Playwright (desktop + mobile); picks free ports itself
pnpm dev                                    # fake IdP on :4000 + server on :3005; run `pnpm --filter @files/web dev` for the SPA on :5173
```
Container: with podman use `podman build --format docker .`, otherwise the `HEALTHCHECK` is dropped.

## Invariants (reviewer rejects violations)
- Every user path goes through `server/src/storage/resolveInRoot.ts`. No `path.join` on user input anywhere else.
- Auth is deny-by-default (`server/src/auth/guard.ts`). The guard decides on the matched route pattern. Public routes need `config: { public: true }` and a reason in the PR.
- Never decide security on raw `req.url`; use the matched route (`req.routeOptions`) or the decoded pathname.
- Session cookies are `__Host-fs_sid` and `__Host-fs_login` on https; the plain names `fs_sid` and `fs_login` exist only on http loopback (dev, E2E).
- The internal area `<root>/.files/` is unaddressable by users. Temporary upload files are `.<16hex>.upload` and stay hidden from listings.
- No silent catch. No buffering whole files. No fetching user-supplied URLs.
- No auth bypass, no `NODE_ENV === 'test'` branches. Tests log in through `server/test/support/fakeIdp.ts`.
- Tests use temp dirs only; never `data/`.
- Every bug fix starts with a failing test; deleting the fix must turn it red.
- Every UI change has a Playwright test and passes `no-raw-text` (all strings in `web/src/i18n/*.json`, all three locales).
- Design guide "Daylight Instrument" is binding; deviations go in `DESIGN.md`.
- Fixtures use `testuser`, `testuser@example.com`, `Test User`.
- Never commit `.env*`, `*.db`, `data/`.
