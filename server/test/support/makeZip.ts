import { crc32, deflateRawSync } from 'node:zlib';

/**
 * One entry of a test archive. `mode` is the Unix mode stored in the external attributes (a symlink is `0o120777`);
 * `declaredSize` lies about the expanded size (a zip bomb's header); `mtime` goes into the Info-ZIP "UT" extra field.
 */
export type ZipEntrySpec = { name: string; data?: Buffer | string; mtime?: Date; mode?: number; deflate?: boolean; declaredSize?: number };

/** A small ZIP (no ZIP64) built in memory for tests: stored or deflated entries, UTF-8 names. */
export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data) : e.data ?? Buffer.alloc(0);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const mtime = e.mtime ?? new Date('2024-01-01T00:00:00Z');
    const extra = Buffer.alloc(9);
    extra.writeUInt16LE(0x5455, 0); extra.writeUInt16LE(5, 2); extra.writeUInt8(1, 4);
    extra.writeInt32LE(Math.floor(mtime.getTime() / 1000), 5);
    const dosTime = (mtime.getUTCHours() << 11) | (mtime.getUTCMinutes() << 5) | (mtime.getUTCSeconds() >> 1);
    const dosDate = ((mtime.getUTCFullYear() - 1980) << 9) | ((mtime.getUTCMonth() + 1) << 5) | mtime.getUTCDate();
    const size = e.declaredSize ?? raw.length;
    const common = (b: Buffer, at: number) => {
      b.writeUInt16LE(20, at); b.writeUInt16LE(0x800, at + 2); b.writeUInt16LE(e.deflate ? 8 : 0, at + 4);
      b.writeUInt16LE(dosTime, at + 6); b.writeUInt16LE(dosDate, at + 8); b.writeUInt32LE(crc32(raw), at + 10);
      b.writeUInt32LE(body.length, at + 14); b.writeUInt32LE(size, at + 18);
      b.writeUInt16LE(name.length, at + 22); b.writeUInt16LE(extra.length, at + 24);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); common(local, 4);
    locals.push(local, name, extra, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); common(central, 6);
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
