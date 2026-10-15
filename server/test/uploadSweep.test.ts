import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { startTestApp, type TestApp } from './support/harness.ts';
import { homeRoot } from '../src/paths.ts';

// Orphans are planted from `extend`, which runs inside buildApp before the app becomes ready, i.e. exactly where
// leftovers from a crashed process would sit when the server starts.
const TEMP = '.0123456789abcdef.upload';
const HOME_A = '00000000-0000-4000-8000-00000000000a';
const HOME_B = '00000000-0000-4000-8000-00000000000b';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await t?.close(); t = undefined;
});

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  let buf = '';
  const stream = new Writable({ write(chunk, _enc, cb) { buf += chunk; cb(); } });
  return { stream, lines: () => buf.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function plant(app: FastifyInstance, fn: (home: (id: string) => string) => void): void {
  fn((id) => { const h = homeRoot(app.deps.config.dataDir, id); mkdirSync(h, { recursive: true }); return h; });
}

describe('startup sweep of orphaned upload temp files', () => {
  it('removes an orphan temp file in a nested folder and logs only the count', async () => {
    const log = capture();
    let orphan = ''; let kept = '';
    t = await startTestApp({ FILES_LOG_LEVEL: 'info' }, (app) => plant(app, (home) => {
      const dir = join(home(HOME_A), 'docs', 'deep');
      mkdirSync(dir, { recursive: true });
      orphan = join(dir, TEMP); writeFileSync(orphan, 'partial');
      kept = join(dir, 'report.txt'); writeFileSync(kept, 'keep');
    }), log.stream);
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(kept, 'utf8')).toBe('keep');
    const sweep = log.lines().filter((l) => l.msg === 'upload temp sweep finished');
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatchObject({ level: 30, removed: 1 });
    expect(JSON.stringify(log.lines())).not.toContain(TEMP);
  });

  it('removes temp files in several homes, at the home root and inside .files', async () => {
    const orphans: string[] = [];
    t = await startTestApp({}, (app) => plant(app, (home) => {
      orphans.push(join(home(HOME_A), TEMP));
      mkdirSync(join(home(HOME_B), '.files'), { recursive: true });
      orphans.push(join(home(HOME_B), '.files', '.fedcba9876543210.upload'));
      for (const o of orphans) writeFileSync(o, 'x');
    }));
    for (const o of orphans) expect(existsSync(o), o).toBe(false);
  });

  it('leaves look-alikes, directories, symlinks and symlink targets untouched', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'files-sweep-outside-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const target = join(outside, TEMP);
    writeFileSync(target, 'not yours');
    const outsideDir = join(outside, 'dir');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, TEMP), 'not yours either');
    const kept: string[] = [];
    let dirLike = ''; let link = ''; let dirLink = '';
    t = await startTestApp({}, (app) => plant(app, (home) => {
      const dir = join(home(HOME_A), 'sub');
      mkdirSync(dir);
      for (const name of ['.abc.upload', 'x.upload', `${TEMP}.txt`, '.0123456789ABCDEF.upload', '.0123456789abcdeg.upload',
        '..0123456789abcdef.upload', '.0123456789abcdef0.upload']) {
        const p = join(dir, name); writeFileSync(p, 'keep'); kept.push(p);
      }
      dirLike = join(dir, '.1111111111111111.upload'); mkdirSync(dirLike);
      link = join(dir, '.2222222222222222.upload'); symlinkSync(target, link);
      dirLink = join(dir, 'linked'); symlinkSync(outsideDir, dirLink);
    }));
    for (const p of kept) expect(readFileSync(p, 'utf8'), p).toBe('keep');
    expect(lstatSync(dirLike).isDirectory()).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not yours');
    expect(lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outsideDir, TEMP), 'utf8')).toBe('not yours either');
  });

  it.skipIf(process.getuid?.() === 0)('logs an unreadable directory by root-relative path and sweeps everything else', async () => {
    const log = capture();
    const orphans: string[] = [];
    let locked = '';
    t = await startTestApp({ FILES_LOG_LEVEL: 'info' }, (app) => plant(app, (home) => {
      locked = join(home(HOME_A), 'a', 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, TEMP), 'x');
      chmodSync(locked, 0o000);
      orphans.push(join(home(HOME_A), 'b', TEMP));
      mkdirSync(join(home(HOME_A), 'b'));
      orphans.push(join(home(HOME_B), TEMP));
      for (const o of orphans) writeFileSync(o, 'x');
    }), log.stream);
    cleanups.push(() => chmodSync(locked, 0o755));
    for (const o of orphans) expect(existsSync(o), o).toBe(false);
    const warn = log.lines().filter((l) => l.msg === 'upload temp sweep could not read a directory');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 40, home: HOME_A, path: '/a/locked', code: 'EACCES' });
    expect(String(warn[0]!.path)).not.toContain(t.dataDir);
    expect(log.lines().find((l) => l.msg === 'upload temp sweep finished')).toMatchObject({ removed: 2, failed: 1 });
  });

  it('copes with a data dir that has no homes yet', async () => {
    const log = capture();
    t = await startTestApp({ FILES_LOG_LEVEL: 'info' }, undefined, log.stream);
    expect(log.lines().find((l) => l.msg === 'upload temp sweep finished')).toMatchObject({ removed: 0, failed: 0 });
  });

  it('finishes before the app accepts requests', async () => {
    const orphans: string[] = [];
    const seenAtReady: boolean[] = [];
    let seenAtFirstRequest: boolean[] = [];
    t = await startTestApp({}, (app) => {
      plant(app, (home) => {
        // Enough files across homes that an unawaited sweep could not finish within one tick.
        for (const id of [HOME_A, HOME_B]) {
          for (let i = 0; i < 50; i++) {
            const dir = join(home(id), `d${i}`); mkdirSync(dir);
            const o = join(dir, `.${i.toString(16).padStart(16, '0')}.upload`); writeFileSync(o, 'x'); orphans.push(o);
          }
        }
      });
      // Registered after the sweep: fastify runs onReady hooks in order and only then serves (listen/inject).
      app.addHook('onReady', async () => { seenAtReady.push(...orphans.map(existsSync)); });
      app.addHook('onRequest', async () => { if (!seenAtFirstRequest.length) seenAtFirstRequest = orphans.map(existsSync); });
    });
    expect(seenAtReady).toHaveLength(orphans.length);
    expect(seenAtReady.every((e) => !e)).toBe(true);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = t.app.server.address() as { port: number };
    expect((await fetch(`http://127.0.0.1:${addr.port}/healthz`)).status).toBe(200);
    expect(seenAtFirstRequest).toHaveLength(orphans.length);
    expect(seenAtFirstRequest.every((e) => !e)).toBe(true);
  });
});
