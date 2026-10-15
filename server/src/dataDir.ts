import * as fs from 'node:fs';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath, homesDir } from './paths.ts';

// The data dir on a shard is a bind mount the Docker daemon creates as root. The container starts as root only to
// hand that directory to the runtime user, then drops privileges before anything else runs (DECISIONS.md 2026-10-15).

export interface Owner { uid: number; gid: number }

// The `node` user of the node:22-slim base image.
export const RUNTIME_USER: Owner = { uid: 1000, gid: 1000 };

export class DataDirError extends Error {}

interface DataDirFs {
  statSync(path: string): { uid: number; gid: number };
  mkdirSync(path: string, options: { recursive: true }): unknown;
  chownSync(path: string, uid: number, gid: number): void;
}

// Chowns the directory itself and any parents it had to create, never its contents: existing user data keeps its owner.
export function prepareDataDir(dir: string, owner: Owner, ops: DataDirFs = fs): void {
  const created: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = dirname(d)) created.unshift(d);
  ops.mkdirSync(dir, { recursive: true });
  for (const d of created) ops.chownSync(d, owner.uid, owner.gid);
  if (created.includes(dir)) return;
  const st = ops.statSync(dir);
  if (st.uid !== owner.uid || st.gid !== owner.gid) ops.chownSync(dir, owner.uid, owner.gid);
}

interface PrivilegeProcess {
  setgroups(groups: number[]): void;
  setgid(gid: number): void;
  setuid(uid: number): void;
  getuid(): number;
  getgid(): number;
}

const posixProcess: PrivilegeProcess = {
  setgroups: (g) => process.setgroups!(g),
  setgid: (g) => process.setgid!(g),
  setuid: (u) => process.setuid!(u),
  getuid: () => process.getuid!(),
  getgid: () => process.getgid!(),
};

export function dropPrivileges(owner: Owner, proc: PrivilegeProcess = posixProcess): void {
  proc.setgroups([owner.gid]);
  proc.setgid(owner.gid);
  proc.setuid(owner.uid);
  if (proc.getuid() !== owner.uid || proc.getgid() !== owner.gid) {
    throw new Error(`Could not drop privileges to uid ${owner.uid} gid ${owner.gid}`);
  }
}

// Checks the data dir and the top-level entries the server writes, so a wrong owner stops startup with a clear message
// instead of an SQLite or EACCES error on the first write.
export function assertDataDirWritable(dir: string): void {
  const uid = process.getuid!();
  const fail = (path: string, code: string) => new DataDirError(
    `Data directory ${dir} is not writable by uid ${uid}: ${path} (${code}). ` +
    `Make it owned by uid ${uid}, e.g. chown -R ${uid}:${uid} on the host directory.`);
  try { mkdirSync(dir, { recursive: true }); }
  catch (err) { throw fail(dir, (err as NodeJS.ErrnoException).code ?? 'unknown'); }
  const rw = constants.R_OK | constants.W_OK;
  const checks: [string, number][] = [[dir, rw | constants.X_OK], [dbPath(dir), rw], [homesDir(dir), rw | constants.X_OK]];
  for (const [path, mode] of checks) {
    if (path !== dir && !existsSync(path)) continue;
    try { accessSync(path, mode); }
    catch (err) { throw fail(path, (err as NodeJS.ErrnoException).code ?? 'unknown'); }
  }
}
