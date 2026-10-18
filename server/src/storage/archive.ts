import { PassThrough, pipeline, type Readable } from 'node:stream';
import yauzl from 'yauzl';
import { AppError } from '../errors.ts';
import type { StorageBackend } from './backend.ts';

/** More entries than this in one archive is refused (#322): an export part holds far fewer. */
export const ARCHIVE_MAX_ENTRIES = 200_000;
/**
 * An archive whose entries expand to more than ARCHIVE_MAX_RATIO times its own size, and to more than
 * ARCHIVE_BOMB_FLOOR, is a zip bomb and refused before anything is extracted. Each entry's stream is also checked against
 * its declared size while it is read (yauzl's `validateEntrySizes`), so a header that lies fails that entry.
 */
export const ARCHIVE_MAX_RATIO = 100;
export const ARCHIVE_BOMB_FLOOR = 1024 ** 3;

/** The folder names of a photo export (#322): those go to Immich, never into Files. */
const GOOGLE_PHOTOS = new Set(['Google Photos', 'Google Fotos', 'Google Foto']);
const APPLE_PHOTOS = new Set(['iCloud Photos', 'iCloud-Fotos', 'iCloud Fotos']);

const S_IFMT = 0o170000;
const ALLOWED_TYPES = new Set([0, 0o100000, 0o040000]);

/** An opened archive: its central directory read once, the entries by their raw name, opened again for each entry. */
export type OpenedArchive = { zip: yauzl.ZipFile; entries: Map<string, yauzl.Entry> };
/** What an import makes of one archive: entries placed below the target, and the parts it leaves out. */
export type ArchivePlan = {
  items: { name: string; rel: string; type: 'file' | 'directory'; size: number; modified: string }[];
  skipped: { name: string; reason: 'photos' | 'other' }[];
};

// Reads the archive through the backend's ranged `read`, so it goes through the home's own path rules and is never copied.
class BackendReader extends yauzl.RandomAccessReader {
  constructor(private backend: StorageBackend, private path: string) { super(); }
  _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    if (end <= start) { out.end(); return out; }
    this.backend.read(this.path, { start, end: end - 1 }).then(
      (r) => { pipeline(r.stream, out, () => undefined); }, // a failure on either side destroys `out`, and yauzl reports it
      (e: unknown) => { out.destroy(e instanceof Error ? e : new Error(String(e))); });
    return out;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString('utf8');
  try { return decoder.decode(raw); } catch { return raw.toString('latin1'); } // handled: a name in a legacy code page is read as Latin-1
}

/**
 * Opens the ZIP `path` of `backend` and reads its central directory: every entry by name. Not a readable ZIP is
 * ARCHIVE_INVALID; more than ARCHIVE_MAX_ENTRIES is ARCHIVE_TOO_LARGE.
 */
export async function openArchive(backend: StorageBackend, path: string, size: number): Promise<OpenedArchive> {
  const reader = new BackendReader(backend, path);
  let zip: yauzl.ZipFile;
  try {
    zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.fromRandomAccessReader(reader, size,
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('ARCHIVE_INVALID');
  }
  if (zip.entryCount > ARCHIVE_MAX_ENTRIES) { zip.close(); throw new AppError('ARCHIVE_TOO_LARGE'); }
  const entries = new Map<string, yauzl.Entry>();
  try {
    await new Promise<void>((res, rej) => {
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.set(decodeName(entry.fileName as unknown as Buffer, entry.generalPurposeBitFlag), entry);
        zip.readEntry();
      });
      zip.once('end', () => res());
      zip.once('error', rej);
      zip.readEntry();
    });
  } catch (e) {
    zip.close();
    if (e instanceof AppError) throw e;
    throw new AppError('ARCHIVE_INVALID');
  }
  return { zip, entries };
}

/** The bytes of one entry, decompressed and checked against its declared size while they are read. */
export function entryStream(archive: OpenedArchive, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((res, rej) => archive.zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
}

/**
 * What an import makes of the entries (#322). Refused as a whole, before anything is written: an absolute path, a `..`
 * segment, a backslash or NUL in a name, a symlink or device entry (ARCHIVE_UNSAFE); encryption or a compression other
 * than stored and deflate (ARCHIVE_INVALID); a zip bomb (ARCHIVE_TOO_LARGE). The layout decides what lands where:
 * Google Takeout (`Takeout/Drive/…`; `Takeout/Google Photos` and every other product are skipped), an Apple iCloud
 * Drive export (`iCloud Drive/…`; `iCloud Photos` skipped) or a plain ZIP, taken as it is.
 */
export function planArchive(archive: OpenedArchive, archiveSize: number): ArchivePlan {
  const parsed: { name: string; segs: string[]; dir: boolean; entry: yauzl.Entry }[] = [];
  let expanded = 0;
  for (const [name, entry] of archive.entries) {
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) throw new AppError('ARCHIVE_UNSAFE');
    const segs = name.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.includes('..')) throw new AppError('ARCHIVE_UNSAFE');
    const madeOnUnix = entry.versionMadeBy >> 8 === 3;
    const type = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (madeOnUnix && !ALLOWED_TYPES.has(type)) throw new AppError('ARCHIVE_UNSAFE');
    if (entry.generalPurposeBitFlag & 0x1 || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) throw new AppError('ARCHIVE_INVALID');
    expanded += entry.uncompressedSize;
    parsed.push({ name, segs, dir: name.endsWith('/') || (madeOnUnix && type === 0o040000), entry });
  }
  if (expanded > ARCHIVE_BOMB_FLOOR && expanded > ARCHIVE_MAX_RATIO * archiveSize) throw new AppError('ARCHIVE_TOO_LARGE');
  const google = parsed.some((p) => p.segs[0] === 'Takeout');
  const apple = !google && parsed.some((p) => p.segs[0] === 'iCloud Drive' || APPLE_PHOTOS.has(p.segs[0]!));
  const plan: ArchivePlan = { items: [], skipped: [] };
  const skipped = new Set<string>();
  const skip = (name: string, reason: 'photos' | 'other') => {
    if (!skipped.has(name)) { skipped.add(name); plan.skipped.push({ name, reason }); }
  };
  for (const p of parsed) {
    let rel = p.segs;
    if (google && p.segs[0] === 'Takeout') {
      if (p.segs.length < 2) continue;
      if (p.segs[1] === 'Drive') rel = p.segs.slice(2);
      else { skip(p.segs.slice(0, 2).join('/'), GOOGLE_PHOTOS.has(p.segs[1]!) ? 'photos' : 'other'); continue; }
    } else if (apple && p.segs[0] === 'iCloud Drive') rel = p.segs.slice(1);
    else if (apple && APPLE_PHOTOS.has(p.segs[0]!)) { skip(p.segs[0]!, 'photos'); continue; }
    if (!rel.length) continue;
    plan.items.push({ name: p.name, rel: `/${rel.join('/')}`.normalize('NFC'), type: p.dir ? 'directory' : 'file',
      size: p.entry.uncompressedSize, modified: p.entry.getLastModDate().toISOString() });
  }
  return plan;
}
