import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// #300: `pnpm smoke:container` (scripts/container-smoke.sh) and the fake IdP it runs on the host. The full run needs
// podman and a network for the image build, so the suite drives the script against a PATH it controls: no podman at
// all, or a stand-in `podman` that records its calls and answers as told. The real run is recorded in docs/perf.md.

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'scripts', 'container-smoke.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A bin dir holding only the named host tools, plus an optional stand-in podman.
function binDir(tools: string[], podman?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-bin-')); dirs.push(dir);
  for (const tool of tools) {
    const found = spawnSync('which', [tool], { encoding: 'utf8' });
    if (found.status !== 0) throw new Error(`host tool missing: ${tool}`);
    symlinkSync(found.stdout.trim(), join(dir, tool));
  }
  if (podman !== undefined) { writeFileSync(join(dir, 'podman'), `#!/bin/sh\necho "$*" >> "${dir}/podman.calls"\n${podman}\n`); chmodSync(join(dir, 'podman'), 0o755); }
  return dir;
}
const calls = (dir: string) => readFileSync(join(dir, 'podman.calls'), 'utf8').trim().split('\n');
const run = (cmd: string, args: string[], path: string) =>
  spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { PATH: path, HOME: process.env.HOME! }, timeout: 60_000 });
const SCRIPT_TOOLS = ['dirname', 'mktemp', 'rm', 'tail', 'grep', 'cat'];

describe('pnpm smoke:container', () => {
  it('is skipped with a clear message and exit 0 when podman is missing', () => {
    const bin = binDir(['node', 'pnpm', 'sh', 'bash']);
    const r = run(join(bin, 'pnpm'), ['--silent', 'smoke:container'], bin);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('container smoke SKIPPED: podman is not installed');
  });

  it('fails naming the step when the image does not build, and removes container and volume', () => {
    const bin = binDir(SCRIPT_TOOLS, 'case "$1" in build) echo "build broke"; exit 1;; esac; exit 0');
    const r = run('/bin/bash', [script], bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('container smoke FAILED: image build');
    expect(r.stdout).toContain('build broke');
    const c = calls(bin);
    expect(c[0]).toMatch(/^build --format docker -t \S+ \.$/);
    expect(c.some((l) => /^rm -f files-smoke-\d+$/.test(l))).toBe(true);
    expect(c.some((l) => /^volume rm -f files-smoke-\d+$/.test(l))).toBe(true);
    expect(c.some((l) => l.startsWith('run'))).toBe(false);
  });

  it('fails when the image starts without any configuration', () => {
    const bin = binDir(SCRIPT_TOOLS, 'exit 0');
    const r = run('/bin/bash', [script], bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('container smoke FAILED: started without any configuration');
    expect(calls(bin)).toContain(`run --rm --network none ${calls(bin)[0]!.split(' ')[4]}`);
  });

  it('fails when the refusal does not name the missing secret', () => {
    const bin = binDir(SCRIPT_TOOLS, 'case "$1" in run) echo "something else went wrong"; exit 1;; esac; exit 0');
    const r = run('/bin/bash', [script], bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('container smoke FAILED: no message naming the missing secret');
  });
});

describe('scripts/smoke/fake-idp.ts', () => {
  it('prints its issuer, serves OIDC discovery for it, and exits on SIGTERM', async () => {
    const child = spawn(join(repo, 'server', 'node_modules', '.bin', 'tsx'), [join(repo, 'scripts', 'smoke', 'fake-idp.ts')],
      { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    try {
      const issuer = await new Promise<string>((done, fail) => {
        createInterface({ input: child.stdout }).once('line', done);
        child.once('exit', (code) => fail(new Error(`fake IdP exited with ${code}`)));
      });
      expect(issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      expect((await res.json() as { issuer: string }).issuer).toBe(issuer);
    } finally { child.kill('SIGTERM'); }
    expect(await exited).toBe(0);
  }, 30_000);
});
