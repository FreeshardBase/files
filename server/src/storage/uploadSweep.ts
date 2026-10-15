import type { Dirent } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { homeRoot, homesDir } from '../paths.ts';
import { TEMP_NAME } from './local.ts';

export type SweepResult = { removed: number; failed: number };

const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? 'unknown';

// Removes `.<16hex>.upload` files that a crash or an aborted request left behind. Runs before the server listens, so no
// upload can be in flight. Only regular files are removed; symlinks are neither followed nor removed. A directory or file
// that fails is logged with its home-relative path and the sweep goes on; file names stay out of the info line.
export async function sweepUploadTemps(dataDir: string, log: FastifyBaseLogger): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, failed: 0 };
  let homes: Dirent[];
  try { homes = await readdir(homesDir(dataDir), { withFileTypes: true }); }
  catch (e) { // handled: no homes dir yet (fresh install) means nothing to sweep; any other error is logged and counted
    if (code(e) !== 'ENOENT') { result.failed++; log.warn({ home: null, path: '/', code: code(e) }, 'upload temp sweep could not read a directory'); }
    homes = [];
  }
  for (const h of homes) {
    if (h.isDirectory()) await sweepDir(homeRoot(dataDir, h.name), '/', h.name, log, result);
  }
  log.info(result, 'upload temp sweep finished');
  return result;
}

async function sweepDir(abs: string, rel: string, home: string, log: FastifyBaseLogger, result: SweepResult): Promise<void> {
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); }
  catch (e) { // handled: logged with its path and counted; the sweep continues with the remaining directories
    result.failed++;
    log.warn({ home, path: rel, code: code(e) }, 'upload temp sweep could not read a directory');
    return;
  }
  for (const d of entries) {
    if (d.isDirectory()) await sweepDir(join(abs, d.name), posix.join(rel, d.name), home, log, result);
    else if (d.isFile() && TEMP_NAME.test(d.name)) {
      try { await unlink(join(abs, d.name)); result.removed++; }
      catch (e) { // handled: logged with its path and counted; the sweep continues
        result.failed++;
        log.warn({ home, path: posix.join(rel, d.name), code: code(e) }, 'upload temp sweep could not remove a file');
      }
    }
  }
}
