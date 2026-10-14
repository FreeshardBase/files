import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db.ts';
import { startFakeIdp, type FakeIdp } from './fakeIdp.ts';

export type TestApp = { app: FastifyInstance; config: Config; db: Db; dataDir: string; idp: FakeIdp; close(): Promise<void> };

export async function startTestApp(
  overrides: Record<string, string> = {},
  extend?: (app: FastifyInstance) => void,
  logStream?: NodeJS.WritableStream,
): Promise<TestApp> {
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
  const app = await buildApp({ config, db, extend, logStream });
  await app.ready();
  return {
    app, config, db, dataDir, idp,
    async close() { await app.close(); db.close(); await idp.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
