import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp, type Connections } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db.ts';
import { cookieNames } from '../../src/auth/cookies.ts';
import { dbPath } from '../../src/paths.ts';
import type { PathTable, TrashTable } from '../../src/storage/pathRefs.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

/** `routes` holds the live route options of every registered route (read `config.public` after `ready`). */
export type TestApp = { app: FastifyInstance; config: Config; db: Db; dataDir: string; idp: FakeIdp; routes: RouteOptions[];
  close(): Promise<void> };

/** An override of `undefined` removes that variable from the config. */
export async function startTestApp(
  overrides: Record<string, string | undefined> = {},
  extend?: (app: FastifyInstance) => void,
  logStream?: NodeJS.WritableStream,
  /** Path-dependent tables for the cascade, e.g. ones a test creates in `prepare`; default: the app's own list. */
  /** Likewise for tables whose rows hang off a trash row (`trashTables`, purged with it). */
  /** `connections`: the members' cloud connections as fake backends (search merge tests). */
  dbOpts?: { pathTables?: readonly PathTable[]; trashTables?: readonly TrashTable[]; prepare?: (db: Db) => void;
    connections?: Connections },
): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'files-app-'));
  // Hermetic: never depend on whether web/ was built, unless the test points FILES_WEB_DIST somewhere itself.
  const setDefaultDist = process.env.FILES_WEB_DIST === undefined;
  if (setDefaultDist) process.env.FILES_WEB_DIST = join(dataDir, 'no-web-dist');
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
  const db = openDb(dbPath(dataDir));
  dbOpts?.prepare?.(db);
  const routes: RouteOptions[] = [];
  const app = await buildApp({ config, db, extend, logStream, onRoute: (r) => { routes.push(r); },
    ...(dbOpts?.pathTables ? { pathTables: dbOpts.pathTables } : {}),
    ...(dbOpts?.trashTables ? { trashTables: dbOpts.trashTables } : {}),
    ...(dbOpts?.connections ? { connections: dbOpts.connections } : {}) });
  await app.ready();
  return {
    app, config, db, dataDir, idp, routes,
    async close() {
      if (setDefaultDist && process.env.FILES_WEB_DIST === join(dataDir, 'no-web-dist')) delete process.env.FILES_WEB_DIST;
      await app.close(); db.close(); await idp.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

export async function login(t: TestApp, user = 'testuser'): Promise<{ cookie: string; csrf: string }> {
  const start = await t.app.inject(`/auth/login?login_hint=${encodeURIComponent(user)}`);
  if (start.statusCode !== 302) throw new Error(`login start ${start.statusCode}`);
  const loginCookie = String(start.headers['set-cookie']).split(';')[0]!;
  const idpRes = await fetch(String(start.headers.location), { redirect: 'manual' });
  const back = new URL(idpRes.headers.get('location')!);
  const cb = await t.app.inject({ url: back.pathname + back.search, headers: { cookie: loginCookie } });
  if (cb.statusCode !== 302) throw new Error(`callback ${cb.statusCode} ${cb.body}`);
  const setCookies = ([] as string[]).concat(cb.headers['set-cookie'] as string | string[]);
  const sid = setCookies.find((c) => c.startsWith(`${cookieNames(t.config).sid}=`))!.split(';')[0]!;
  const me = await t.app.inject({ url: '/api/v1/me', headers: { cookie: sid } });
  return { cookie: sid, csrf: me.json().csrfToken };
}
