import { crc32 } from 'node:zlib';
import type { Entry } from '@files/shared';
import { AppError } from '../errors.ts';
import type { StorageBackend } from './backend.ts';

// A streamed ZIP archive (APPNOTE 6.3.10) built from any StorageBackend. Entries are stored, not deflated: the CRC is
// computed while the bytes pass through, so nothing is held in memory or written to disk except the central
// directory (about 100 bytes per entry). Every file entry is ZIP64 from the start (sizes in a 64-bit data descriptor),
// because its size is only known once it has been read. The walk uses the backend's own `list` and `read`, so an
// archive never holds what a listing would not show (symlinks, `<root>/.files/`, upload temp files) and every path
// goes through the backend's resolver.

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const V_ZIP64 = 45;
const MADE_BY = (3 << 8) | V_ZIP64; // Unix, so the external attributes carry the mode
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const PAGE = 1000;

export type ZipRoot = { name: string; entry: Entry };

// Names come from listings and normalised user paths; this is the last check that none can escape on extraction.
function safeName(name: string): string {
  const segs = name.split('/');
  if (name.length === 0 || segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) {
    throw new AppError('PATH_INVALID');
  }
  return name;
}

function dosTime(iso: string): { time: number; date: number } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.min(d.getFullYear(), 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function* walk(b: StorageBackend, entry: Entry, name: string): AsyncGenerator<{ name: string; entry: Entry }> {
  yield { name, entry };
  if (entry.type !== 'directory') return;
  let cursor: string | undefined;
  do {
    const page = await b.list(entry.path, cursor, PAGE);
    for (const child of page.entries) yield* walk(b, child, `${name}/${child.name}`);
    cursor = page.next;
  } while (cursor);
}

/**
 * The archive as a byte stream. A read or list error after the first byte ends the generator with that error; the
 * route then aborts the response, so the client sees a failed download rather than a silently incomplete archive.
 * Closing the stream early (client disconnect) returns the generator, which destroys the open file stream.
 */
export async function* zipStream(b: StorageBackend, roots: readonly ZipRoot[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  const emit = (buf: Buffer) => { offset += buf.length; return buf; };

  for (const r of roots) {
    for await (const { name: raw, entry } of walk(b, r.entry, r.name)) {
      const isDir = entry.type === 'directory';
      const name = Buffer.from(safeName(raw) + (isDir ? '/' : ''), 'utf8');
      const { time, date } = dosTime(entry.modified);
      const start = offset;
      const flags = FLAG_UTF8 | (isDir ? 0 : FLAG_DESCRIPTOR);

      const local = Buffer.alloc(30 + name.length + (isDir ? 0 : 20));
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(V_ZIP64, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      // CRC 0; sizes 0 for a folder, 0xFFFFFFFF (see the ZIP64 extra, then the descriptor) for a file.
      if (!isDir) { local.writeUInt32LE(U32_MAX, 18); local.writeUInt32LE(U32_MAX, 22); }
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(isDir ? 0 : 20, 28);
      name.copy(local, 30);
      if (!isDir) { local.writeUInt16LE(0x0001, 30 + name.length); local.writeUInt16LE(16, 32 + name.length); } // sizes 0
      yield emit(local);

      let crc = 0; let size = 0;
      if (!isDir) {
        const { stream } = await b.read(entry.path);
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          yield emit(chunk);
        }
        const dd = Buffer.alloc(24);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc, 4);
        dd.writeBigUInt64LE(BigInt(size), 8);
        dd.writeBigUInt64LE(BigInt(size), 16);
        yield emit(dd);
      }

      // ZIP64 extra in the central directory: the sizes for every file, the offset once it no longer fits 32 bits.
      const bigOffset = start >= U32_MAX;
      const fields = [...(isDir ? [] : [size, size]), ...(bigOffset ? [start] : [])];
      const extraLen = fields.length ? 4 + 8 * fields.length : 0;
      const c = Buffer.alloc(46 + name.length + extraLen);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(MADE_BY, 4);
      c.writeUInt16LE(V_ZIP64, 6);
      c.writeUInt16LE(flags, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(isDir ? 0 : U32_MAX, 20);
      c.writeUInt32LE(isDir ? 0 : U32_MAX, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt16LE(extraLen, 30);
      // comment length, disk number, internal attributes: 0
      c.writeUInt32LE((((isDir ? 0o040755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
      c.writeUInt32LE(bigOffset ? U32_MAX : start, 42);
      name.copy(c, 46);
      if (extraLen) {
        let o = 46 + name.length;
        c.writeUInt16LE(0x0001, o); c.writeUInt16LE(extraLen - 4, o + 2); o += 4;
        for (const f of fields) { c.writeBigUInt64LE(BigInt(f), o); o += 8; }
      }
      central.push(c);
    }
  }

  const cdStart = offset;
  for (const c of central) yield emit(c);
  const cdSize = offset - cdStart;
  const count = central.length;

  const z64At = offset;
  const z = Buffer.alloc(56);
  z.writeUInt32LE(0x06064b50, 0);
  z.writeBigUInt64LE(44n, 4); // size of the rest of this record
  z.writeUInt16LE(MADE_BY, 12);
  z.writeUInt16LE(V_ZIP64, 14);
  // this disk, disk with the central directory: 0
  z.writeBigUInt64LE(BigInt(count), 24);
  z.writeBigUInt64LE(BigInt(count), 32);
  z.writeBigUInt64LE(BigInt(cdSize), 40);
  z.writeBigUInt64LE(BigInt(cdStart), 48);
  yield emit(z);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(z64At), 8);
  loc.writeUInt32LE(1, 16); // total disks
  yield emit(loc);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, U16_MAX), 8);
  end.writeUInt16LE(Math.min(count, U16_MAX), 10);
  end.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
  end.writeUInt32LE(Math.min(cdStart, U32_MAX), 16);
  yield emit(end);
}
