import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDataDir, dropPrivileges, RUNTIME_USER } from '../src/dataDir.ts';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'files-datadir-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// prepareDataDir runs as root in the container. Here only chown is faked; stat and mkdir are real.
function fsWithFakeChown() {
  const chownSync = vi.fn<(path: string, uid: number, gid: number) => void>();
  return { ops: { statSync: fs.statSync, mkdirSync: fs.mkdirSync, chownSync }, chownSync };
}

describe('prepareDataDir', () => {
  it('runs as the node user of the base image', () => {
    expect(RUNTIME_USER).toEqual({ uid: 1000, gid: 1000 });
  });

  it('chowns a data dir owned by someone else, and only the directory itself', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'homes', 'u1'), { recursive: true });
    writeFileSync(join(dir, 'files.db'), '');
    const { ops, chownSync } = fsWithFakeChown();
    const owner = { uid: process.getuid!() + 1, gid: process.getgid!() + 1 };
    prepareDataDir(dir, owner, ops);
    expect(chownSync.mock.calls).toEqual([[dir, owner.uid, owner.gid]]);
  });

  it('leaves a data dir alone that the runtime user already owns', () => {
    const dir = tempDir();
    const { ops, chownSync } = fsWithFakeChown();
    prepareDataDir(dir, { uid: process.getuid!(), gid: process.getgid!() }, ops);
    expect(chownSync).not.toHaveBeenCalled();
  });

  it('chowns when only the group differs', () => {
    const dir = tempDir();
    const { ops, chownSync } = fsWithFakeChown();
    const owner = { uid: process.getuid!(), gid: process.getgid!() + 1 };
    prepareDataDir(dir, owner, ops);
    expect(chownSync.mock.calls).toEqual([[dir, owner.uid, owner.gid]]);
  });

  it('creates a missing data dir and chowns every directory it created', () => {
    const parent = tempDir();
    const dir = join(parent, 'a', 'data');
    const { ops, chownSync } = fsWithFakeChown();
    const owner = { uid: process.getuid!() + 1, gid: process.getgid!() + 1 };
    prepareDataDir(dir, owner, ops);
    expect(existsSync(dir)).toBe(true);
    expect(chownSync.mock.calls).toEqual([[join(parent, 'a'), owner.uid, owner.gid], [dir, owner.uid, owner.gid]]);
  });
});

describe('dropPrivileges', () => {
  function fakeProcess(effective: { uid: number; gid: number }) {
    const calls: string[] = [];
    let uid = 0; let gid = 0;
    return {
      calls,
      proc: {
        setgroups: (g: (number | string)[]) => { calls.push(`setgroups:${g.join(',')}`); },
        setgid: (g: number | string) => { calls.push(`setgid:${g}`); gid = effective.gid; },
        setuid: (u: number | string) => { calls.push(`setuid:${u}`); uid = effective.uid; },
        getuid: () => uid,
        getgid: () => gid,
      },
    };
  }

  it('drops supplementary groups, then the group, then the user', () => {
    const { proc, calls } = fakeProcess(RUNTIME_USER);
    dropPrivileges(RUNTIME_USER, proc);
    expect(calls).toEqual(['setgroups:1000', 'setgid:1000', 'setuid:1000']);
  });

  it('throws when the process is still root afterwards', () => {
    const { proc } = fakeProcess({ uid: 0, gid: 1000 });
    expect(() => dropPrivileges(RUNTIME_USER, proc)).toThrow(/uid 1000/);
  });
});
