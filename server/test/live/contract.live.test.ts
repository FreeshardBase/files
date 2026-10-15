import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Entry } from '@files/shared';
import { OAuthClient, systemClock, type Provider } from '../../src/cloud/oauth.ts';
import { googleDriveProvider } from '../../src/cloud/googleDrive.ts';
import { dropboxProvider } from '../../src/cloud/dropbox.ts';
import type { StorageBackend } from '../../src/storage/backend.ts';

// The whole StorageBackend contract, live against each real provider whose LIVE_<P>_* variables are set (server/.env.live);
// otherwise that provider's suite is skipped, never passed. Everything happens in one fresh folder that is deleted at the
// end (it lands in the provider's trash). The fakes once diverged from the real APIs (#201); this is the net for that.
type Live = { name: string; prefix: string; make: (c: { clientId: string; clientSecret: string }) => Provider };
const PROVIDERS: Live[] = [
  { name: 'Google Drive', prefix: 'GDRIVE', make: (c) => googleDriveProvider(c) },
  { name: 'Dropbox', prefix: 'DROPBOX', make: (c) => dropboxProvider(c) },
];

const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function bytes(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

for (const p of PROVIDERS) {
  const vars = ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_${p.prefix}_${v}`]);
  describe.skipIf(vars.some((v) => !v))(`live contract: ${p.name} (LIVE_${p.prefix}_*)`, () => {
    it('passes every step of the StorageBackend contract', { timeout: 15 * 60_000 }, async () => {
      const [refresh, clientId, clientSecret] = vars.map((v) => v!) as [string, string, string];
      const provider = p.make({ clientId, clientSecret });
      let stored = refresh;
      const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; },
        setStatus: () => undefined }, systemClock);
      const b: StorageBackend = provider.backend(client, '');
      const dir = `/freeshard-files-contract-${randomBytes(5).toString('hex')}`;
      const failures: string[] = [];
      const step = async (name: string, fn: () => Promise<void>) => {
        try { await fn(); } catch (e) { // handled: recorded and asserted below, so one broken step does not hide the others
          failures.push(`${name}: ${e instanceof Error ? `${e.constructor.name} ${(e as { code?: string }).code ?? ''} ${e.message}` : String(e)}`);
        }
      };
      const small = Buffer.from(`contract ${new Date().toISOString()} äöü`);
      const changed = Buffer.from('changed content');
      const big = randomBytes(20 * MB + 12345);
      const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
      let etag = '';

      await step('mkdir', async () => { expect(await b.mkdir(dir)).toMatchObject({ type: 'directory' }); });
      try {
        await step('mkdir existing → FILE_EXISTS', async () => { await expect(b.mkdir(dir)).rejects.toMatchObject({ code: 'FILE_EXISTS' }); });
        await step('write small', async () => {
          const e = await b.write(`${dir}/a.txt`, Readable.from([small]), { onCollision: 'fail', maxBytes: MB, size: small.length });
          expect(e).toMatchObject({ path: `${dir}/a.txt`, type: 'file', size: small.length });
        });
        await step('stat', async () => { expect(await b.stat(`${dir}/a.txt`)).toMatchObject({ type: 'file', size: small.length }); });
        await step('list', async () => {
          const l = await b.list(dir);
          expect(l.entries.map((x: Entry) => x.name)).toContain('a.txt');
        });
        await step('read whole', async () => {
          const r = await b.read(`${dir}/a.txt`);
          etag = r.etag;
          expect(r.entry).toMatchObject({ size: small.length });
          expect((await bytes(r.stream)).equals(small)).toBe(true);
        });
        await step('read range', async () => {
          const r = await b.read(`${dir}/a.txt`, { start: 2, end: 6 });
          expect((await bytes(r.stream)).equals(small.subarray(2, 7))).toBe(true);
        });
        await step('write collision fail → FILE_EXISTS', async () => {
          await expect(b.write(`${dir}/a.txt`, Readable.from([changed]), { onCollision: 'fail', maxBytes: MB, size: changed.length }))
            .rejects.toMatchObject({ code: 'FILE_EXISTS' });
        });
        await step('write keep-both', async () => {
          const e = await b.write(`${dir}/a.txt`, Readable.from([changed]), { onCollision: 'keep-both', maxBytes: MB, size: changed.length });
          expect(e.name).not.toBe('a.txt');
        });
        await step('write replace with wrong If-Match → PRECONDITION_FAILED', async () => {
          await expect(b.write(`${dir}/a.txt`, Readable.from([changed]),
            { onCollision: 'replace', maxBytes: MB, size: changed.length, ifMatch: '"nope"' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        });
        await step('write replace with If-Match', async () => {
          await b.write(`${dir}/a.txt`, Readable.from([changed]), { onCollision: 'replace', maxBytes: MB, size: changed.length, ifMatch: etag });
          expect((await bytes((await b.read(`${dir}/a.txt`)).stream)).equals(changed)).toBe(true);
        });
        await step('write empty file', async () => {
          const e = await b.write(`${dir}/empty.txt`, Readable.from([]), { onCollision: 'fail', maxBytes: MB, size: 0 });
          expect(e).toMatchObject({ size: 0 });
          expect((await bytes((await b.read(`${dir}/empty.txt`)).stream)).length).toBe(0);
        });
        await step('write 20 MB in chunks, read back', async () => {
          const parts = Array.from({ length: Math.ceil(big.length / (MB / 2)) }, (_, i) => big.subarray(i * MB / 2, (i + 1) * MB / 2));
          const e = await b.write(`${dir}/big.bin`, Readable.from(parts), { onCollision: 'fail', maxBytes: 100 * MB, size: big.length });
          expect(e.size).toBe(big.length);
          const r = await b.read(`${dir}/big.bin`);
          expect(sha(await bytes(r.stream))).toBe(sha(big));
        });
        await step('size mismatch leaves nothing', async () => {
          await expect(b.write(`${dir}/short.bin`, Readable.from([small]), { onCollision: 'fail', maxBytes: MB, size: small.length + 10 }))
            .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
          await expect(b.stat(`${dir}/short.bin`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
        await step('mkdir nested + copy file', async () => {
          await b.mkdir(`${dir}/sub`);
          expect(await b.copy(`${dir}/a.txt`, `${dir}/sub/a.txt`, 'fail')).toMatchObject({ path: `${dir}/sub/a.txt` });
        });
        await step('copy folder', async () => {
          await b.copy(`${dir}/sub`, `${dir}/sub-copy`, 'fail');
          expect((await b.list(`${dir}/sub-copy`)).entries.map((x: Entry) => x.name)).toContain('a.txt');
        });
        await step('move folder', async () => {
          await b.move(`${dir}/sub-copy`, `${dir}/sub/moved`, 'fail');
          expect((await b.list(`${dir}/sub/moved`)).entries.map((x: Entry) => x.name)).toContain('a.txt');
          await expect(b.stat(`${dir}/sub-copy`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
        await step('folder into itself refused', async () => {
          await expect(b.move(`${dir}/sub`, `${dir}/sub/moved/inner`, 'fail')).rejects.toBeTruthy();
        });
        await step('rename case only', async () => {
          expect(await b.move(`${dir}/sub/a.txt`, `${dir}/sub/A.txt`, 'fail')).toMatchObject({ name: 'A.txt' });
        });
        await step('move collision fail → FILE_EXISTS', async () => {
          await b.copy(`${dir}/a.txt`, `${dir}/b.txt`, 'fail');
          await expect(b.move(`${dir}/b.txt`, `${dir}/a.txt`, 'fail')).rejects.toMatchObject({ code: 'FILE_EXISTS' });
        });
        await step('move replace', async () => {
          await b.move(`${dir}/b.txt`, `${dir}/a.txt`, 'replace');
          await expect(b.stat(`${dir}/b.txt`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
        await step('thumbnail of png', async () => {
          await b.write(`${dir}/pic.png`, Readable.from([png]), { onCollision: 'fail', maxBytes: MB, size: png.length });
          if (!b.thumbnail) return;
          const t = await eventually(() => b.thumbnail!(`${dir}/pic.png`, 256), (v) => v !== null);
          expect(t).not.toBeNull();
          const meta = await sharp(await bytes(t!)).metadata();
          expect(meta.format).toBe('webp');
        });
        await step('thumbnail of text is null or a WebP (Drive renders text files), never an error', async () => {
          const t = b.thumbnail ? await b.thumbnail(`${dir}/a.txt`, 128) : null;
          if (t) expect((await sharp(await bytes(t)).metadata()).format).toBe('webp');
        });
        await step('search', async () => {
          if (!b.search) return;
          const hits = await eventually(() => b.search!('pic.png', 50), (v) => v.some((e) => e.path === `${dir}/pic.png`), 120_000);
          expect(hits.map((e) => e.path)).toContain(`${dir}/pic.png`);
        });
        await step('quota', async () => {
          if (!b.quota) return;
          const q = await b.quota();
          expect(q).not.toBeNull(); // the live accounts are personal drives, which always report usage
          expect(q!.used).toBeGreaterThan(0);
        });
        await step('revisions + restore', async () => {
          if (!b.revisions) return;
          const revs = await b.revisions(`${dir}/a.txt`);
          expect(revs.length).toBeGreaterThanOrEqual(1);
          expect(revs.at(-1)?.current).toBe(true);
          const older = revs.find((r) => !r.current && r.size === small.length);
          if (older && b.restoreRevision) {
            await b.restoreRevision(`${dir}/a.txt`, older.id);
            expect((await bytes((await b.read(`${dir}/a.txt`)).stream)).equals(small)).toBe(true);
          } else if (b.restoreRevision) failures.push(`revisions: no earlier revision of size ${small.length} in ${JSON.stringify(revs)}`);
        });
        await step('list paging (limit is a hint; Drive answers whole folders to disambiguate names)', async () => {
          const all = new Set((await b.list(dir)).entries.map((e: Entry) => e.path));
          const seen = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await b.list(dir, cursor, 2);
            page.entries.forEach((e: Entry) => seen.add(e.path));
            cursor = page.next;
          } while (cursor);
          expect([...seen].sort()).toEqual([...all].sort());
        });
        await step('read first file of root (existing user content)', async () => {
          const root = await b.list('/');
          const f = root.entries.find((e: Entry) => e.type === 'file');
          if (!f) return;
          const r = await b.read(f.path, { start: 0, end: 0 }).catch(async (e: unknown) => { // handled: unsized exports refuse ranges
            if ((e as { code?: string }).code === 'RANGE_NOT_SATISFIABLE') return b.read(f.path);
            throw e;
          });
          await bytes(r.stream);
        });
        await step('delete several, all or nothing', async () => {
          await b.delete([`${dir}/empty.txt`, `${dir}/big.bin`]);
          await expect(b.stat(`${dir}/big.bin`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
      } finally {
        await step('delete folder', async () => {
          await b.delete([dir]);
          await expect(b.stat(dir)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
      }
      if (stored !== refresh) console.warn(`${p.name} rotated the refresh token; re-export LIVE_${p.prefix}_REFRESH_TOKEN`);
      expect(failures).toEqual([]);
    });
  });
}
