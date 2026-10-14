import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { AppError } from '../errors.ts';

// All Unicode control chars (C0, DEL, C1) plus bidi marks/embeddings/isolates.
const FORBIDDEN = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_PATH_BYTES = 4095;

export function normalizeUserPath(userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0 || !userPath.isWellFormed() || FORBIDDEN.test(userPath)) {
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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') break; // handled: rest does not exist yet
      if (code === 'ENOTDIR') throw new AppError('NOT_A_DIRECTORY');
      throw err;
    }
    if (st.isSymbolicLink()) throw new AppError('PATH_SYMLINK');
  }
  const target = join(realRoot, ...segments);
  if (Buffer.byteLength(target) > MAX_PATH_BYTES) throw new AppError('PATH_INVALID');
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new AppError('PATH_INVALID');
  return target;
}
