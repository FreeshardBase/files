import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeIdp, type FakeIdp } from '../server/test/support/fakeIdp.ts';
import { freePort } from './freePort.ts';

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

export default async function globalSetup() {
  const port = process.env.E2E_PORT;
  if (!port) throw new Error('E2E_PORT not set (playwright.config.ts sets it)');
  const origin = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'files-e2e-'));
  let idp: FakeIdp | undefined;
  let server: ChildProcess | undefined;
  const cleanup = async () => {
    await stop(server);
    await idp?.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    idp = await startFakeIdp({ port: await freePort() });
    const child = spawn(process.execPath, ['server/dist/main.js'], {
      stdio: 'inherit',
      env: {
        ...process.env, NODE_ENV: 'production', FILES_PORT: port, FILES_PUBLIC_URL: origin,
        FILES_DATA_DIR: dataDir, FILES_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123',
        FILES_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        FILES_OIDC_ISSUER: process.env.E2E_OIDC_ISSUER_OVERRIDE ?? idp.issuer,
        FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret',
        FILES_OIDC_ROLE_CLAIM: 'groups', FILES_OIDC_ADMIN_VALUE: 'admin', FILES_LOG_LEVEL: 'warn',
        FILES_WEB_DIST: join(process.cwd(), 'web', 'dist'),
      },
    });
    server = child;
    const died = new Promise<never>((_, reject) => {
      child.once('exit', (code, sig) => reject(new Error(`server exited before healthy (code ${code}, signal ${sig})`)));
    });
    died.catch(() => undefined); // handled via race below
    const healthy = (async () => {
      for (let i = 0; i < 100; i++) {
        if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('server did not become healthy in 10s');
    })();
    await Promise.race([healthy, died]);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return cleanup;
}
