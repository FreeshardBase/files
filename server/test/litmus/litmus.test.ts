import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startTestApp, login, type TestApp } from '../support/harness.ts';
import { createAppPassword } from '../support/dav.ts';

// `pnpm test:litmus` (#157, spec §3.9): litmus in a container against the real server, suites basic, copymove, props and
// locks. Needs podman or docker; without either the suite reports skipped, never passed.
const run = promisify(execFile);
const engine = await run('podman', ['--version']).then(() => 'podman', () => run('docker', ['--version']).then(() => 'docker', () => undefined));
const SUITES = ['basic', 'copymove', 'props', 'locks'];
const IMAGE = 'files-litmus:test';
let t: TestApp; let url: string; let password: string;

beforeAll(async () => {
  if (!engine) return;
  t = await startTestApp();
  password = await createAppPassword(t, await login(t), 'Test litmus');
  // The container shares the host's network, so the server listens on loopback only.
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/dav/`;
  await run(engine, ['build', ...(engine === 'podman' ? ['--format', 'docker'] : []), '-t', IMAGE,
    fileURLToPath(new URL('.', import.meta.url))], { maxBuffer: 16 * 1024 * 1024 });
}, 600_000);
afterAll(async () => { t?.app.server.closeAllConnections(); await t?.close(); });

describe.skipIf(!engine)('litmus', () => {
  it.each(SUITES)('passes the %s suite', async (suite) => {
    const r = await run(engine!, ['run', '--rm', '--network', 'host', '-e', `TESTS=${suite}`, IMAGE, url, 'testuser', password],
      { maxBuffer: 16 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string; code?: number }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', failed: e.code }));
    const out = r.stdout;
    const summary = new RegExp(`summary for [\`']${suite}': of (\\d+) tests run: (\\d+) passed, (\\d+) failed`).exec(out);
    expect(summary, out + r.stderr).not.toBeNull();
    // The figures for the PR: the summary and litmus's warnings (allowed deviations it reports without failing).
    console.log([summary![0], ...out.split('\n').filter((l) => /WARNING/.test(l))].join('\n'));
    expect(Number(summary![3]), out).toBe(0);
    expect(Number(summary![2]), out).toBe(Number(summary![1]));
  }, 120_000);
});
