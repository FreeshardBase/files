import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AppError } from '../errors.ts';

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f]/;

export function normalizeUserPath(userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0 || FORBIDDEN.test(userPath)) {
    throw new AppError('PATH_INVALID');
  }
  const segments = userPath.normalize('NFC').split('/').filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === '.' || s === '..' || s.includes('\\')) throw new AppError('PATH_INVALID');
    if (Buffer.byteLength(s) > 255) throw new AppError('PATH_INVALID');
  }
  return '/' + segments.join('/');
}

export async function resolveInRoot(root: string, userPath: string): Promise<string> {
  const normalized = normalizeUserPath(userPath);
  const realRoot = await realpath(root);
  const segments = normalized.split('/').filter(Boolean);
  let current = realRoot;
  for (const s of segments) {
    current = join(current, s);
    let st;
    try { st = await lstat(current); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; // handled: rest does not exist yet
      throw err;
    }
    if (st.isSymbolicLink()) throw new AppError('PATH_SYMLINK');
  }
  const target = join(realRoot, ...segments);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new AppError('PATH_INVALID');
  return target;
}
