# Phase B — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old Files tree with a clean TypeScript workspace in which a member logs in through OIDC, browses their shard home, uploads and downloads files, all behind deny-by-default auth and fully tested.

**Architecture:** pnpm workspace with three packages. `shared/` holds the error codes and Zod schemas that form the API contract. `server/` is Fastify 5 on Node 22, with better-sqlite3, versioned SQL migrations, SQLite-backed sessions, OIDC via openid-client 6, and one path resolver (`resolveInRoot`) behind a `StorageBackend` interface. `web/` is a Vue 3 SPA (Vite, Pinia, vue-i18n) using the design-guide tokens. Tests: Vitest against the real app with a temp data dir and a fake OIDC provider; Playwright E2E drives the real login flow.

**Tech Stack:** Node 22, pnpm 10 (corepack), TypeScript 5, Fastify 5, @fastify/cookie, @fastify/helmet, @fastify/static, Zod 4, better-sqlite3, openid-client 6, jose, pino, esbuild, Vitest, Vue 3, Vite, Pinia, Vue Router, vue-i18n, @fontsource/inter, @fontsource/ibm-plex-mono, Playwright, ESLint 9 (typescript-eslint, eslint-plugin-vue, @intlify/eslint-plugin-vue-i18n).

**Spec:** `docs/superpowers/specs/2026-10-14-files-rebuild-design.md`

## Global Constraints

- Node `>=22`; container base `node:22-slim`; container runs as non-root user `node`.
- ESM everywhere (`"type": "module"`); TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- No empty or swallowing `catch`; every `catch` either rethrows, maps to an `AppError`, or carries a `// handled:` comment explaining why.
- No user-supplied URL is ever fetched by the server.
- No whole file in memory in request paths: no `arrayBuffer()`, no `Buffer.concat` of bodies, no `readFile` of user files.
- Every filesystem path derived from user input goes through `resolveInRoot`. No other module calls `path.join` on user input.
- One data root: `DATA_DIR`. Layout: `DATA_DIR/files.db`, `DATA_DIR/homes/<userId>/`.
- Config is validated at startup. Invalid config → log + `process.exit(1)`. No fallback defaults for secrets, issuer, client id/secret, public URL.
- OIDC issuer must be `https://`, except `http://127.0.0.1` / `http://localhost`.
- No local accounts, no auth bypass flag, no `NODE_ENV === 'test'` branches in production code.
- Tests never touch `files/data/`; each test uses a fresh temp `DATA_DIR`.
- Test fixtures use `testuser`, `testuser@example.com`, `Test User` only.
- User-visible strings only via i18n keys; languages `de-du` (default), `de-sie`, `en`.
- No `v-html`; no `alert()` / `confirm()`.
- Design tokens from the "Daylight Instrument" guide; no glass/blur; line icons, no emoji; fonts self-hosted.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **File names with spaces, `%`, `#`, umlauts in NFD form, emoji.** A user expects them to round-trip: upload, list, and download all show the same name. Test in Task 7: NFC normalisation plus a round trip through the API. Test in Task 11: the E2E upload uses `Prüfung #1 50%.txt`.
2. **Upload aborted mid-stream.** A user expects no partial or ghost file to stay behind. Test in Task 7: aborting the stream leaves no target file and no temp file.
3. **Two uploads of the same name at the same time with `onCollision=fail`.** Exactly one may win; the other gets `FILE_EXISTS`, and the content must never be a mix. Test in Task 7.
4. **Folder with 1,200 entries.** A user expects the full list in the UI, not just the first page. Test in Task 7: cursor pagination returns every entry exactly once. Test in Task 10: the store follows `next` until the end.
5. **Session expired while the app is open.** A user expects to land back on the login page, not on a broken screen. Test in Task 6: an expired session returns 401 `UNAUTHENTICATED`. Test in Task 10: the API client redirects to `/auth/login` on 401.

---

## File Structure

```
files/
  package.json                 workspace root: scripts typecheck/lint/test/e2e/build/dev
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js
  .gitignore  .dockerignore  .node-version
  Dockerfile  docker-compose.yml
  CLAUDE.md  CONCEPTS.md  DECISIONS.md  DESIGN.md  README.md
  shared/
    package.json  tsconfig.json
    src/index.ts               re-exports
    src/errors.ts              ErrorCode union + HTTP status map
    src/entries.ts             Entry / ListResponse Zod schemas
  server/
    package.json  tsconfig.json  vitest.config.ts  build.mjs
    migrations/001_init.sql
    src/main.ts                process entry: load config, open db, start app, crash handlers
    src/config.ts              Zod env schema, loadConfig()
    src/app.ts                 buildApp(deps): Fastify instance, plugins, routes
    src/errors.ts              AppError, error handler
    src/db.ts                  openDb(), migrate()
    src/auth/sessions.ts       session + login-attempt store
    src/auth/oidc.ts           OIDC client wrapper
    src/auth/routes.ts         /auth/login, /auth/callback, /auth/logout, /api/v1/me
    src/auth/guard.ts          deny-by-default + CSRF hooks
    src/users.ts               upsertUserFromClaims()
    src/storage/backend.ts     StorageBackend interface + Entry type re-export
    src/storage/resolveInRoot.ts
    src/storage/local.ts       LocalBackend
    src/routes/sources.ts      /api/v1/sources/:source/{list,stat,content,mkdir}
    src/http/range.ts          parseRange()
    test/support/fakeIdp.ts    fake OIDC provider (also runnable for dev/E2E)
    test/support/harness.ts    startTestApp(), login()
    test/*.test.ts
  web/
    package.json  tsconfig.json  vite.config.ts  index.html
    src/main.ts  src/App.vue  src/router.ts
    src/api/client.ts          typed fetch wrapper, CSRF, 401 redirect
    src/stores/session.ts  src/stores/folder.ts
    src/i18n/index.ts  src/i18n/de-du.json  src/i18n/de-sie.json  src/i18n/en.json
    src/styles/tokens.css  src/styles/components.css  src/styles/app.css
    src/components/FileList.vue  src/components/UploadButton.vue  src/components/Breadcrumbs.vue
    src/views/FolderView.vue
    test/i18n.test.ts  test/folderStore.test.ts  test/client.test.ts
  e2e/
    playwright.config.ts
    globalSetup.ts             start fake IdP + built server
    browse-upload-download.spec.ts
```

---

### Task 0: Toolchain (Node 22, pnpm)

**Files:** none in repo. Installs to `~/.local/node22`.

- [ ] **Step 1: Install Node 22 user-local**

```bash
cd /tmp && curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
F=$(grep -o 'node-v22[^ ]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$F"
grep " $F\$" SHASUMS256.txt | sha256sum -c -
mkdir -p ~/.local/node22 && tar -xJf "$F" -C ~/.local/node22 --strip-components=1
~/.local/node22/bin/node -v
```
Expected: `v22.x.y`, checksum `OK`.

- [ ] **Step 2: Enable pnpm via corepack for that node**

```bash
export PATH=~/.local/node22/bin:$PATH
corepack enable --install-directory ~/.local/node22/bin pnpm
pnpm -v
```
Expected: `10.x`.

All later commands assume `export PATH=~/.local/node22/bin:$PATH`.

---

### Task 1: Archive old tree, workspace skeleton, gates

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.dockerignore`, `.node-version`, `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`, `shared/src/errors.ts`, `shared/src/entries.ts`, `shared/test/errors.test.ts`
- Delete: everything else tracked except `README.md`, `docs/`

**Interfaces:**
- Produces: `ErrorCode` (string union), `errorStatus: Record<ErrorCode, number>`, `EntrySchema`, `Entry`, `ListResponseSchema`, `ListResponse` from `@files/shared`.

- [ ] **Step 1: Tag and push the archive**

```bash
cd /home/agent-user/Coding/Freeshard/files
git switch main && git pull --ff-only
git tag -a archive/gemini-2026-10-14 -m "Last state of the Gemini-built tree before the rebuild" main
git push origin archive/gemini-2026-10-14
git switch -c rebuild/phase-b
git merge --ff-only docs/rebuild-spec
```

- [ ] **Step 2: Remove the old tree in one commit**

```bash
git ls-files | grep -vE '^(README\.md|docs/)' | xargs git rm -q
git commit -m "chore: remove Gemini-era tree (kept at tag archive/gemini-2026-10-14)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Untracked local files (`data/`, `.env`, `node_modules/`) stay on disk and must not be added. Move `node_modules/` aside: `mv node_modules /tmp/claude-1002/files-old-node_modules`.

- [ ] **Step 3: Root workspace files**

`package.json`:
```json
{
  "name": "freeshard-files",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "test": "pnpm -r test",
    "build": "pnpm --filter @files/web build && pnpm --filter @files/server build",
    "e2e": "pnpm build && playwright test -c e2e/playwright.config.ts",
    "dev": "pnpm --filter @files/server dev"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.0",
    "@intlify/eslint-plugin-vue-i18n": "^4.1.0",
    "@playwright/test": "^1.56.0",
    "eslint": "^9.39.0",
    "eslint-plugin-vue": "^10.5.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.46.0",
    "vue-eslint-parser": "^10.2.0"
  }
}
```
(Use the newest versions at least 2 weeks old at install time; `pnpm add -D -w <pkg>` writes them.)

`pnpm-workspace.yaml`:
```yaml
packages:
  - shared
  - server
  - web
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`.node-version`: `22`

`.gitignore`:
```
node_modules/
dist/
data/
.env
.env.*
*.db
*.db-*
test-results/
playwright-report/
coverage/
```

`.dockerignore`:
```
.git
**/node_modules
**/dist
data
.env
.env.*
*.db
*.db-*
test-results
playwright-report
docs
e2e
```

- [ ] **Step 4: ESLint config with project rules**

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueI18n from '@intlify/eslint-plugin-vue-i18n';

const bannedBuffering = [
  { selector: "CallExpression[callee.property.name='arrayBuffer']", message: 'Stream instead of buffering (spec 3.2).' },
  { selector: "CallExpression[callee.object.name='Buffer'][callee.property.name='concat']", message: 'Stream instead of buffering (spec 3.2).' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...bannedBuffering],
      'no-restricted-properties': ['error',
        { object: 'process', property: 'exit', message: 'Only main.ts may exit.' }],
    },
  },
  { files: ['server/src/main.ts'], rules: { 'no-restricted-properties': 'off' } },
  ...vue.configs['flat/recommended'],
  {
    files: ['web/src/**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: { 'vue-i18n': { localeDir: './web/src/i18n/*.json', messageSyntaxVersion: '^11.0.0' } },
    rules: {
      'vue/no-v-html': 'error',
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[\\s/·…–—|()\\-:]+$' }],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-alert': 'error',
    },
  },
);
```

- [ ] **Step 5: shared package — write the failing test**

`shared/package.json`:
```json
{
  "name": "@files/shared",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p .", "test": "vitest run" },
  "dependencies": { "zod": "^4.1.0" },
  "devDependencies": { "vitest": "^4.0.0", "@types/node": "^22.0.0" }
}
```
`shared/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test"] }
```
`shared/test/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { errorStatus, ERROR_CODES, EntrySchema } from '../src/index.ts';

describe('error codes', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(errorStatus[code], code).toBeGreaterThanOrEqual(400);
    }
  });
  it('uses distinct statuses for auth vs csrf', () => {
    expect(errorStatus.UNAUTHENTICATED).toBe(401);
    expect(errorStatus.CSRF).toBe(403);
  });
});

describe('EntrySchema', () => {
  it('rejects an entry without a name', () => {
    expect(EntrySchema.safeParse({ path: '/a', type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' }).success).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

```bash
pnpm install && pnpm --filter @files/shared test
```
Expected: FAIL, `Cannot find module '../src/index.ts'`.

- [ ] **Step 7: Implement shared**

`shared/src/errors.ts`:
```ts
export const ERROR_CODES = [
  'UNAUTHENTICATED', 'FORBIDDEN', 'CSRF', 'VALIDATION', 'NOT_FOUND', 'FILE_EXISTS',
  'PATH_INVALID', 'PATH_SYMLINK', 'NOT_A_DIRECTORY', 'IS_A_DIRECTORY',
  'PAYLOAD_TOO_LARGE', 'RANGE_NOT_SATISFIABLE', 'LOGIN_FAILED', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorStatus: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, CSRF: 403, VALIDATION: 400, NOT_FOUND: 404,
  FILE_EXISTS: 409, PATH_INVALID: 400, PATH_SYMLINK: 400, NOT_A_DIRECTORY: 409,
  IS_A_DIRECTORY: 409, PAYLOAD_TOO_LARGE: 413, RANGE_NOT_SATISFIABLE: 416,
  LOGIN_FAILED: 400, INTERNAL: 500,
};

export interface ApiError { code: ErrorCode; params?: Record<string, string | number> }
```
`shared/src/entries.ts`:
```ts
import { z } from 'zod';

export const EntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  modified: z.iso.datetime(),
  mime: z.string().optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const ListResponseSchema = z.object({
  entries: z.array(EntrySchema),
  next: z.string().optional(),
});
export type ListResponse = z.infer<typeof ListResponseSchema>;

export const CollisionPolicy = z.enum(['fail', 'replace', 'keep-both']);
export type CollisionPolicy = z.infer<typeof CollisionPolicy>;

export const MeSchema = z.object({
  id: z.string(), displayName: z.string(), email: z.string().optional(),
  role: z.enum(['admin', 'member']), csrfToken: z.string(),
});
export type Me = z.infer<typeof MeSchema>;
```
`shared/src/index.ts`:
```ts
export * from './errors.ts';
export * from './entries.ts';
```

- [ ] **Step 8: Run tests, typecheck, lint**

```bash
pnpm --filter @files/shared test && pnpm --filter @files/shared typecheck && pnpm lint
```
Expected: 3 passed; no type or lint errors.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "build: pnpm workspace, lint rules, shared API contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server config with fail-fast validation

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/config.ts`, `server/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` (throws `ConfigError` listing every problem), `type Config = { publicUrl: URL; dataDir: string; sessionSecret: string; encryptionKey: Buffer; oidc: { issuer: URL; clientId: string; clientSecret: string; roleClaim: string; adminValue: string }; maxUploadBytes: number; port: number; logLevel: string }`.

- [ ] **Step 1: Package files**

`server/package.json`:
```json
{
  "name": "@files/server",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p .",
    "test": "vitest run",
    "build": "node build.mjs",
    "dev": "tsx watch src/dev.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@fastify/helmet": "^13.0.0",
    "@fastify/static": "^8.2.0",
    "@files/shared": "workspace:*",
    "better-sqlite3": "^12.4.0",
    "fastify": "^5.6.0",
    "openid-client": "^6.8.0",
    "pino": "^10.0.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "esbuild": "^0.25.0",
    "jose": "^6.1.0",
    "tsx": "^4.20.0",
    "vitest": "^4.0.0"
  }
}
```
(Install with `pnpm --filter @files/server add …`, which picks the current versions; only the major versions above are binding.)

`server/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test", "build.mjs"] }
```
`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', pool: 'forks', testTimeout: 15000, env: { NODE_ENV: 'production' } },
});
```

- [ ] **Step 2: Write the failing test**

`server/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.ts';

const valid = {
  FILES_PUBLIC_URL: 'https://files.example.com',
  FILES_DATA_DIR: '/tmp/files-test',
  FILES_SESSION_SECRET: 'x'.repeat(48),
  FILES_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  FILES_OIDC_ISSUER: 'https://idp.example.com',
  FILES_OIDC_CLIENT_ID: 'files',
  FILES_OIDC_CLIENT_SECRET: 'secret',
  FILES_OIDC_ROLE_CLAIM: 'groups',
  FILES_OIDC_ADMIN_VALUE: 'admin',
};

describe('loadConfig', () => {
  it('accepts a complete production config', () => {
    const c = loadConfig({ ...valid, NODE_ENV: 'production' });
    expect(c.publicUrl.origin).toBe('https://files.example.com');
    expect(c.encryptionKey.length).toBe(32);
    expect(c.maxUploadBytes).toBe(10 * 1024 ** 3);
  });

  it.each(Object.keys(valid))('refuses to start without %s', (key) => {
    const env: Record<string, string> = { ...valid };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('refuses a short session secret', () => {
    expect(() => loadConfig({ ...valid, FILES_SESSION_SECRET: 'short' })).toThrow(/FILES_SESSION_SECRET/);
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...valid, FILES_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/FILES_ENCRYPTION_KEY/);
  });

  it('refuses a plain-http issuer on a non-loopback host', () => {
    expect(() => loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/FILES_OIDC_ISSUER/);
  });

  it('allows a plain-http issuer on 127.0.0.1', () => {
    expect(loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://127.0.0.1:4000' }).oidc.issuer.port).toBe('4000');
  });

  it('reports every problem at once', () => {
    try { loadConfig({}); throw new Error('no throw'); }
    catch (e) { expect((e as ConfigError).problems.length).toBeGreaterThanOrEqual(9); }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @files/server test -- config`
Expected: FAIL, cannot find `../src/config.ts`.

- [ ] **Step 4: Implement**

`server/src/config.ts`:
```ts
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const issuerUrl = z.url().transform((s) => new URL(s)).refine(
  (u) => u.protocol === 'https:' || (u.protocol === 'http:' && loopback.has(u.hostname)),
  'must be https (http only for loopback)',
);

const Schema = z.object({
  FILES_PUBLIC_URL: z.url().transform((s) => new URL(s)),
  FILES_DATA_DIR: z.string().min(1),
  FILES_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  FILES_ENCRYPTION_KEY: z.string().transform((s) => Buffer.from(s, 'base64'))
    .refine((b) => b.length === 32, 'must be 32 bytes, base64-encoded'),
  FILES_OIDC_ISSUER: issuerUrl,
  FILES_OIDC_CLIENT_ID: z.string().min(1),
  FILES_OIDC_CLIENT_SECRET: z.string().min(1),
  FILES_OIDC_ROLE_CLAIM: z.string().min(1),
  FILES_OIDC_ADMIN_VALUE: z.string().min(1),
  FILES_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  FILES_PORT: z.coerce.number().int().min(0).max(65535).default(3005),
  FILES_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined>) {
  const r = Schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = r.data;
  return {
    publicUrl: e.FILES_PUBLIC_URL,
    dataDir: e.FILES_DATA_DIR,
    sessionSecret: e.FILES_SESSION_SECRET,
    encryptionKey: e.FILES_ENCRYPTION_KEY,
    oidc: {
      issuer: e.FILES_OIDC_ISSUER, clientId: e.FILES_OIDC_CLIENT_ID,
      clientSecret: e.FILES_OIDC_CLIENT_SECRET, roleClaim: e.FILES_OIDC_ROLE_CLAIM,
      adminValue: e.FILES_OIDC_ADMIN_VALUE,
    },
    maxUploadBytes: e.FILES_MAX_UPLOAD_BYTES,
    port: e.FILES_PORT,
    logLevel: e.FILES_LOG_LEVEL,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @files/server test -- config && pnpm --filter @files/server typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): validated config, refuses to start on any missing secret

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Database and migrations

**Files:**
- Create: `server/src/db.ts`, `server/migrations/001_init.sql`, `server/test/db.test.ts`

**Interfaces:**
- Produces: `openDb(file: string): Db` (WAL, foreign keys on, migrations applied), `type Db = Database.Database` (better-sqlite3), `migrate(db, dir?)`.

- [ ] **Step 1: Failing test**

`server/test/db.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'files-db-'));

describe('openDb', () => {
  it('applies migrations once and records them', () => {
    const file = join(tmp(), 'f.db');
    openDb(file).close();
    const again = openDb(file);
    expect(again.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }]);
  });

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(tmp(), 'f.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rolls back a failing migration completely', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    writeFileSync(join(dir, 'm', '001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, 'm', '002_bad.sql'), 'CREATE TABLE b (x INTEGER); SELECT nope FROM missing;');
    const file = join(dir, 'f.db');
    expect(() => openDb(file, join(dir, 'm'))).toThrow(/002_bad\.sql/);
    const raw = new Database(file);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='b'").get()).toBeUndefined();
    expect(raw.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_ok.sql' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @files/server test -- db`
Expected: FAIL, cannot find `../src/db.ts`.

- [ ] **Step 3: Implement**

`server/migrations/001_init.sql`:
```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  iss          TEXT NOT NULL,
  sub          TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL CHECK (role IN ('admin','member')),
  created_at   TEXT NOT NULL,
  last_login   TEXT NOT NULL,
  UNIQUE (iss, sub)
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE login_attempts (
  id_hash    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  return_to  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX login_attempts_expiry ON login_attempts(expires_at);
```
`server/src/db.ts`:
```ts
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;
export const DEFAULT_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(file: string, migrationsDir = DEFAULT_MIGRATIONS): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Db, dir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    });
    try { apply(); }
    catch (err) { throw new Error(`Migration ${f} failed: ${(err as Error).message}`, { cause: err }); }
  }
}
```
Note for build: `build.mjs` (Task 12) copies `migrations/` next to `dist/`, so `DEFAULT_MIGRATIONS` resolves in both source and bundle (`dist/../migrations`).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @files/server test -- db`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): SQLite with versioned, transactional migrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: App factory, errors, hardening, test harness, fake IdP

**Files:**
- Create: `server/src/errors.ts`, `server/src/app.ts`, `server/src/main.ts`, `server/src/dev.ts`, `server/test/support/fakeIdp.ts`, `server/test/support/harness.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `Config` (Task 2); `openDb`, `Db` (Task 3); `ErrorCode`, `errorStatus` (Task 1).
- Produces:
  - `class AppError extends Error { code: ErrorCode; params?: Record<string,string|number> }`
  - `buildApp({ config, db, logger? }): Promise<FastifyInstance>` (routes registered by later tasks inside `buildApp`)
  - `startFakeIdp(opts?: { port?: number; users?: Record<string, { name: string; email: string; groups: string[] }> }): Promise<{ issuer: string; close(): Promise<void> }>`
  - `startTestApp(overrides?: Partial<Record<string,string>>): Promise<{ app: FastifyInstance; config: Config; db: Db; dataDir: string; idp: FakeIdp; close(): Promise<void> }>`
  - `login(t, user = 'testuser'): Promise<{ cookie: string; csrf: string }>` (added in Task 6)

- [ ] **Step 1: Fake IdP (test support, used by every later test)**

`server/test/support/fakeIdp.ts`:
```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

type User = { name: string; email: string; groups: string[] };
export type FakeIdp = { issuer: string; close(): Promise<void> };

const DEFAULT_USERS: Record<string, User> = {
  testuser: { name: 'Test User', email: 'testuser@example.com', groups: ['admin'] },
  member: { name: 'Test Member', email: 'member@example.com', groups: [] },
};

export async function startFakeIdp(opts: { port?: number; users?: Record<string, User>;
  clientId?: string; clientSecret?: string } = {}): Promise<FakeIdp> {
  const users = opts.users ?? DEFAULT_USERS;
  const clientId = opts.clientId ?? 'files';
  const clientSecret = opts.clientSecret ?? 'files-secret';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { redirectUri: string; nonce: string; challenge: string; sub: string }>();
  let issuer = '';

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const sub = p.get('login_hint') ?? 'testuser';
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256' || !users[sub]) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { redirectUri: p.get('redirect_uri')!, nonce: p.get('nonce') ?? '',
        challenge: p.get('code_challenge')!, sub });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { body += c; });
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const [id, secret] = auth.split(':').map(decodeURIComponent);
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifierHash = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (id !== clientId || secret !== clientSecret || !entry || entry.challenge !== verifierHash
            || entry.redirectUri !== form.get('redirect_uri')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const u = users[entry.sub]!;
        const idToken = await new SignJWT({ nonce: entry.nonce, name: u.name, email: u.email, groups: u.groups })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(issuer).setAudience(clientId)
          .setSubject(entry.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
        json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, close: () => new Promise((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_IDP_PORT ?? 4000);
  startFakeIdp({ port }).then((i) => console.log(`fake IdP at ${i.issuer}`));
}
```

- [ ] **Step 2: Write the failing app test**

`server/test/support/harness.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

export type TestApp = { app: FastifyInstance; config: Config; db: Db; dataDir: string; idp: FakeIdp; close(): Promise<void> };

export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'files-app-'));
  const idp = await startFakeIdp();
  const config = loadConfig({
    NODE_ENV: 'production',
    FILES_PUBLIC_URL: 'https://files.example.com',
    FILES_DATA_DIR: dataDir,
    FILES_SESSION_SECRET: 's'.repeat(48),
    FILES_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    FILES_OIDC_ISSUER: idp.issuer,
    FILES_OIDC_CLIENT_ID: 'files',
    FILES_OIDC_CLIENT_SECRET: 'files-secret',
    FILES_OIDC_ROLE_CLAIM: 'groups',
    FILES_OIDC_ADMIN_VALUE: 'admin',
    FILES_LOG_LEVEL: 'fatal',
    ...overrides,
  });
  const db = openDb(join(dataDir, 'files.db'));
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app, config, db, dataDir, idp,
    async close() { await app.close(); db.close(); await idp.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
```
`server/test/app.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/harness.ts';
import { AppError } from '../src/errors.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  t.app.get('/__boom', { config: { public: true } }, async () => { throw new Error('secret detail'); });
  t.app.get('/__exists', { config: { public: true } }, async () => { throw new AppError('FILE_EXISTS', { name: 'a.txt' }); });
});
afterAll(() => t.close());

describe('app', () => {
  it('serves /healthz without auth', async () => {
    const r = await t.app.inject('/healthz');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('sets security headers', async () => {
    const r = await t.app.inject('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('maps AppError to code + params', async () => {
    const r = await t.app.inject('/__exists');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
  });

  it('hides internal error details from the client', async () => {
    const r = await t.app.inject('/__boom');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ code: 'INTERNAL' });
    expect(r.body).not.toContain('secret detail');
  });
});
```
Routes added after `ready()` fail in Fastify. So `buildApp` accepts an optional `extend?: (app) => void` that is called before `ready`. The test passes the two throwaway routes through `startTestApp({}, extend)`. Update the harness signature to `startTestApp(overrides = {}, extend?: (app: FastifyInstance) => void)` and call `buildApp({ config, db, extend })`. In `app.test.ts`, replace `beforeAll` with:
```ts
beforeAll(async () => {
  t = await startTestApp({}, (app) => {
    app.get('/__boom', { config: { public: true } }, async () => { throw new Error('secret detail'); });
    app.get('/__exists', { config: { public: true } }, async () => { throw new AppError('FILE_EXISTS', { name: 'a.txt' }); });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @files/server test -- app`
Expected: FAIL, cannot find `../../src/app.ts`.

- [ ] **Step 4: Implement errors and app**

`server/src/errors.ts`:
```ts
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { errorStatus, type ErrorCode } from '@files/shared';

export class AppError extends Error {
  constructor(public code: ErrorCode, public params?: Record<string, string | number>, options?: ErrorOptions) {
    super(code, options);
  }
}

export function errorHandler(err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    const status = errorStatus[err.code];
    if (status >= 500) req.log.error({ err }, err.code);
    return reply.status(status).send(err.params ? { code: err.code, params: err.params } : { code: err.code });
  }
  if ((err as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE' || (err as FastifyError).statusCode === 413) {
    return reply.status(413).send({ code: 'PAYLOAD_TOO_LARGE' });
  }
  if ((err as FastifyError).validation) {
    return reply.status(400).send({ code: 'VALIDATION' });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({ code: 'INTERNAL' });
}
```
`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { errorHandler } from './errors.ts';

declare module 'fastify' {
  interface FastifyContextConfig { public?: boolean }
}

export type AppDeps = { config: Config; db: Db; extend?: (app: FastifyInstance) => void };

export async function buildApp({ config, db, extend }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: { req: (req) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }) },
    },
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], mediaSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.decorate('deps', { config, db });

  app.get('/healthz', { config: { public: true } }, async () => ({ status: 'ok' }));

  extend?.(app);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { deps: { config: Config; db: Db } }
}
```
`server/src/main.ts`:
```ts
import { join } from 'node:path';
import { loadConfig, ConfigError } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';

process.on('unhandledRejection', (err) => { console.error('unhandledRejection', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); process.exit(1); });

let config;
try { config = loadConfig(process.env); }
catch (err) {
  if (err instanceof ConfigError) { console.error(err.message); process.exit(1); }
  throw err;
}
const db = openDb(join(config.dataDir, 'files.db'));
const app = await buildApp({ config, db });
await app.listen({ port: config.port, host: '0.0.0.0' });
```
`server/src/dev.ts`:
```ts
import { startFakeIdp } from '../test/support/fakeIdp.ts';
const idp = await startFakeIdp({ port: 4000 });
process.env.FILES_OIDC_ISSUER ??= idp.issuer;
process.env.FILES_OIDC_CLIENT_ID ??= 'files';
process.env.FILES_OIDC_CLIENT_SECRET ??= 'files-secret';
process.env.FILES_OIDC_ROLE_CLAIM ??= 'groups';
process.env.FILES_OIDC_ADMIN_VALUE ??= 'admin';
process.env.FILES_PUBLIC_URL ??= 'http://localhost:5173';
process.env.FILES_DATA_DIR ??= new URL('../../data/dev', import.meta.url).pathname;
process.env.FILES_SESSION_SECRET ??= 'dev-only-session-secret-0123456789abcdef';
process.env.FILES_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
await import('./main.ts');
```
`dev.ts` is never bundled: `build.mjs` only bundles `main.ts`. The `??=` values are dev-only and never reach production, because the container runs `dist/main.js`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @files/server test && pnpm --filter @files/server typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): app factory, error mapping, security headers, fake IdP harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Path resolver `resolveInRoot`

**Files:**
- Create: `server/src/storage/resolveInRoot.ts`, `server/test/resolveInRoot.test.ts`

**Interfaces:**
- Produces: `resolveInRoot(root: string, userPath: string): Promise<string>`, which returns an absolute path. It throws `AppError('PATH_INVALID')` or `AppError('PATH_SYMLINK')`. Also `normalizeUserPath(userPath: string): string`, which returns the NFC form, a leading `/`, and no trailing `/` except for the root.

- [ ] **Step 1: Failing test**

`server/test/resolveInRoot.test.ts`:
```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInRoot, normalizeUserPath } from '../src/storage/resolveInRoot.ts';

let root: string; let outside: string;
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'files-rir-')));
  root = join(base, 'home'); outside = join(base, 'outside');
  mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'x');
});

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('resolveInRoot', () => {
  it('resolves a normal path inside the root', async () => {
    expect(await resolveInRoot(root, '/docs/a.txt')).toBe(join(root, 'docs', 'a.txt'));
  });
  it('resolves "/" to the root itself', async () => {
    expect(await resolveInRoot(root, '/')).toBe(root);
  });
  it.each(['/../outside/secret.txt', '/docs/../../outside', '..', '/docs/..', 'a\u0000b', '/a\nb', ''])(
    'rejects %j as PATH_INVALID', async (p) => {
      expect(await code(resolveInRoot(root, p))).toBe('PATH_INVALID');
    });
  it('rejects a symlinked leaf', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expect(await code(resolveInRoot(root, '/link.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a symlinked intermediate directory', async () => {
    symlinkSync(outside, join(root, 'docs', 'out'));
    expect(await code(resolveInRoot(root, '/docs/out/secret.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a symlinked intermediate even when the leaf does not exist yet', async () => {
    symlinkSync(outside, join(root, 'out'));
    expect(await code(resolveInRoot(root, '/out/new.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a root that is itself reached through a sibling prefix', async () => {
    mkdirSync(root + '2');
    expect(await code(resolveInRoot(root, '/../home2/x'))).toBe('PATH_INVALID');
  });
  it('allows non-existing nested paths (for mkdir/upload)', async () => {
    expect(await resolveInRoot(root, '/new/deeper/file.txt')).toBe(join(root, 'new', 'deeper', 'file.txt'));
  });
});

describe('normalizeUserPath', () => {
  it('normalises NFD to NFC and trims trailing slash', () => {
    expect(normalizeUserPath('/Prüfung/')).toBe('/Prüfung');
  });
  it('keeps names with spaces, %, # and emoji', () => {
    expect(normalizeUserPath('/a b/50% #1 🎉.txt')).toBe('/a b/50% #1 🎉.txt');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @files/server test -- resolveInRoot`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

`server/src/storage/resolveInRoot.ts`:
```ts
import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AppError } from '../errors.ts';

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f]/;

export function normalizeUserPath(userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0 || FORBIDDEN.test(userPath)) {
    throw new AppError('PATH_INVALID');
  }
  const segments = userPath.normalize('NFC').split('/').filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === '.' || s === '..' || s.includes('\\')) throw new AppError('PATH_INVALID');
    if (Buffer.byteLength(s) > 255) throw new AppError('PATH_INVALID');
  }
  return '/' + segments.join('/');
}

export async function resolveInRoot(root: string, userPath: string): Promise<string> {
  const normalized = normalizeUserPath(userPath);
  const realRoot = await realpath(root);
  const segments = normalized.split('/').filter(Boolean);
  let current = realRoot;
  for (const s of segments) {
    current = join(current, s);
    let st;
    try { st = await lstat(current); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; // handled: rest does not exist yet
      throw err;
    }
    if (st.isSymbolicLink()) throw new AppError('PATH_SYMLINK');
  }
  const target = join(realRoot, ...segments);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new AppError('PATH_INVALID');
  return target;
}
```

- [ ] **Step 4: Sabotage check (mutation)**

Temporarily replace `if (st.isSymbolicLink()) throw …` with `void st;`, run `pnpm --filter @files/server test -- resolveInRoot`, and confirm that the 3 symlink tests FAIL. Then revert. Do the same for the `..` check in `normalizeUserPath`: the PATH_INVALID cases must fail.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @files/server test -- resolveInRoot`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): resolveInRoot rejects traversal and symlinks at every level

Refs #91

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OIDC login, sessions, deny-by-default, CSRF

**Files:**
- Create: `server/src/auth/sessions.ts`, `server/src/auth/oidc.ts`, `server/src/auth/guard.ts`, `server/src/auth/routes.ts`, `server/src/users.ts`, `server/test/auth.test.ts`
- Modify: `server/src/app.ts` (register auth), `server/test/support/harness.ts` (add `login`)

**Interfaces:**
- Consumes: `Config`, `Db`, `AppError`, `MeSchema`.
- Produces:
  - `req.user: { id: string; displayName: string; email?: string; role: 'admin'|'member' } | undefined` (Fastify request decoration)
  - `req.session: { idHash: string; csrfToken: string } | undefined`
  - `login(t: TestApp, user?: string): Promise<{ cookie: string; csrf: string }>` in the harness
  - Routes: `GET /auth/login?returnTo=` (public), `GET /auth/callback` (public), `POST /auth/logout`, `GET /api/v1/me`
  - Cookies: `fs_sid` (httpOnly, SameSite=Lax, Secure when `publicUrl` is https, path `/`), `fs_login` (httpOnly, 10-minute lifetime)
  - Session lifetime 30 days sliding? No: a fixed 14 days, renewed on login only (YAGNI).

- [ ] **Step 1: Failing tests**

`server/test/auth.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(() => t.close());

describe('deny by default', () => {
  it('rejects /api/v1/me without a session', async () => {
    const r = await t.app.inject('/api/v1/me');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
  it('rejects an unknown route under /api with 401, not 404', async () => {
    expect((await t.app.inject('/api/v1/does-not-exist')).statusCode).toBe(401);
  });
});

describe('OIDC login', () => {
  it('logs in through the real code + PKCE flow and maps the admin role', async () => {
    const s = await login(t, 'testuser');
    const r = await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ displayName: 'Test User', email: 'testuser@example.com', role: 'admin' });
  });
  it('maps a non-admin to member and keeps a stable id across logins', async () => {
    const a = await login(t, 'member');
    const b = await login(t, 'member');
    const me = async (c: string) => (await t.app.inject({ url: '/api/v1/me', headers: { cookie: c } })).json();
    expect((await me(a.cookie)).role).toBe('member');
    expect((await me(a.cookie)).id).toBe((await me(b.cookie)).id);
  });
  it('rejects a callback whose state does not match', async () => {
    const start = await t.app.inject('/auth/login');
    const loginCookie = String(start.headers['set-cookie']);
    const r = await t.app.inject({ url: '/auth/callback?code=x&state=forged', headers: { cookie: loginCookie } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ code: 'LOGIN_FAILED' });
  });
  it('rejects a callback without a login cookie even if state is supplied', async () => {
    const r = await t.app.inject('/auth/callback?code=x&state=anything');
    expect(r.statusCode).toBe(400);
  });
  it('only allows same-origin relative returnTo', async () => {
    const r = await t.app.inject('/auth/login?returnTo=https://evil.example/');
    const attempt = t.db.prepare('SELECT return_to FROM login_attempts ORDER BY rowid DESC LIMIT 1').get() as { return_to: string };
    expect(r.statusCode).toBe(302);
    expect(attempt.return_to).toBe('/');
  });
});

describe('sessions', () => {
  it('logout deletes the session server-side', async () => {
    const s = await login(t);
    const out = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://files.example.com' } });
    expect(out.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(401);
  });
  it('an expired session is rejected', async () => {
    const s = await login(t);
    t.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
});

describe('CSRF', () => {
  it('rejects a mutating request without the token', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: s.cookie, origin: 'https://files.example.com' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ code: 'CSRF' });
  });
  it('rejects a mutating request from a foreign origin even with the token', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://calendar.example.com' } });
    expect(r.statusCode).toBe(403);
  });
});
```
Add to `server/test/support/harness.ts`:
```ts
export async function login(t: TestApp, user = 'testuser'): Promise<{ cookie: string; csrf: string }> {
  const start = await t.app.inject(`/auth/login?login_hint=${encodeURIComponent(user)}`);
  if (start.statusCode !== 302) throw new Error(`login start ${start.statusCode}`);
  const loginCookie = String(start.headers['set-cookie']).split(';')[0]!;
  const idpRes = await fetch(String(start.headers.location), { redirect: 'manual' });
  const back = new URL(idpRes.headers.get('location')!);
  const cb = await t.app.inject({ url: back.pathname + back.search, headers: { cookie: loginCookie } });
  if (cb.statusCode !== 302) throw new Error(`callback ${cb.statusCode} ${cb.body}`);
  const setCookies = ([] as string[]).concat(cb.headers['set-cookie'] as string | string[]);
  const sid = setCookies.find((c) => c.startsWith('fs_sid='))!.split(';')[0]!;
  const me = await t.app.inject({ url: '/api/v1/me', headers: { cookie: sid } });
  return { cookie: sid, csrf: me.json().csrfToken };
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @files/server test -- auth`
Expected: FAIL. `/api/v1/me` returns 404, and `login` fails at `/auth/login`.

- [ ] **Step 3: Implement sessions + users**

`server/src/auth/sessions.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export function createSession(db: Db, userId: string): { id: string; csrfToken: string; expiresAt: Date } {
  const id = token(); const csrfToken = token();
  const now = new Date(); const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(hash(id), userId, csrfToken, now.toISOString(), expiresAt.toISOString());
  return { id, csrfToken, expiresAt };
}

export type SessionRow = { idHash: string; csrfToken: string; userId: string };
export function findSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare(`SELECT id_hash AS idHash, csrf_token AS csrfToken, user_id AS userId
    FROM sessions WHERE id_hash = ? AND expires_at > ?`).get(hash(id), new Date().toISOString()) as SessionRow | undefined;
}
export function deleteSession(db: Db, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export type LoginAttempt = { state: string; nonce: string; verifier: string; returnTo: string };
export function createLoginAttempt(db: Db, a: LoginAttempt): string {
  const id = token();
  db.prepare('INSERT INTO login_attempts (id_hash, state, nonce, verifier, return_to, expires_at) VALUES (?,?,?,?,?,?)')
    .run(hash(id), a.state, a.nonce, a.verifier, a.returnTo, new Date(Date.now() + LOGIN_TTL_MS).toISOString());
  return id;
}
export function takeLoginAttempt(db: Db, id: string): LoginAttempt | undefined {
  return db.transaction(() => {
    const row = db.prepare(`SELECT state, nonce, verifier, return_to AS returnTo FROM login_attempts
      WHERE id_hash = ? AND expires_at > ?`).get(hash(id), new Date().toISOString()) as LoginAttempt | undefined;
    db.prepare('DELETE FROM login_attempts WHERE id_hash = ?').run(hash(id));
    return row;
  })();
}
export function purgeExpired(db: Db): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now);
}
```
`server/src/users.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export type User = { id: string; displayName: string; email?: string; role: 'admin' | 'member' };

export function upsertUserFromClaims(db: Db, c: { iss: string; sub: string; name?: string; email?: string; isAdmin: boolean }): User {
  const now = new Date().toISOString();
  const role = c.isAdmin ? 'admin' : 'member';
  const displayName = c.name?.trim() || c.email || c.sub;
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE iss = ? AND sub = ?').get(c.iss, c.sub) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing) {
      db.prepare('UPDATE users SET display_name=?, email=?, role=?, last_login=? WHERE id=?').run(displayName, c.email ?? null, role, now, id);
    } else {
      db.prepare('INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, c.iss, c.sub, displayName, c.email ?? null, role, now, now);
    }
    return { id, displayName, ...(c.email ? { email: c.email } : {}), role };
  })();
}

export function getUser(db: Db, id: string): User | undefined {
  const r = db.prepare('SELECT id, display_name AS displayName, email, role FROM users WHERE id = ?').get(id) as
    { id: string; displayName: string; email: string | null; role: 'admin' | 'member' } | undefined;
  return r && { id: r.id, displayName: r.displayName, ...(r.email ? { email: r.email } : {}), role: r.role };
}
```

- [ ] **Step 4: Implement OIDC + routes + guard**

`server/src/auth/oidc.ts`:
```ts
import * as client from 'openid-client';
import type { Config } from '../config.ts';

export type Oidc = {
  authorizationUrl(p: { state: string; nonce: string; challenge: string; loginHint?: string }): URL;
  exchange(callbackUrl: URL, p: { state: string; nonce: string; verifier: string }): Promise<client.IDToken>;
};

export async function createOidc(config: Config): Promise<Oidc> {
  const insecure = config.oidc.issuer.protocol === 'http:';
  const conf = await client.discovery(config.oidc.issuer, config.oidc.clientId, config.oidc.clientSecret,
    client.ClientSecretBasic(config.oidc.clientSecret), insecure ? { execute: [client.allowInsecureRequests] } : undefined);
  const redirectUri = new URL('/auth/callback', config.publicUrl).href;
  return {
    authorizationUrl: ({ state, nonce, challenge, loginHint }) => client.buildAuthorizationUrl(conf, {
      redirect_uri: redirectUri, scope: 'openid profile email', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256', ...(loginHint ? { login_hint: loginHint } : {}),
    }),
    async exchange(callbackUrl, { state, nonce, verifier }) {
      const tokens = await client.authorizationCodeGrant(conf, callbackUrl,
        { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims) throw new Error('no id_token claims');
      return claims;
    },
  };
}
export const randomState = client.randomState;
export const randomNonce = client.randomNonce;
export const randomVerifier = client.randomPKCECodeVerifier;
export const challengeFor = client.calculatePKCECodeChallenge;
```
`server/src/auth/guard.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';
import { findSession } from './sessions.ts';
import { getUser, type User } from '../users.ts';

declare module 'fastify' {
  interface FastifyRequest { user?: User; session?: { idHash: string; csrfToken: string } }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerGuard(app: FastifyInstance): void {
  const { db, config } = app.deps;
  app.decorateRequest('user', undefined);
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies.fs_sid;
    if (sid) {
      const s = findSession(db, sid);
      const u = s && getUser(db, s.userId);
      if (s && u) { req.user = u; req.session = { idHash: s.idHash, csrfToken: s.csrfToken }; }
    }
    const isPublic = req.routeOptions.config?.public === true;
    const isApiOrAuth = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
    if (isPublic || !isApiOrAuth) return;
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    if (!SAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== config.publicUrl.origin) throw new AppError('CSRF');
      if (req.headers['x-csrf-token'] !== req.session!.csrfToken) throw new AppError('CSRF');
    }
  });
}
```
Non-`/api` and non-`/auth` paths are static SPA assets, which are public by design (spec 3.1).

`server/src/auth/routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { challengeFor, createOidc, randomNonce, randomState, randomVerifier } from './oidc.ts';
import { createLoginAttempt, createSession, deleteSession, takeLoginAttempt, SESSION_TTL_MS, LOGIN_TTL_MS } from './sessions.ts';
import { upsertUserFromClaims } from '../users.ts';

const safeReturnTo = (v: unknown) =>
  typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const oidc = await createOidc(config);
  const secure = config.publicUrl.protocol === 'https:';
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  app.get('/auth/login', { config: { public: true } }, async (req, reply) => {
    const q = z.object({ returnTo: z.string().optional(), login_hint: z.string().max(200).optional() }).parse(req.query);
    const state = randomState(); const nonce = randomNonce(); const verifier = randomVerifier();
    const id = createLoginAttempt(db, { state, nonce, verifier, returnTo: safeReturnTo(q.returnTo) });
    reply.setCookie('fs_login', id, { ...cookieBase, maxAge: LOGIN_TTL_MS / 1000 });
    const url = oidc.authorizationUrl({ state, nonce, challenge: await challengeFor(verifier), ...(q.login_hint ? { loginHint: q.login_hint } : {}) });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { config: { public: true } }, async (req, reply) => {
    const id = req.cookies.fs_login;
    const attempt = id ? takeLoginAttempt(db, id) : undefined;
    reply.clearCookie('fs_login', cookieBase);
    if (!attempt) throw new AppError('LOGIN_FAILED');
    const callbackUrl = new URL(req.url, config.publicUrl);
    let claims;
    try { claims = await oidc.exchange(callbackUrl, attempt); }
    catch (err) { throw new AppError('LOGIN_FAILED', undefined, { cause: err }); }
    const roleValue = claims[config.oidc.roleClaim];
    const isAdmin = Array.isArray(roleValue) ? roleValue.includes(config.oidc.adminValue) : roleValue === config.oidc.adminValue;
    const user = upsertUserFromClaims(db, { iss: claims.iss, sub: claims.sub, isAdmin,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}) });
    const s = createSession(db, user.id);
    reply.setCookie('fs_sid', s.id, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect(attempt.returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    deleteSession(db, req.session!.idHash);
    reply.clearCookie('fs_sid', cookieBase);
    return reply.status(204).send();
  });

  app.get('/api/v1/me', async (req) => ({ ...req.user!, csrfToken: req.session!.csrfToken }));
}
```
`errorHandler`: a `ZodError` thrown by `.parse()` must map to `VALIDATION`. Add to `server/src/errors.ts` before the generic branch:
```ts
import { ZodError } from 'zod';
// …
  if (err instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION' });
```
Modify `server/src/app.ts`: after `app.decorate('deps', …)` add:
```ts
  registerGuard(app);
  await registerAuthRoutes(app);
  app.setNotFoundHandler((req, reply) => {
    if (!req.user && (req.url.startsWith('/api/') || req.url.startsWith('/auth/'))) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED' });
    }
    return reply.status(404).send({ code: 'NOT_FOUND' });
  });
  const purge = setInterval(() => purgeExpired(db), 3600_000);
  purge.unref();
  app.addHook('onClose', async () => clearInterval(purge));
```
Add the imports for `registerGuard`, `registerAuthRoutes` and `purgeExpired`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @files/server test && pnpm --filter @files/server typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 6: Sabotage check**

1. Change `if (!req.user) throw …` to `if (false)`. The `deny by default` tests must fail. Revert.
2. Remove the origin check. The foreign-origin CSRF test must fail. Revert.
3. In `takeLoginAttempt`, return the row without the `expires_at` condition. Then set every `login_attempts.expires_at` into the past and run the state test from Step 1. Adding that variant as an extra test is optional; the first two mutations are mandatory.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): OIDC login with PKCE, SQLite sessions, deny-by-default, CSRF

Refs #92 #93

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: StorageBackend + LocalBackend

**Files:**
- Create: `server/src/storage/backend.ts`, `server/src/storage/local.ts`, `server/test/localBackend.test.ts`

**Interfaces:**
- Consumes: `resolveInRoot`, `normalizeUserPath` (Task 5); `Entry`, `CollisionPolicy` (Task 1); `AppError`.
- Produces:
```ts
export interface StorageBackend {
  list(path: string, cursor?: string, limit?: number): Promise<{ entries: Entry[]; next?: string }>;
  stat(path: string): Promise<Entry>;
  read(path: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number; etag: string; mime: string }>;
  write(path: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
}
export class LocalBackend implements StorageBackend { constructor(root: string) }
export function homeRoot(dataDir: string, userId: string): string  // DATA_DIR/homes/<userId>, created on demand
```

- [ ] **Step 1: Failing tests**

`server/test/localBackend.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { LocalBackend } from '../src/storage/local.ts';

let root: string; let b: LocalBackend;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'files-lb-')); b = new LocalBackend(root); });
const body = (s: string) => Readable.from([Buffer.from(s)]);
const err = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code: string }).code; } };
const opts = { onCollision: 'fail' as const, maxBytes: 1024 * 1024 };

describe('write + read', () => {
  it('round-trips a file with an awkward name', async () => {
    const name = '/Prüfung #1 50% 🎉.txt';
    const e = await b.write(name, body('hello'), opts);
    expect(e.name).toBe('Prüfung #1 50% 🎉.txt');
    const r = await b.read(e.path);
    expect(await text(r.stream)).toBe('hello');
    expect(r.size).toBe(5);
  });
  it('reads a byte range', async () => {
    await b.write('/r.txt', body('0123456789'), opts);
    const r = await b.read('/r.txt', { start: 2, end: 5 });
    expect(await text(r.stream)).toBe('2345');
  });
  it('fails with FILE_EXISTS and leaves the original untouched', async () => {
    await b.write('/a.txt', body('one'), opts);
    expect(await err(b.write('/a.txt', body('two'), opts))).toBe('FILE_EXISTS');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one');
  });
  it('replace overwrites atomically', async () => {
    await b.write('/a.txt', body('one'), opts);
    await b.write('/a.txt', body('two'), { ...opts, onCollision: 'replace' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two');
  });
  it('keep-both picks a free name', async () => {
    await b.write('/a.txt', body('one'), opts);
    const e = await b.write('/a.txt', body('two'), { ...opts, onCollision: 'keep-both' });
    expect(e.name).toBe('a (2).txt');
  });
  it('two concurrent fail-uploads: exactly one wins, content is never mixed', async () => {
    const results = await Promise.allSettled([
      b.write('/c.txt', body('A'.repeat(100000)), opts),
      b.write('/c.txt', body('B'.repeat(100000)), opts),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const content = readFileSync(join(root, 'c.txt'), 'utf8');
    expect(content === 'A'.repeat(100000) || content === 'B'.repeat(100000)).toBe(true);
  });
  it('an aborted upload leaves neither target nor temp file', async () => {
    const s = new PassThrough();
    const p = b.write('/broken.bin', s, opts);
    s.write(Buffer.alloc(1000));
    s.destroy(new Error('client went away'));
    await expect(p).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
  it('rejects a body larger than maxBytes and cleans up', async () => {
    expect(await err(b.write('/big.bin', body('x'.repeat(2000)), { ...opts, maxBytes: 1000 }))).toBe('PAYLOAD_TOO_LARGE');
    expect(readdirSync(root)).toEqual([]);
  });
  it('refuses to write through a directory path', async () => {
    mkdirSync(join(root, 'd'));
    expect(await err(b.write('/d', body('x'), opts))).toBe('IS_A_DIRECTORY');
  });
});

describe('list', () => {
  it('paginates 1200 entries, every entry exactly once, folders first then by name', async () => {
    mkdirSync(join(root, 'big'));
    for (let i = 0; i < 1200; i++) writeFileSync(join(root, 'big', `f${String(i).padStart(4, '0')}.txt`), '');
    mkdirSync(join(root, 'big', 'zz-folder'));
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await b.list('/big', cursor, 500);
      seen.push(...page.entries.map((e) => e.name));
      cursor = page.next;
    } while (cursor);
    expect(seen).toHaveLength(1201);
    expect(new Set(seen).size).toBe(1201);
    expect(seen[0]).toBe('zz-folder');
  });
  it('hides the internal .files directory', async () => {
    mkdirSync(join(root, '.files'));
    expect((await b.list('/')).entries).toEqual([]);
  });
  it('returns NOT_FOUND and NOT_A_DIRECTORY correctly', async () => {
    await b.write('/f.txt', body('x'), opts);
    expect(await err(b.list('/nope'))).toBe('NOT_FOUND');
    expect(await err(b.list('/f.txt'))).toBe('NOT_A_DIRECTORY');
  });
});

describe('mkdir', () => {
  it('creates nested folders and refuses an existing one', async () => {
    const e = await b.mkdir('/a/b');
    expect(e.type).toBe('directory');
    expect(await err(b.mkdir('/a/b'))).toBe('FILE_EXISTS');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @files/server test -- localBackend`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

`server/src/storage/backend.ts`:
```ts
import type { Readable } from 'node:stream';
import type { CollisionPolicy, Entry } from '@files/shared';

export interface StorageBackend {
  list(path: string, cursor?: string, limit?: number): Promise<{ entries: Entry[]; next?: string }>;
  stat(path: string): Promise<Entry>;
  read(path: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number; etag: string; mime: string }>;
  write(path: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
}
```
`server/src/storage/local.ts`:
```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../errors.ts';
import { normalizeUserPath, resolveInRoot } from './resolveInRoot.ts';
import type { StorageBackend } from './backend.ts';
import { lookupMime } from './mime.ts';

const INTERNAL = '.files';
const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;

export function homeRoot(dataDir: string, userId: string): string {
  return join(dataDir, 'homes', userId);
}

export class LocalBackend implements StorageBackend {
  constructor(private root: string) {}

  private async abs(p: string) { await mkdir(this.root, { recursive: true }); return resolveInRoot(this.root, p); }

  private entry(userPath: string, st: { isDirectory(): boolean; size: number; mtime: Date }): Entry {
    const path = normalizeUserPath(userPath);
    const name = path === '/' ? '/' : basename(path);
    const isDir = st.isDirectory();
    return { name, path, type: isDir ? 'directory' : 'file', size: isDir ? 0 : st.size,
      modified: st.mtime.toISOString(), ...(isDir ? {} : { mime: lookupMime(name) }) };
  }

  async stat(p: string): Promise<Entry> {
    const a = await this.abs(p);
    try { return this.entry(p, await lstat(a)); }
    catch (e) { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; }
  }

  async list(p: string, cursor?: string, limit = 500) {
    const a = await this.abs(p);
    let dirents;
    try { dirents = await readdir(a, { withFileTypes: true }); }
    catch (e) {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND');
      if (isErr(e, 'ENOTDIR')) throw new AppError('NOT_A_DIRECTORY');
      throw e;
    }
    const base = normalizeUserPath(p);
    const visible = dirents
      .filter((d) => !(base === '/' && d.name === INTERNAL) && (d.isFile() || d.isDirectory()))
      .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name, 'en') : x.isDirectory() ? -1 : 1));
    const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    if (!Number.isInteger(start) || start < 0) throw new AppError('VALIDATION');
    const slice = visible.slice(start, start + limit);
    const entries = await Promise.all(slice.map(async (d) => {
      const child = (base === '/' ? '' : base) + '/' + d.name;
      return this.entry(child, await lstat(join(a, d.name)));
    }));
    const nextIdx = start + slice.length;
    return nextIdx < visible.length ? { entries, next: Buffer.from(String(nextIdx)).toString('base64url') } : { entries };
  }

  async read(p: string, range?: { start: number; end: number }) {
    const a = await this.abs(p);
    let st;
    try { st = await lstat(a); }
    catch (e) { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; }
    if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (range && (range.start > range.end || range.end >= st.size)) throw new AppError('RANGE_NOT_SATISFIABLE');
    const stream = createReadStream(a, range ? { start: range.start, end: range.end } : {});
    return { stream, size: st.size, etag: `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`, mime: lookupMime(basename(a)) };
  }

  async mkdir(p: string): Promise<Entry> {
    const a = await this.abs(p);
    try { await lstat(a); throw new AppError('FILE_EXISTS'); }
    catch (e) { if (!isErr(e, 'ENOENT')) throw e; }
    await mkdir(a, { recursive: true });
    return this.stat(p);
  }

  async write(p: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry> {
    const target = await this.abs(p);
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    try { if ((await lstat(target)).isDirectory()) throw new AppError('IS_A_DIRECTORY'); }
    catch (e) { if (!isErr(e, 'ENOENT')) throw e; }
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.upload`);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        cb(written > opts.maxBytes ? new AppError('PAYLOAD_TOO_LARGE') : null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp, { flags: 'wx' }));
      const fh = await open(tmp, 'r+'); await fh.sync(); await fh.close();
      const finalPath = await this.place(tmp, target, opts.onCollision);
      const rel = normalizeUserPath(p);
      return this.stat(join(dirname(rel), basename(finalPath)));
    } catch (e) {
      await unlink(tmp).catch((u) => { if (!isErr(u, 'ENOENT')) throw u; }); // handled: tmp may not exist yet
      throw e;
    }
  }

  private async place(tmp: string, target: string, policy: CollisionPolicy): Promise<string> {
    if (policy === 'replace') { await rename(tmp, target); return target; }
    const candidates = policy === 'fail' ? [target] : Array.from({ length: 1000 }, (_, i) => i === 0 ? target : numbered(target, i + 1));
    for (const c of candidates) {
      try { await link(tmp, c); await unlink(tmp); return c; }
      catch (e) { if (!isErr(e, 'EEXIST')) throw e; }
    }
    throw new AppError('FILE_EXISTS', { name: basename(target) });
  }
}

function numbered(target: string, n: number): string {
  const ext = extname(target);
  return join(dirname(target), `${basename(target, ext)} (${n})${ext}`);
}
```
`server/src/storage/mime.ts`:
```ts
const MAP: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  json: 'application/json', zip: 'application/zip', html: 'text/html', svg: 'image/svg+xml',
};
export function lookupMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MAP[ext] ?? 'application/octet-stream';
}
```
In `place`, the `catch` around `link` handles `EEXIST` by trying the next candidate; every other error is rethrown. The `catch` in `write` deletes the temp file and rethrows. Both satisfy the lint rule.

In `mkdir`, the `try { await lstat(a); throw new AppError('FILE_EXISTS') }` construction catches its own `AppError`. Restructure it as:
```ts
  async mkdir(p: string): Promise<Entry> {
    const a = await this.abs(p);
    const exists = await lstat(a).then(() => true, (e) => { if (isErr(e, 'ENOENT')) return false; throw e; });
    if (exists) throw new AppError('FILE_EXISTS');
    await mkdir(a, { recursive: true });
    return this.stat(p);
  }
```
Use the same pattern for the directory check in `write`:
```ts
    const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    if (st?.isDirectory()) throw new AppError('IS_A_DIRECTORY');
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @files/server test -- localBackend && pnpm lint`
Expected: all pass.

- [ ] **Step 5: Sabotage check**

1. In `place`, replace the `fail` branch with `rename(tmp, target)`. The `FILE_EXISTS` test and the concurrent-upload test must fail. Revert.
2. Remove the `unlink(tmp)` in the `catch`. The aborted-upload and too-large tests must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): StorageBackend and LocalBackend with atomic streaming writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sources API (list, stat, download with Range, upload, mkdir)

**Files:**
- Create: `server/src/http/range.ts`, `server/src/routes/sources.ts`, `server/test/range.test.ts`, `server/test/sources.test.ts`
- Modify: `server/src/app.ts` (register sources routes)

**Interfaces:**
- Consumes: `LocalBackend`, `homeRoot` (Task 7); `req.user` (Task 6); `login`, `startTestApp` (harness).
- Produces HTTP:
  - `GET /api/v1/sources/home/list?path=/&cursor=` returns `ListResponse`
  - `GET /api/v1/sources/home/stat?path=` returns `Entry`
  - `GET /api/v1/sources/home/content?path=&download=1` streams the file and honours `Range: bytes=a-b`. It always sends `Content-Disposition`: `attachment` when `download=1` or when the MIME type is `text/html`, `image/svg+xml`, `application/xhtml+xml` or `text/xml`; otherwise `inline`. The filename is RFC 5987-encoded.
  - `PUT /api/v1/sources/home/content?path=&onCollision=fail|replace|keep-both` with `Content-Type: application/octet-stream`, returns `201 Entry`
  - `POST /api/v1/sources/home/mkdir` with body `{ path }`, returns `201 Entry`
  - Any `:source` other than `home` gets `404 NOT_FOUND` (cloud sources arrive in Phase D)
- Produces TS: `parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | 'unsatisfiable'`

- [ ] **Step 1: Failing range test**

`server/test/range.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/http/range.ts';

describe('parseRange', () => {
  it.each([
    [undefined, 100, undefined],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=5-2', 100, 'unsatisfiable'],
    ['bytes=0-1,4-5', 100, undefined],
    ['items=0-1', 100, undefined],
  ] as const)('%s of %d', (h, size, expected) => {
    expect(parseRange(h, size)).toEqual(expected);
  });
});
```
Multi-range and unknown units fall back to a full `200` response. RFC 9110 allows that.

- [ ] **Step 2: Failing route tests**

`server/test/sources.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp; let a: { cookie: string; csrf: string }; let m: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
beforeAll(async () => { t = await startTestApp(); a = await login(t, 'testuser'); m = await login(t, 'member'); });
afterAll(() => t.close());

const put = (s: typeof a, path: string, payload: string | Buffer, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload,
});
const get = (s: typeof a, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url, headers: { cookie: s.cookie, ...headers } });

describe('sources/home', () => {
  it('upload, list and download round-trip a file with an awkward name', async () => {
    const name = '/Prüfung #1 50%.txt';
    const up = await put(a, name, 'hallo');
    expect(up.statusCode).toBe(201);
    const list = (await get(a, '/api/v1/sources/home/list?path=%2F')).json();
    expect(list.entries.map((e: { name: string }) => e.name)).toContain('Prüfung #1 50%.txt');
    const dl = await get(a, `/api/v1/sources/home/content?path=${encodeURIComponent(name)}&download=1`);
    expect(dl.body).toBe('hallo');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('Prüfung #1 50%.txt')}`);
  });
  it('answers a Range request with 206', async () => {
    await put(a, '/digits.txt', '0123456789');
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fdigits.txt', { range: 'bytes=2-4' });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe('234');
    expect(r.headers['content-range']).toBe('bytes 2-4/10');
  });
  it('serves active content types as attachment even without download=1', async () => {
    await put(a, '/evil.html', '<script>alert(1)</script>');
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fevil.html');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
  });
  it('isolates members: a member cannot see the admin home', async () => {
    const list = (await get(m, '/api/v1/sources/home/list?path=%2F')).json();
    expect(list.entries).toEqual([]);
    const r = await get(m, '/api/v1/sources/home/content?path=%2Fdigits.txt');
    expect(r.statusCode).toBe(404);
  });
  it('rejects traversal in every parameter', async () => {
    expect((await get(a, '/api/v1/sources/home/list?path=%2F..%2F..')).json()).toEqual({ code: 'PATH_INVALID' });
    expect((await put(a, '/../escape.txt', 'x')).json()).toEqual({ code: 'PATH_INVALID' });
  });
  it('returns FILE_EXISTS on collision with fail and keeps both with keep-both', async () => {
    await put(a, '/dup.txt', 'one');
    expect((await put(a, '/dup.txt', 'two')).statusCode).toBe(409);
    expect((await put(a, '/dup.txt', 'two', 'keep-both')).json().name).toBe('dup (2).txt');
  });
  it('rejects an upload larger than FILES_MAX_UPLOAD_BYTES', async () => {
    const small = await startTestApp({ FILES_MAX_UPLOAD_BYTES: '10' });
    const s = await login(small);
    const r = await small.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fbig.bin&onCollision=fail',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(11) });
    expect(r.statusCode).toBe(413);
    await small.close();
  });
  it('creates folders', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: '/Neu/Ordner' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Ordner', type: 'directory' });
  });
  it('requires a session', async () => {
    expect((await t.app.inject('/api/v1/sources/home/list?path=%2F')).statusCode).toBe(401);
  });
  it('rejects unknown sources', async () => {
    expect((await get(a, '/api/v1/sources/conn:1/list?path=%2F')).statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @files/server test -- range sources`
Expected: FAIL.

- [ ] **Step 4: Implement**

`server/src/http/range.ts`:
```ts
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | 'unsatisfiable' {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, s, e] = m;
  if (s === '' && e === '') return undefined;
  let start: number; let end: number;
  if (s === '') { const n = Number(e); if (n === 0) return 'unsatisfiable'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(s); end = e === '' ? size - 1 : Math.min(Number(e), size - 1); }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
```
`server/src/routes/sources.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { CollisionPolicy } from '@files/shared';
import { AppError } from '../errors.ts';
import { LocalBackend, homeRoot } from '../storage/local.ts';
import type { StorageBackend } from '../storage/backend.ts';
import { parseRange } from '../http/range.ts';

const ACTIVE = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml']);
const PathQ = z.object({ path: z.string().min(1) });

function backendFor(app: FastifyInstance, req: FastifyRequest): StorageBackend {
  const { source } = z.object({ source: z.string() }).parse(req.params);
  if (source !== 'home') throw new AppError('NOT_FOUND');
  return new LocalBackend(homeRoot(app.deps.config.dataDir, req.user!.id));
}

const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/api/v1/sources/:source/list', async (req) => {
    const q = z.object({ path: z.string().min(1), cursor: z.string().optional() }).parse(req.query);
    return backendFor(app, req).list(q.path, q.cursor);
  });

  app.get('/api/v1/sources/:source/stat', async (req) => backendFor(app, req).stat(PathQ.parse(req.query).path));

  app.get('/api/v1/sources/:source/content', async (req, reply) => {
    const q = z.object({ path: z.string().min(1), download: z.literal('1').optional() }).parse(req.query);
    const b = backendFor(app, req);
    const entry = await b.stat(q.path);
    if (entry.type === 'directory') throw new AppError('IS_A_DIRECTORY');
    const range = parseRange(req.headers.range, entry.size);
    if (range === 'unsatisfiable') {
      reply.header('content-range', `bytes */${entry.size}`);
      throw new AppError('RANGE_NOT_SATISFIABLE');
    }
    const r = await b.read(q.path, range);
    const kind = q.download || ACTIVE.has(r.mime) ? 'attachment' : 'inline';
    reply.header('content-type', r.mime).header('etag', r.etag).header('accept-ranges', 'bytes')
      .header('content-disposition', disposition(kind, entry.name)).header('cache-control', 'private, no-cache');
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${r.size}`)
        .header('content-length', range.end - range.start + 1);
    } else {
      reply.header('content-length', r.size);
    }
    return reply.send(r.stream);
  });

  app.put('/api/v1/sources/:source/content', async (req, reply) => {
    const q = z.object({ path: z.string().min(1), onCollision: CollisionPolicy }).parse(req.query);
    const max = app.deps.config.maxUploadBytes;
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new AppError('PAYLOAD_TOO_LARGE');
    const entry = await backendFor(app, req).write(q.path, req.body as Readable, { onCollision: q.onCollision, maxBytes: max });
    return reply.status(201).send(entry);
  });

  app.post('/api/v1/sources/:source/mkdir', async (req, reply) => {
    const body = PathQ.parse(req.body);
    return reply.status(201).send(await backendFor(app, req).mkdir(body.path));
  });
}
```
Modify `server/src/app.ts`: after `await registerAuthRoutes(app);` add `await registerSourceRoutes(app);` together with its import.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @files/server test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 6: Sabotage check**

1. Change `kind` to always be `'inline'`. The active-content test must fail. Revert.
2. Change `backendFor` to use `homeRoot(dataDir, 'shared')`. The isolation test must fail. Revert.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): sources API for the shard home with streaming upload/download and Range

Refs #113

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web shell — tokens, fonts, i18n

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.ts`, `web/src/App.vue`, `web/src/router.ts`, `web/src/i18n/index.ts`, `web/src/i18n/{de-du,de-sie,en}.json`, `web/src/styles/{tokens,components,app}.css`, `web/test/i18n.test.ts`
- Modify: `server/src/app.ts` (serve `web/dist` via @fastify/static with SPA fallback)

**Interfaces:**
- Produces: `i18n` instance; `LOCALES = ['de-du','de-sie','en'] as const`; `resolveLocale(stored: string | null, browser: readonly string[]): Locale`; the CSS custom properties from the design guide.

- [ ] **Step 1: Copy design tokens**

```bash
DG=$(mktemp -d)
git show 797ec89:freeshard-design-guide.zip > "$DG/dg.zip" && unzip -oq "$DG/dg.zip" -d "$DG"
mkdir -p web/src/styles && cp "$DG/tokens/tokens.css" web/src/styles/tokens.css && cp "$DG/tokens/components.css" web/src/styles/components.css
cp "$DG/design-guide.md" "$DG/DECISIONS.md" docs/   # docs/design-guide.md, docs/design-decisions.md (rename the second)
mv docs/DECISIONS.md docs/design-decisions.md
```
Read `$DG/design-guide.md` and `$DG/DECISIONS.md` completely before writing any UI. They are binding: no glass, no blur, no ornament, honest visuals, line icons.

- [ ] **Step 2: Package + Vite**

`web/package.json`:
```json
{
  "name": "@files/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vue-tsc --noEmit && vite build", "typecheck": "vue-tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@files/shared": "workspace:*",
    "@fontsource/ibm-plex-mono": "^5.2.0",
    "@fontsource/inter": "^5.2.0",
    "pinia": "^3.0.0",
    "vue": "^3.5.0",
    "vue-i18n": "^11.1.0",
    "vue-router": "^4.6.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0",
    "@vue/test-utils": "^2.4.0",
    "happy-dom": "^20.0.0",
    "vite": "^7.1.0",
    "vitest": "^4.0.0",
    "vue-tsc": "^3.1.0"
  }
}
```
`web/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "compilerOptions": { "types": ["vite/client"], "jsx": "preserve" }, "include": ["src", "test"] }
```
`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': 'http://localhost:3005', '/auth': 'http://localhost:3005' } },
  test: { environment: 'happy-dom' },
});
```

- [ ] **Step 3: Failing i18n test**

`web/test/i18n.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import deDu from '../src/i18n/de-du.json';
import deSie from '../src/i18n/de-sie.json';
import en from '../src/i18n/en.json';
import { resolveLocale } from '../src/i18n/index.ts';

type Tree = { [k: string]: string | Tree };
const keys = (t: Tree, p = ''): string[] => Object.entries(t).flatMap(([k, v]) => typeof v === 'string' ? [p + k] : keys(v, p + k + '.'));
const values = (t: Tree): string[] => Object.values(t).flatMap((v) => typeof v === 'string' ? [v] : values(v));

describe('locales', () => {
  it('every language has exactly the same keys', () => {
    const ref = keys(deDu as Tree).sort();
    expect(keys(deSie as Tree).sort()).toEqual(ref);
    expect(keys(en as Tree).sort()).toEqual(ref);
  });
  it('Deutsch (Du) never uses Sie-forms', () => {
    for (const v of values(deDu as Tree)) expect(v, v).not.toMatch(/\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer)\b/);
  });
  it('Deutsch (Sie) never uses Du-forms', () => {
    for (const v of values(deSie as Tree)) expect(v, v).not.toMatch(/\b(du|dich|dir|dein|deine|deinen|deinem|deiner|Du|Dich|Dir|Dein|Deine)\b/);
  });
  it('no value is empty', () => {
    for (const t of [deDu, deSie, en]) for (const v of values(t as Tree)) expect(v.trim()).not.toBe('');
  });
});

describe('resolveLocale', () => {
  it('prefers the stored setting', () => expect(resolveLocale('en', ['de-DE'])).toBe('en'));
  it('maps a German browser to de-du', () => expect(resolveLocale(null, ['de-AT', 'en'])).toBe('de-du'));
  it('maps an English browser to en', () => expect(resolveLocale(null, ['en-GB'])).toBe('en'));
  it('falls back to de-du', () => expect(resolveLocale(null, ['fr-FR'])).toBe('de-du'));
  it('ignores an unknown stored value', () => expect(resolveLocale('xx', ['en-US'])).toBe('en'));
});
```
The platform-preference source (freeshard#168) is not available yet. `resolveLocale` gets a `platform` parameter once it is. Record this in DECISIONS.md (Task 13).

- [ ] **Step 4: Run to verify failure**

Run: `pnpm install && pnpm --filter @files/web test`
Expected: FAIL, missing files.

- [ ] **Step 5: Implement i18n + shell**

`web/src/i18n/index.ts`:
```ts
import { createI18n } from 'vue-i18n';
import deDu from './de-du.json';
import deSie from './de-sie.json';
import en from './en.json';

export const LOCALES = ['de-du', 'de-sie', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

export function resolveLocale(stored: string | null, browser: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const b of browser) {
    const lang = b.toLowerCase().split('-')[0];
    if (lang === 'de') return 'de-du';
    if (lang === 'en') return 'en';
  }
  return 'de-du';
}

function storedLocale(): string | null {
  try { return localStorage.getItem('files.locale'); }
  catch { return null; } // handled: storage blocked (private mode) → fall back to browser languages
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(storedLocale(), navigator.languages ?? [navigator.language]),
  fallbackLocale: 'de-du',
  messages: { 'de-du': deDu, 'de-sie': deSie, en },
});
```
`web/src/i18n/de-du.json`:
```json
{
  "app": { "name": "Dateien" },
  "nav": { "home": "Mein Speicher", "breadcrumbRoot": "Mein Speicher" },
  "folder": {
    "empty": "Dieser Ordner ist leer.",
    "loading": "Wird geladen …",
    "columns": { "name": "Name", "size": "Größe", "modified": "Geändert" },
    "newFolder": "Neuer Ordner",
    "newFolderPrompt": "Wie soll der Ordner heißen?",
    "create": "Erstellen",
    "cancel": "Abbrechen"
  },
  "upload": {
    "button": "Hochladen",
    "progress": "{name}: {percent} %",
    "done": "{name} hochgeladen",
    "exists": "{name} gibt es hier schon. Wähle einen anderen Namen oder lade sie als Kopie hoch.",
    "keepBoth": "Als Kopie hochladen",
    "replace": "Ersetzen",
    "skip": "Überspringen"
  },
  "errors": {
    "UNAUTHENTICATED": "Du bist nicht mehr angemeldet.",
    "FORBIDDEN": "Dafür fehlt dir die Berechtigung.",
    "CSRF": "Die Anfrage wurde aus Sicherheitsgründen abgelehnt. Lade die Seite neu.",
    "VALIDATION": "Die Eingabe ist ungültig.",
    "NOT_FOUND": "Das gibt es nicht (mehr).",
    "FILE_EXISTS": "Ein Eintrag mit diesem Namen existiert bereits.",
    "PATH_INVALID": "Dieser Name oder Pfad ist nicht erlaubt.",
    "PATH_SYMLINK": "Verknüpfungen werden aus Sicherheitsgründen nicht geöffnet.",
    "NOT_A_DIRECTORY": "Das ist kein Ordner.",
    "IS_A_DIRECTORY": "Das ist ein Ordner, keine Datei.",
    "PAYLOAD_TOO_LARGE": "Die Datei ist zu groß.",
    "RANGE_NOT_SATISFIABLE": "Dieser Teil der Datei existiert nicht.",
    "LOGIN_FAILED": "Die Anmeldung hat nicht geklappt. Versuch es noch einmal.",
    "INTERNAL": "Etwas ist schiefgelaufen. Versuch es später noch einmal.",
    "NETWORK": "Keine Verbindung zum Shard."
  },
  "a11y": { "fileList": "Dateien in {folder}", "breadcrumbs": "Pfad" }
}
```
`web/src/i18n/de-sie.json` has the same keys. Write each Sie form out in full:
```json
{
  "app": { "name": "Dateien" },
  "nav": { "home": "Mein Speicher", "breadcrumbRoot": "Mein Speicher" },
  "folder": {
    "empty": "Dieser Ordner ist leer.",
    "loading": "Wird geladen …",
    "columns": { "name": "Name", "size": "Größe", "modified": "Geändert" },
    "newFolder": "Neuer Ordner",
    "newFolderPrompt": "Wie soll der Ordner heißen?",
    "create": "Erstellen",
    "cancel": "Abbrechen"
  },
  "upload": {
    "button": "Hochladen",
    "progress": "{name}: {percent} %",
    "done": "{name} hochgeladen",
    "exists": "{name} gibt es hier schon. Wählen Sie einen anderen Namen oder laden Sie die Datei als Kopie hoch.",
    "keepBoth": "Als Kopie hochladen",
    "replace": "Ersetzen",
    "skip": "Überspringen"
  },
  "errors": {
    "UNAUTHENTICATED": "Sie sind nicht mehr angemeldet.",
    "FORBIDDEN": "Dafür fehlt Ihnen die Berechtigung.",
    "CSRF": "Die Anfrage wurde aus Sicherheitsgründen abgelehnt. Bitte laden Sie die Seite neu.",
    "VALIDATION": "Die Eingabe ist ungültig.",
    "NOT_FOUND": "Das gibt es nicht (mehr).",
    "FILE_EXISTS": "Ein Eintrag mit diesem Namen existiert bereits.",
    "PATH_INVALID": "Dieser Name oder Pfad ist nicht erlaubt.",
    "PATH_SYMLINK": "Verknüpfungen werden aus Sicherheitsgründen nicht geöffnet.",
    "NOT_A_DIRECTORY": "Das ist kein Ordner.",
    "IS_A_DIRECTORY": "Das ist ein Ordner, keine Datei.",
    "PAYLOAD_TOO_LARGE": "Die Datei ist zu groß.",
    "RANGE_NOT_SATISFIABLE": "Dieser Teil der Datei existiert nicht.",
    "LOGIN_FAILED": "Die Anmeldung hat nicht geklappt. Bitte versuchen Sie es erneut.",
    "INTERNAL": "Etwas ist schiefgelaufen. Bitte versuchen Sie es später erneut.",
    "NETWORK": "Keine Verbindung zum Shard."
  },
  "a11y": { "fileList": "Dateien in {folder}", "breadcrumbs": "Pfad" }
}
```
`web/src/i18n/en.json`:
```json
{
  "app": { "name": "Files" },
  "nav": { "home": "My storage", "breadcrumbRoot": "My storage" },
  "folder": {
    "empty": "This folder is empty.",
    "loading": "Loading …",
    "columns": { "name": "Name", "size": "Size", "modified": "Modified" },
    "newFolder": "New folder",
    "newFolderPrompt": "What should the folder be called?",
    "create": "Create",
    "cancel": "Cancel"
  },
  "upload": {
    "button": "Upload",
    "progress": "{name}: {percent} %",
    "done": "{name} uploaded",
    "exists": "{name} already exists here. Pick another name or upload it as a copy.",
    "keepBoth": "Upload as copy",
    "replace": "Replace",
    "skip": "Skip"
  },
  "errors": {
    "UNAUTHENTICATED": "You are no longer signed in.",
    "FORBIDDEN": "You don't have permission to do that.",
    "CSRF": "The request was rejected for security reasons. Reload the page.",
    "VALIDATION": "The input is not valid.",
    "NOT_FOUND": "This doesn't exist (any more).",
    "FILE_EXISTS": "An item with this name already exists.",
    "PATH_INVALID": "This name or path is not allowed.",
    "PATH_SYMLINK": "Links are not opened, for security reasons.",
    "NOT_A_DIRECTORY": "This is not a folder.",
    "IS_A_DIRECTORY": "This is a folder, not a file.",
    "PAYLOAD_TOO_LARGE": "The file is too large.",
    "RANGE_NOT_SATISFIABLE": "This part of the file does not exist.",
    "LOGIN_FAILED": "Signing in didn't work. Please try again.",
    "INTERNAL": "Something went wrong. Please try again later.",
    "NETWORK": "No connection to the shard."
  },
  "a11y": { "fileList": "Files in {folder}", "breadcrumbs": "Path" }
}
```
`web/src/styles/app.css`:
```css
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import './tokens.css';
@import './components.css';

html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg, #fff); color: var(--fg, #111); font-family: Inter, system-ui, sans-serif; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```
Use whichever variable names `tokens.css` actually defines. Replace `--bg`, `--fg` and `--accent` with the real token names after reading `tokens.css`, and never invent new colours.

`web/index.html`:
```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Files</title>
  </head>
  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>
```
`web/src/router.ts`:
```ts
import { createRouter, createWebHistory } from 'vue-router';
import FolderView from './views/FolderView.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:path(.*)*', component: FolderView }],
});
```
`web/src/main.ts`:
```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import { i18n } from './i18n/index.ts';
import './styles/app.css';

createApp(App).use(createPinia()).use(router).use(i18n).mount('#app');
```
`web/src/App.vue`:
```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from './stores/session.ts';
const session = useSessionStore();
onMounted(() => session.load());
</script>

<template>
  <div class="app-shell">
    <header class="app-header"><span class="app-title">{{ $t('app.name') }}</span></header>
    <main v-if="session.me"><RouterView /></main>
  </div>
</template>
```
`FolderView` and the stores arrive in Task 10. For this task, create `web/src/views/FolderView.vue` as a minimal stub: `<template><div /></template>`. Create `web/src/stores/session.ts` as a minimal stub too: a store with `me = null` and an empty async `load()`. Task 10 replaces both, and the build needs them.

- [ ] **Step 6: Serve the SPA from the server**

In `server/src/app.ts`, register static serving last, before `extend?.(app)`:
```ts
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// …
  const webDist = process.env.FILES_WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.get('/*', { config: { public: true } }, (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) return reply.callNotFound();
      return reply.sendFile('index.html');
    });
  }
```
Move the `setNotFoundHandler` from Task 6 so that it sits before this block. `FILES_WEB_DIST` is a path override for the container layout; Task 12 sets it to `/app/web`. It is not a security setting, so the "no defaults" rule does not apply.

- [ ] **Step 7: Run tests + build**

Run: `pnpm --filter @files/web test && pnpm --filter @files/web build && pnpm lint && pnpm --filter @files/server test`
Expected: all pass, and `web/dist/index.html` exists.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(web): Vue shell with design tokens, self-hosted fonts, three locales

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Folder view — API client, stores, browse, upload, download

**Files:**
- Create: `web/src/api/client.ts`, `web/src/stores/session.ts`, `web/src/stores/folder.ts`, `web/src/components/FileList.vue`, `web/src/components/Breadcrumbs.vue`, `web/src/components/UploadButton.vue`, `web/src/format.ts`, `web/test/client.test.ts`, `web/test/folderStore.test.ts`
- Modify: `web/src/views/FolderView.vue`

**Interfaces:**
- Consumes: `/api/v1/me`, `/api/v1/sources/home/*` (Task 8), `ApiError`, `Entry`, `ListResponse`, `Me` (Task 1), i18n (Task 9).
- Produces:
  - `api.get<T>(path, query?)`, `api.put<T>(path, query, body: Blob, onProgress?)`, `api.post<T>(path, body)`. They throw `ApiFailure { code: ErrorCode | 'NETWORK'; params? }`. On a 401 they call `redirectToLogin()`, which sets `window.location.href = '/auth/login?returnTo=' + current path`.
  - `useSessionStore(): { me: Me | null; load(): Promise<void> }`.
  - `useFolderStore(): { path: string; entries: Entry[]; loading: boolean; error: ApiFailure | null; open(path): Promise<void>; upload(file: File, onCollision?): Promise<Entry>; mkdir(name): Promise<void> }`. `open` follows `next` until the list is complete.
  - `formatSize(bytes, locale)` and `formatDate(iso, locale)` via `Intl`.

- [ ] **Step 1: Failing tests**

`web/test/client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, setCsrf } from '../src/api/client.ts';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('redirects to login on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })));
    const loc = { href: 'http://x/Fotos', pathname: '/Fotos', search: '' };
    vi.stubGlobal('location', loc);
    await expect(api.get('/api/v1/me')).rejects.toBeInstanceOf(ApiFailure);
    expect(loc.href).toBe('/auth/login?returnTo=%2FFotos');
  });
  it('sends the CSRF token on mutating requests', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', f);
    setCsrf('tok');
    await api.post('/api/v1/sources/home/mkdir', { path: '/a' });
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'tok' });
  });
  it('turns a network error into code NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api.get('/api/v1/me')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
```
`web/test/folderStore.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../src/stores/folder.ts';

const entry = (i: number) => ({ name: `f${i}`, path: `/f${i}`, type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' });

beforeEach(() => setActivePinia(createPinia()));

describe('folder store', () => {
  it('follows next until the full listing is loaded', async () => {
    const pages: Record<string, unknown> = {
      '': { entries: [entry(1), entry(2)], next: 'c1' },
      c1: { entries: [entry(3)], next: 'c2' },
      c2: { entries: [entry(4)] },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? '';
      return new Response(JSON.stringify(pages[cursor]), { status: 200 });
    }));
    const s = useFolderStore();
    await s.open('/');
    expect(s.entries.map((e) => e.name)).toEqual(['f1', 'f2', 'f3', 'f4']);
  });
  it('keeps the error and clears loading when listing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 })));
    const s = useFolderStore();
    await s.open('/gone');
    expect(s.loading).toBe(false);
    expect(s.error?.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @files/web test`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement client + stores + format**

`web/src/api/client.ts`:
```ts
import type { ErrorCode } from '@files/shared';

export class ApiFailure extends Error {
  constructor(public code: ErrorCode | 'NETWORK', public params?: Record<string, string | number>) { super(code); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

function redirectToLogin() {
  location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
}

async function request<T>(method: string, path: string, init: { query?: Record<string, string>; body?: BodyInit; json?: unknown } = {}): Promise<T> {
  const url = init.query ? `${path}?${new URLSearchParams(init.query)}` : path;
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin',
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  } catch {
    throw new ApiFailure('NETWORK'); // handled: any fetch rejection is a network failure
  }
  if (res.status === 401) { redirectToLogin(); throw new ApiFailure('UNAUTHENTICATED'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: 'INTERNAL' })) as { code: ErrorCode; params?: Record<string, string | number> };
    throw new ApiFailure(body.code, body.params);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', path, query ? { query } : {}),
  post: <T>(path: string, json: unknown) => request<T>('POST', path, { json }),
  put<T>(path: string, query: Record<string, string>, body: Blob, onProgress?: (fraction: number) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${path}?${new URLSearchParams(query)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-csrf-token', csrf);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onerror = () => reject(new ApiFailure('NETWORK'));
      xhr.onload = () => {
        if (xhr.status === 401) { redirectToLogin(); return reject(new ApiFailure('UNAUTHENTICATED')); }
        let parsed: { code?: ErrorCode; params?: Record<string, string | number> } = {};
        try { parsed = JSON.parse(xhr.responseText); }
        catch { parsed = { code: 'INTERNAL' }; } // handled: non-JSON body is reported as INTERNAL
        if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
        else reject(new ApiFailure(parsed.code ?? 'INTERNAL', parsed.params));
      };
      xhr.send(body);
    });
  },
};
```
The `catch (err)` around `fetch` must name its variable `_err` to pass lint, and it maps every network error to `NETWORK`. That counts as handled under the lint rule. Add the comment `// handled: any fetch rejection is a network failure`.

`web/src/stores/session.ts`:
```ts
import { defineStore } from 'pinia';
import type { Me } from '@files/shared';
import { api, setCsrf } from '../api/client.ts';

export const useSessionStore = defineStore('session', {
  state: () => ({ me: null as Me | null }),
  actions: {
    async load() {
      const me = await api.get<Me>('/api/v1/me');
      setCsrf(me.csrfToken);
      this.me = me;
    },
  },
});
```
`web/src/stores/folder.ts`:
```ts
import { defineStore } from 'pinia';
import type { CollisionPolicy, Entry, ListResponse } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

const BASE = '/api/v1/sources/home';
const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;

export const useFolderStore = defineStore('folder', {
  state: () => ({ path: '/', entries: [] as Entry[], loading: false, error: null as ApiFailure | null }),
  actions: {
    async open(path: string) {
      this.path = path; this.loading = true; this.error = null;
      try {
        const all: Entry[] = []; let cursor: string | undefined;
        do {
          const page: ListResponse = await api.get(`${BASE}/list`, cursor ? { path, cursor } : { path });
          all.push(...page.entries); cursor = page.next;
        } while (cursor);
        if (this.path === path) this.entries = all;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.entries = [];
      } finally { this.loading = false; }
    },
    async upload(file: File, onCollision: CollisionPolicy = 'fail', onProgress?: (f: number) => void): Promise<Entry> {
      const entry = await api.put<Entry>(`${BASE}/content`, { path: join(this.path, file.name), onCollision }, file, onProgress);
      await this.open(this.path);
      return entry;
    },
    async mkdir(name: string) {
      await api.post(`${BASE}/mkdir`, { path: join(this.path, name) });
      await this.open(this.path);
    },
  },
});
```
`web/src/format.ts`:
```ts
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
export function formatSize(bytes: number, locale: string): string {
  let i = 0; let v = bytes;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
}
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
export const intlLocale = (l: string) => (l.startsWith('de') ? 'de-DE' : 'en-GB');
```

- [ ] **Step 4: Components and view**

`web/src/components/Breadcrumbs.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ path: string }>();
const parts = computed(() => {
  const segs = props.path.split('/').filter(Boolean);
  return segs.map((name, i) => ({ name, to: '/' + segs.slice(0, i + 1).map(encodeURIComponent).join('/') }));
});
</script>
<template>
  <nav :aria-label="$t('a11y.breadcrumbs')" class="breadcrumbs">
    <RouterLink to="/">{{ $t('nav.breadcrumbRoot') }}</RouterLink>
    <template v-for="p in parts" :key="p.to">
      <span aria-hidden="true" class="sep">/</span>
      <RouterLink :to="p.to">{{ p.name }}</RouterLink>
    </template>
  </nav>
</template>
```
`web/src/components/FileList.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { formatDate, formatSize, intlLocale } from '../format.ts';

const props = defineProps<{ entries: Entry[]; folderName: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const { locale } = useI18n();
const active = ref(0);
const rows = ref<HTMLElement[]>([]);

function focusRow(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  rows.value[active.value]?.focus();
}
function onKey(e: KeyboardEvent, i: number) {
  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); emit('open', props.entries[i]!); }
}
const downloadHref = (e: Entry) => `/api/v1/sources/home/content?path=${encodeURIComponent(e.path)}&download=1`;
</script>

<template>
  <table class="file-list" :aria-label="$t('a11y.fileList', { folder: folderName })">
    <thead>
      <tr><th scope="col">{{ $t('folder.columns.name') }}</th><th scope="col">{{ $t('folder.columns.size') }}</th><th scope="col">{{ $t('folder.columns.modified') }}</th></tr>
    </thead>
    <tbody>
      <tr v-for="(e, i) in entries" :key="e.path" :ref="(el) => { if (el) rows[i] = el as HTMLElement }"
          :tabindex="i === active ? 0 : -1" :data-type="e.type" @keydown="onKey($event, i)" @dblclick="emit('open', e)">
        <td class="name">
          <span class="icon" :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'" aria-hidden="true" />
          <a v-if="e.type === 'file'" :href="downloadHref(e)" tabindex="-1">{{ e.name }}</a>
          <button v-else type="button" class="link" tabindex="-1" @click="emit('open', e)">{{ e.name }}</button>
        </td>
        <td class="num">{{ e.type === 'file' ? formatSize(e.size, intlLocale(locale)) : '' }}</td>
        <td class="num">{{ formatDate(e.modified, intlLocale(locale)) }}</td>
      </tr>
    </tbody>
  </table>
</template>
```
Icons: `.icon-folder` and `.icon-file` are CSS masks pointing at inline SVG line icons in `app.css`. They are outlined, `stroke-width` 1.5, and use `currentColor`. Use 24-px paths in the style of the design guide; no emoji.

`web/src/components/UploadButton.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue';
const emit = defineEmits<{ files: [File[]] }>();
const input = ref<HTMLInputElement>();
function picked() {
  const files = Array.from(input.value?.files ?? []);
  if (files.length) emit('files', files);
  if (input.value) input.value.value = '';
}
</script>
<template>
  <label class="button primary">
    {{ $t('upload.button') }}
    <input ref="input" type="file" multiple class="visually-hidden" data-testid="upload-input" @change="picked" />
  </label>
</template>
```
`web/src/views/FolderView.vue`:
```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { useFolderStore } from '../stores/folder.ts';
import { ApiFailure } from '../api/client.ts';
import FileList from '../components/FileList.vue';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';

const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const folder = useFolderStore();
const status = ref('');
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
watch(path, (p) => folder.open(p), { immediate: true });

const folderName = computed(() => path.value === '/' ? t('nav.home') : path.value.split('/').pop()!);
function open(e: Entry) {
  if (e.type === 'directory') router.push(e.path.split('/').map(encodeURIComponent).join('/'));
}
async function upload(files: File[]) {
  for (const f of files) {
    try {
      await folder.upload(f, 'fail', (x) => { status.value = t('upload.progress', { name: f.name, percent: Math.round(x * 100) }); });
      status.value = t('upload.done', { name: f.name });
    } catch (e) {
      if (!(e instanceof ApiFailure)) throw e;
      status.value = e.code === 'FILE_EXISTS' ? t('upload.exists', { name: f.name }) : t(`errors.${e.code}`);
    }
  }
}
</script>

<template>
  <section class="folder">
    <div class="toolbar">
      <Breadcrumbs :path="path" />
      <UploadButton @files="upload" />
    </div>
    <p class="status" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="folder.loading">{{ $t('folder.loading') }}</p>
    <p v-else-if="folder.error" role="alert">{{ $t(`errors.${folder.error.code}`) }}</p>
    <p v-else-if="folder.entries.length === 0">{{ $t('folder.empty') }}</p>
    <FileList v-else :entries="folder.entries" :folder-name="folderName" @open="open" />
  </section>
</template>
```
In Phase B a collision only shows the message. The collision dialog with replace, keep both and skip uses `<AppDialog>` and comes as its own issue in Phase D.

- [ ] **Step 5: Run tests + lint + build**

Run: `pnpm --filter @files/web test && pnpm lint && pnpm --filter @files/web build`
Expected: all pass, with no `no-raw-text` violations.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): browse, upload and download in the shard home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Playwright E2E through the real login

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/globalSetup.ts`, `e2e/browse-upload-download.spec.ts`, `server/build.mjs`

**Interfaces:**
- Consumes: built server (`server/dist/main.js`), built web (`web/dist`), `startFakeIdp`.
- Produces: `pnpm e2e` (desktop-chrome + mobile-chrome projects).

- [ ] **Step 1: Server bundle**

`server/build.mjs`:
```js
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: 'dist/main.js', sourcemap: true,
  external: ['better-sqlite3', 'pino', 'fastify', '@fastify/*', 'openid-client'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
```
`DEFAULT_MIGRATIONS` resolves to `dist/../migrations`, which is the existing `server/migrations` in the source tree and `/app/migrations` in the image (Task 12). The `cpSync` line is a no-op in the source tree; remove it there and copy explicitly in the Dockerfile.

- [ ] **Step 2: E2E config**

`e2e/globalSetup.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeIdp } from '../server/test/support/fakeIdp.ts';

export default async function globalSetup() {
  const idp = await startFakeIdp({ port: 4100 });
  const dataDir = mkdtempSync(join(tmpdir(), 'files-e2e-'));
  const server: ChildProcess = spawn(process.execPath, ['server/dist/main.js'], {
    stdio: 'inherit',
    env: {
      ...process.env, NODE_ENV: 'production', FILES_PORT: '3199', FILES_PUBLIC_URL: 'http://localhost:3199',
      FILES_DATA_DIR: dataDir, FILES_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123',
      FILES_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), FILES_OIDC_ISSUER: idp.issuer,
      FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret',
      FILES_OIDC_ROLE_CLAIM: 'groups', FILES_OIDC_ADMIN_VALUE: 'admin', FILES_LOG_LEVEL: 'warn',
      FILES_WEB_DIST: join(process.cwd(), 'web', 'dist'),
    },
  });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch('http://localhost:3199/healthz').then((r) => r.ok, () => false);
    if (ok) break;
    if (i === 99) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return async () => { server.kill('SIGTERM'); await idp.close(); rmSync(dataDir, { recursive: true, force: true }); };
}
```
`e2e/playwright.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  globalSetup: './globalSetup.ts',
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  use: { baseURL: 'http://localhost:3199', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
});
```
The cookie is `Secure` only when the public URL is https. E2E runs over `http://localhost`, so it uses non-secure cookies. That matches the config rule: an https public URL produces secure cookies.

- [ ] **Step 3: Failing E2E spec**

`e2e/browse-upload-download.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('log in, upload a real file, see it, download the same bytes', async ({ page }, info) => {
  const fileName = `Prüfung #1 50% ${info.project.name}.txt`;
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();

  await page.getByTestId('upload-input').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('hallo welt') });
  await expect(page.getByRole('status')).toContainText(fileName);
  const link = page.getByRole('link', { name: fileName });
  await expect(link).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(fileName);
  expect(readFileSync(await download.path()).toString()).toBe('hallo welt');
});

test('uploading the same name twice shows the exists message, not a crash', async ({ page }, info) => {
  const fileName = `dup-${info.project.name}.txt`;
  await page.goto('/');
  const input = page.getByTestId('upload-input');
  await input.setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('1') });
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();
  await input.setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('2') });
  await expect(page.getByRole('status')).toContainText(/gibt es hier schon|already exists/);
});

test('file list is keyboard reachable', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(['TR', 'A', 'LABEL', 'INPUT']).toContain(focused);
});
```

- [ ] **Step 4: Run to verify, then make it pass**

Run: `pnpm exec playwright install chromium && pnpm e2e`
Expected on the first run: the specs that depend on missing styling or behaviour fail; fix the code, not the tests. Expected at the end: 6 passed (3 specs × 2 projects).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(e2e): real OIDC login, upload, download round-trip on desktop and mobile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Container

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `server/test/startup.test.ts`

**Interfaces:**
- Produces: image `freeshard-files`. It runs as `node`, listens on `3005`, uses `/data` as `FILES_DATA_DIR`, and refuses to start on bad config.

- [ ] **Step 1: Failing startup test**

`server/test/startup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('process startup', () => {
  it('exits 1 and names the missing variable when config is incomplete', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'main.ts')], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FILES_SESSION_SECRET');
    expect(r.stderr).toContain('FILES_OIDC_ISSUER');
  });
});
```
Use `fileURLToPath(new URL('../src/main.ts', import.meta.url))` instead of `__dirname`, because the file is ESM.

- [ ] **Step 2: Run, verify it passes against main.ts as already written (Task 4)**

Run: `pnpm --filter @files/server test -- startup`
Expected: PASS. Then sabotage it: wrap `loadConfig` in `main.ts` in a `catch` that only logs. The test must fail. Revert.

- [ ] **Step 3: Dockerfile**

```dockerfile
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim AS runtime
ENV NODE_ENV=production FILES_DATA_DIR=/data FILES_WEB_DIST=/app/web FILES_PORT=3005
WORKDIR /app
RUN corepack enable && mkdir /data && chown node:node /data
COPY --from=build /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/package.json ./
COPY --from=build /src/shared/package.json shared/
COPY --from=build /src/server/package.json server/
RUN pnpm install --frozen-lockfile --prod --filter @files/server... && pnpm store prune
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/migrations server/migrations
COPY --from=build /src/web/dist web
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3005/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
```
`DEFAULT_MIGRATIONS` = `server/dist/../migrations` = `/app/server/migrations`. Correct.

`docker-compose.yml`:
```yaml
services:
  files:
    build: .
    image: freeshard-files
    restart: unless-stopped
    ports: ["127.0.0.1:3005:3005"]
    env_file: .env
    volumes: ["files-data:/data"]
volumes:
  files-data:
```

- [ ] **Step 4: Verify the image**

```bash
podman build -t freeshard-files .
podman run --rm freeshard-files; echo "exit=$?"
podman run --rm --entrypoint id freeshard-files
```
Expected: the first run prints the config problems and `exit=1`. `id` shows `uid=1000(node)`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "build: multi-stage non-root image, refuses to start without config

Refs #108

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Project docs for humans and agents

**Files:**
- Create: `CLAUDE.md`, `CONCEPTS.md`, `DECISIONS.md`, `DESIGN.md`
- Modify: `README.md` (keep the WIP banner; add dev quickstart)

- [ ] **Step 1: Write the docs**

`CLAUDE.md` (agent briefing; English):
```markdown
# Files — agent briefing

Read `docs/superpowers/specs/2026-10-14-files-rebuild-design.md` first. It is the source of truth for scope; `DECISIONS.md` records later decisions.

## Commands
export PATH=~/.local/node22/bin:$PATH
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (Vitest)
pnpm e2e                                    # build + Playwright (desktop + mobile)
pnpm dev                                    # fake IdP on :4000 + server on :3005; run `pnpm --filter @files/web dev` for the SPA on :5173

## Invariants (reviewer rejects violations)
- Every user path goes through `server/src/storage/resolveInRoot.ts`. No `path.join` on user input anywhere else.
- Auth is deny-by-default (`server/src/auth/guard.ts`). Public routes need `config: { public: true }` and a reason in the PR.
- No silent catch. No buffering whole files. No fetching user-supplied URLs.
- No auth bypass, no `NODE_ENV === 'test'` branches. Tests log in through `server/test/support/fakeIdp.ts`.
- Tests use temp dirs only; never `data/`.
- Every bug fix starts with a failing test; deleting the fix must turn it red.
- Every UI change has a Playwright test and passes `no-raw-text` (all strings in `web/src/i18n/*.json`, all three locales).
- Design guide "Daylight Instrument" is binding; deviations go in `DESIGN.md`.
- Fixtures use `testuser`, `testuser@example.com`, `Test User`.
- Never commit `.env*`, `*.db`, `data/`.
```
`CONCEPTS.md`: the product summary (spec §2 in 15 lines), the identity model, sources and addressing, the storage interface, and a module map table listing every file in `server/src` and `web/src` with a one-line purpose. Follow the format of `webcalendar/CONCEPTS.md`.

`DECISIONS.md`: dated entries, one paragraph each. Start with:
- 2026-10-14: rebuild in the same repo, with the old tree at tag `archive/gemini-2026-10-14`.
- 2026-10-14: no local accounts and no bypass; a fake IdP for dev and tests.
- 2026-10-14: the admin role comes from the configurable claim `FILES_OIDC_ROLE_CLAIM` / `FILES_OIDC_ADMIN_VALUE`, because the claim shard_core will send (freeshard#147–149) is not fixed yet.
- 2026-10-14: the locale has no platform-preference source yet (freeshard#168); `resolveLocale` gets the parameter when it exists.
- 2026-10-14: deferred features (spec §2.2) are tracked in one issue labelled `deferred`.

`DESIGN.md`: the token source, the icon approach (CSS mask over inline SVG line icons), and any deviation from the guide with its reason. Phase B has none beyond the fact that the file list is a table.

`README.md`: keep the banner and add "Development" with the commands from `CLAUDE.md`.

- [ ] **Step 2: Full gate run**

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
git status --short   # must show only the docs
```
Expected: everything green, and only the docs files are listed.

- [ ] **Step 3: Commit and push the branch**

```bash
git add -A && git commit -m "docs: agent briefing, concepts, decisions, design notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin rebuild/phase-b
```
Open the PR: `gh pr create --base main --title "Rebuild phase B: foundation" --body "<summary + gate output + Refs #91 #92 #93 #108 #113 #128>"`. The reviewer merges it; it is not auto-merged.

---

## Self-review notes

- **Spec coverage for Phase B:**
  - §3.1 auth: Task 6
  - §3.2 resolveInRoot and LocalBackend: Tasks 5 and 7
  - §3.3 single route family: Task 8
  - §3.6 migrations: Task 3
  - §3.7 errors, headers, crash exit: Tasks 4 and 8
  - §3.8 shell, tokens, i18n, keyboard: Tasks 9 and 10
  - §3.9 temp-dir tests, fake IdP, E2E: Tasks 4 and 11
  - §3.10 container: Task 12
  - Deferred to Phase D issues, by design: transfers, trash, versions, sharing, cloud backends, thumbnails, WebDAV, PWA, the collision dialog, `<AppDialog>`.
- **Review Focus:** every line has its test in the task named there.
- **Types:**
  - `Entry`, `CollisionPolicy` and `Me` come from `@files/shared` everywhere.
  - `AppError(code, params?, options?)` is used consistently.
  - `startTestApp(overrides, extend?)` and `login(t, user?)` are used consistently.
