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
