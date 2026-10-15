import type { Dirent } from 'node:fs';
import { lstat, readdir, rm, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { homeRoot, homesDir } from '../paths.ts';
import { INTERNAL, TEMP_NAME } from './local.ts';

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
    if (!h.isDirectory()) continue;
    await sweepStaging(homeRoot(dataDir, h.name), h.name, log, result);
    await sweepDir(homeRoot(dataDir, h.name), '/', h.name, log, result);
  }
  log.info(result, 'upload temp sweep finished');
  return result;
}

// Copies are built in `<home>/.files/tmp/` and renamed into place; anything still there at startup is a copy a crash
// interrupted. Neither `.files` nor `tmp` is followed if it is a symlink; rm never follows the links inside.
async function sweepStaging(home: string, id: string, log: FastifyBaseLogger, result: SweepResult): Promise<void> {
  const tmp = join(home, INTERNAL, 'tmp');
  let names: string[];
  try {
    for (const dir of [join(home, INTERNAL), tmp]) {
      const st = await lstat(dir).catch((e: unknown) => { if (code(e) === 'ENOENT') return undefined; throw e; });
      if (!st?.isDirectory()) return;
    }
    names = await readdir(tmp);
  } catch (e) { // handled: logged with its path and counted; the sweep continues with the rest of the home
    result.failed++;
    log.warn({ home: id, path: posix.join('/', INTERNAL, 'tmp'), code: code(e) }, 'copy staging sweep could not read a directory');
    return;
  }
  for (const name of names) {
    try { await rm(join(tmp, name), { recursive: true, force: true }); result.removed++; }
    catch (e) { // handled: logged with its path and counted; the sweep continues
      result.failed++;
      log.warn({ home: id, path: posix.join('/', INTERNAL, 'tmp', name), code: code(e) }, 'copy staging sweep could not remove an entry');
    }
  }
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
