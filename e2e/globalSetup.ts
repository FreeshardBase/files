import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
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

/**
 * Starts one server process and waits until /healthz answers; rejects if it exits first. With `logFile`, its stdout (the
 * log) goes there as well as to the runner's stdout.
 */
async function startServer(args: string[], env: NodeJS.ProcessEnv, origin: string, started: (c: ChildProcess) => void,
  cwd = process.cwd(), logFile?: string) {
  const child = spawn(process.execPath, args, { stdio: ['inherit', logFile ? 'pipe' : 'inherit', 'inherit'], env, cwd });
  if (logFile) {
    child.stdout!.pipe(process.stdout);
    child.stdout!.pipe(createWriteStream(logFile));
  }
  started(child);
  const died = new Promise<never>((_, reject) => {
    child.once('exit', (code, sig) => reject(new Error(`server ${args.at(-1)} exited before healthy (code ${code}, signal ${sig})`)));
  });
  died.catch(() => undefined); // handled via race below
  const healthy = (async () => {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server ${args.at(-1)} did not become healthy in 10s`);
  })();
  await Promise.race([healthy, died]);
}

export default async function globalSetup() {
  const port = process.env.E2E_PORT;
  const cloudPort = process.env.E2E_CLOUD_PORT;
  if (!port || !cloudPort) throw new Error('E2E_PORT or E2E_CLOUD_PORT not set (playwright.config.ts sets them)');
  const origin = `http://localhost:${port}`;
  // 127.0.0.1, not localhost: cookies are not port-scoped, so the two servers must not share a host name.
  const cloudOrigin = `http://127.0.0.1:${cloudPort}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'files-e2e-'));
  const cloudDataDir = mkdtempSync(join(tmpdir(), 'files-e2e-cloud-'));
  const serverLog = process.env.E2E_SERVER_LOG;
  if (!serverLog) throw new Error('E2E_SERVER_LOG not set (playwright.config.ts sets it)');
  let idp: FakeIdp | undefined;
  const servers: ChildProcess[] = [];
  const cleanup = async () => {
    await Promise.all(servers.map(stop));
    await idp?.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cloudDataDir, { recursive: true, force: true });
    rmSync(serverLog, { force: true });
  };
  try {
    idp = await startFakeIdp({ port: await freePort() });
    const env = {
      ...process.env, NODE_ENV: 'production', FILES_PORT: port, FILES_PUBLIC_URL: origin,
      FILES_DATA_DIR: dataDir, FILES_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123',
      FILES_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
      // Test hook: point the server at a bad issuer to force the startup-failure path.
      FILES_OIDC_ISSUER: process.env.E2E_OIDC_ISSUER_OVERRIDE ?? idp.issuer,
      FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret',
      FILES_OIDC_ROLE_CLAIM: 'groups', FILES_OIDC_ADMIN_VALUE: 'admin', FILES_LOG_LEVEL: 'warn',
      FILES_WEB_DIST: join(process.cwd(), 'web', 'dist'),
    };
    await startServer(['server/dist/main.js'], env, origin, (c) => servers.push(c), process.cwd(), serverLog);
    // The cloud server (e2e/cloudServer.ts) runs the same app from the sources with the fake provider (#148). It starts
    // in server/, where `tsx` (a server dev dependency) resolves.
    await startServer(['--import', 'tsx', join(process.cwd(), 'e2e', 'cloudServer.ts')],
      { ...env, FILES_PORT: cloudPort, FILES_PUBLIC_URL: cloudOrigin, FILES_DATA_DIR: cloudDataDir, FILES_OIDC_ISSUER: idp.issuer },
      cloudOrigin, (c) => servers.push(c), join(process.cwd(), 'server'));
  } catch (e) {
    await cleanup();
    throw e;
  }
  return cleanup;
}
