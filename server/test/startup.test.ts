import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeIdp } from './support/fakeIdp.ts';

const mainTs = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

describe('process startup', () => {
  it('exits 1 and names the missing variable when config is incomplete', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FILES_SESSION_SECRET');
    expect(r.stderr).toContain('FILES_OIDC_ISSUER');
  });

  it('exits 1 and names FILES_ENCRYPTION_KEY when the secret is shorter than 32 characters', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs], {
      env: {
        PATH: process.env.PATH, NODE_ENV: 'production',
        FILES_PUBLIC_URL: 'https://files.example.com', FILES_DATA_DIR: join(tmpdir(), 'files-startup-unused'),
        FILES_SESSION_SECRET: 's'.repeat(48), FILES_ENCRYPTION_KEY: 'k'.repeat(31),
        FILES_OIDC_ISSUER: 'https://idp.example.com', FILES_OIDC_CLIENT_ID: 'files',
        FILES_OIDC_CLIENT_SECRET: 'files-secret', FILES_OIDC_ROLE_CLAIM: 'groups', FILES_OIDC_ADMIN_VALUE: 'admin',
      },
      encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FILES_ENCRYPTION_KEY');
    expect(r.stderr).not.toContain('FILES_SESSION_SECRET');
  });

  it.each([['FILES_OIDC_ROLE_CLAIM', 'groups'], ['FILES_OIDC_ADMIN_VALUE', 'admin']])(
    'exits 1 when only %s of the admin claim pair is set', (key, value) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs], {
        env: {
          PATH: process.env.PATH, NODE_ENV: 'production',
          FILES_PUBLIC_URL: 'https://files.example.com', FILES_DATA_DIR: join(tmpdir(), 'files-startup-unused'),
          FILES_SESSION_SECRET: 's'.repeat(48), FILES_ENCRYPTION_KEY: 'k'.repeat(32),
          FILES_OIDC_ISSUER: 'https://idp.example.com', FILES_OIDC_CLIENT_ID: 'files',
          FILES_OIDC_CLIENT_SECRET: 'files-secret', [key]: value,
        },
        encoding: 'utf8', timeout: 20000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/FILES_OIDC_ROLE_CLAIM.*FILES_OIDC_ADMIN_VALUE.*both or neither/);
    });

  // The container drops to uid 1000 before this check; a data dir it cannot write must stop startup with a clear message,
  // not with an SQLite error on the first write. Root bypasses file modes, so these cases need a non-root test run.
  const startIn = (dataDir: string) => spawnSync(process.execPath, ['--import', 'tsx', mainTs], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production',
      FILES_PUBLIC_URL: 'https://files.example.com', FILES_DATA_DIR: dataDir,
      FILES_SESSION_SECRET: 's'.repeat(48), FILES_ENCRYPTION_KEY: 'k'.repeat(32),
      FILES_OIDC_ISSUER: 'https://idp.example.com', FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret',
    },
    encoding: 'utf8', timeout: 20000,
  });

  it.skipIf(process.getuid?.() === 0)('exits 1 and names the data dir when it is not writable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'files-startup-ro-'));
    chmodSync(dataDir, 0o555);
    try {
      const r = startIn(dataDir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Data directory ${dataDir} is not writable by uid ${process.getuid!()}: ${dataDir}`);
    } finally {
      chmodSync(dataDir, 0o755);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('exits 1 and names files.db when an existing database is not writable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'files-startup-rodb-'));
    writeFileSync(join(dataDir, 'files.db'), '');
    chmodSync(join(dataDir, 'files.db'), 0o444);
    try {
      const r = startIn(dataDir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`not writable by uid ${process.getuid!()}: ${join(dataDir, 'files.db')}`);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('exits 1 and names the homes dir when it is not writable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'files-startup-rohomes-'));
    mkdirSync(join(dataDir, 'homes'), { mode: 0o555 });
    try {
      const r = startIn(dataDir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`not writable by uid ${process.getuid!()}: ${join(dataDir, 'homes')}`);
    } finally {
      chmodSync(join(dataDir, 'homes'), 0o755);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // Boots the way the shard's app template configures it: no admin role claim, because shard_core sends none yet.
  it('boots with a 32-character shard secret and shuts down cleanly with exit 0 on SIGTERM', async () => {
    const idp = await startFakeIdp();
    const dataDir = mkdtempSync(join(tmpdir(), 'files-startup-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', mainTs], {
      env: {
        PATH: process.env.PATH, NODE_ENV: 'production',
        FILES_PUBLIC_URL: 'https://files.example.com', FILES_DATA_DIR: dataDir,
        FILES_SESSION_SECRET: 's'.repeat(48), FILES_ENCRYPTION_KEY: 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcD4F',
        FILES_OIDC_ISSUER: idp.issuer, FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret',
        FILES_LOG_LEVEL: 'fatal', FILES_PORT: String(port),
        FILES_WEB_DIST: join(dataDir, 'no-web-dist'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      expect(up, stderr).toBe(true);
      const t0 = Date.now();
      child.kill('SIGTERM');
      const res = await exited;
      expect(res, stderr).toEqual({ code: 0, signal: null });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      child.kill('SIGKILL');
      await idp.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
