# Files — agent briefing

Read `docs/superpowers/specs/2026-10-14-files-rebuild-design.md` first. It is the source of truth for scope; `DECISIONS.md` records later decisions; `CONCEPTS.md` explains the model and maps the modules.

## Commands
```bash
export PATH=~/.local/node22/bin:$PATH
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (Vitest)
pnpm e2e                                    # build + Playwright (desktop + mobile Chromium, Firefox for the PDF preview); picks free ports itself
pnpm dev                                    # fake IdP on :4000 + server on :3005; run `pnpm --filter @files/web dev` for the SPA on :5173
```
Container: with podman use `podman build --format docker .`, otherwise the `HEALTHCHECK` is dropped. The image has no `USER`: `main.ts` starts as root, chowns `/data` itself (never recursively, `server/src/dataDir.ts`) and drops to `node` (uid 1000) before opening anything. Do not add `USER node` to the image or `user: 0:0` to the app template.

## Invariants (reviewer rejects violations)
- Every user path goes through `server/src/storage/resolveInRoot.ts`. No `path.join` on user input anywhere else.
- Auth is deny-by-default (`server/src/auth/guard.ts`). Every matched route needs a session (and CSRF for mutating methods) unless it carries `config: { public: true }`; the path prefix does not matter. Public today: `/healthz`, `/auth/login`, `/auth/callback`, `/s/:token/*` (public links, #147), the SPA fallback and the static assets (marked by the encapsulated static plugin's `onRoute` hook). Unmatched requests get 401 without a session. A new public route needs a stated reason in the PR. `server/test/routeInventory.test.ts` walks every registered route and enforces this.
- Never decide security on raw `req.url`; use the matched route (`req.routeOptions`) or the decoded pathname.
- Session cookies are `__Host-fs_sid` and `__Host-fs_login` on https; the plain names `fs_sid` and `fs_login` exist only on http loopback (dev, E2E).
- The internal area `<root>/.files/` is unaddressable by users. Temporary upload files are `.<16hex>.upload` and stay hidden from listings.
- No silent catch. No buffering whole files. No fetching user-supplied URLs.
- No auth bypass, no `NODE_ENV === 'test'` branches. Tests log in through `server/test/support/fakeIdp.ts`.
- Tests use temp dirs only; never `data/`.
- Every bug fix starts with a failing test; deleting the fix must turn it red.
- Every dialog uses `web/src/components/AppDialog.vue`. The lint config rejects `role="dialog"`/`alertdialog`, a bound `:role` and `<dialog>` in any other file under `web/src` (`web/test/dialogLint.test.ts`).
- Every UI change has a Playwright test and passes `no-raw-text` (all strings in `web/src/i18n/*.json`, all three locales).
- Design guide "Daylight Instrument" is binding; deviations go in `DESIGN.md`.
- Fixtures use `testuser`, `testuser@example.com`, `Test User`.
- Never commit `.env*`, `*.db`, `data/`.
- Every location under `FILES_DATA_DIR` comes from `server/src/paths.ts` (`dbPath`, `homeRoot`). Nothing else derives data-root paths.
- `trustProxy` trusts exactly one hop: the app runs only behind the shard proxy. Do not widen it.

## Recipes
- **Error code.** Add it to `ERROR_CODES` and `errorStatus` in `shared/src/errors.ts`, then add `errors.<CODE>` to all three `web/src/i18n/*.json` (Du/Sie forms checked). The typecheck forces the status; `web/test/i18n.test.ts` forces the locale keys. Throw it as `new AppError('CODE', params?)`.
- **Migration.** Add a new `server/migrations/NNN_name.sql` with the next number. Never edit a migration that has been applied anywhere; fix forward with a new one.
- **Route.** Register it under `/api/v1/…`. Zod-parse `req.params`, `req.query` and the body inside the handler; take the user from `requireUser(req)`. Add `config: { public: true }` only with a stated reason. The route-inventory test picks it up automatically (401 without a session, 403 CSRF on mutating methods).
- **Test harness.** `startTestApp(overrides?, extend?)` in `server/test/support/harness.ts` boots the real app on a temp data dir with `NODE_ENV=production`; `t.routes` lists every registered route. `login(t, user)` runs the real OIDC flow against the fake IdP (`testuser` is admin, `member` is a member) and returns `{ cookie, csrf }`. Mutating requests need `origin: t.config.publicUrl.origin` (`https://files.example.com`) and `x-csrf-token: csrf`. Each test sets up its own files; never rely on another test having run.
- **Catch blocks.** A `catch` that does not rethrow must say why on the same line: `// handled: <what happens instead>`. No empty or silent catch.
