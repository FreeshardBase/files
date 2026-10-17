// Load test of the local backend (#300): seeds a home, then measures the listing of its biggest folder, search, the
// ZIP of a 1 GB folder, 8 parallel 200 MB uploads and 500 thumbnails. `pnpm load` runs it; it needs about 3 GB of free
// disk under the temp dir (the 5 GB file and the 1 GB folder are sparse) and prints a Markdown table for docs/perf.md.
// The app is the real one (NODE_ENV=production, fake IdP login) listening on a loopback port; client and server share
// the process, so RSS and event-loop lag include the client's little work (discarding the bytes it reads).
import { mkdirSync, openSync, closeSync, ftruncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { startTestApp, login } from '../../server/test/support/harness.ts';
import { homeRoot } from '../../server/src/paths.ts';
import { rebuildNameIndexes } from '../../server/src/storage/reindex.ts';

// sharp is the server's dependency, so it is resolved from there rather than from this file.
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp') as typeof import('sharp');
const MB = 1024 ** 2;
const FOLDERS = 200;
const FILES = 10_000;
const BIGGEST = 2040; // the rest are spread evenly over the other 199 folders (40 each)
const IMAGES = 500;
const UPLOADS = 8;
const UPLOAD_BYTES = 200 * MB;
const CHUNK = 8 * MB; // the SPA's tus chunk (web/src/api/tus.ts)

type Result = { step: string; ms: number; maxLagMs: number; maxRssMb: number; note: string };
const results: Result[] = [];

// Samples RSS every 20 ms and the event loop's longest stall while `fn` runs.
async function measure(step: string, fn: () => Promise<string>): Promise<void> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  let maxRss = process.memoryUsage.rss();
  const sampler = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage.rss()); }, 20);
  h.enable();
  const t0 = performance.now();
  const note = await fn();
  const ms = performance.now() - t0;
  h.disable(); clearInterval(sampler);
  results.push({ step, ms, maxLagMs: h.max / 1e6, maxRssMb: maxRss / MB, note });
  console.error(`${step}: ${ms.toFixed(0)} ms, lag ${(h.max / 1e6).toFixed(0)} ms, rss ${(maxRss / MB).toFixed(0)} MB ${note}`);
}

function sparse(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
}

const t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(10 * 1024 ** 3), FILES_THUMB_CACHE_BYTES: String(1024 ** 3) });
try {
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  const s = await login(t);
  const userId = t.db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').pluck().get() as string;
  const home = homeRoot(t.dataDir, userId);
  const get = (path: string) => fetch(base + path, { headers: { cookie: s.cookie } });
  const write = { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: t.config.publicUrl.origin, 'tus-resumable': '1.0.0' };

  const post = async (path: string, body: unknown, want: number) => {
    const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { ...write, 'content-type': 'application/json' } });
    if (r.status !== want) throw new Error(`${path} ${r.status} ${await r.text()}`);
    return r;
  };

  await measure('seed on disk (the script itself, not the app)', async () => {
    const noise = { width: 1024, height: 768, channels: 3 as const, noise: { type: 'gaussian' as const, mean: 128, sigma: 40 } };
    const jpeg = await sharp({ create: noise }).jpeg({ quality: 85 }).toBuffer();
    for (let f = 0; f < FOLDERS; f++) mkdirSync(join(home, 'load', `folder-${String(f).padStart(3, '0')}`), { recursive: true });
    for (let i = 0; i < FILES; i++) {
      const f = i < BIGGEST ? 0 : 1 + ((i - BIGGEST) % (FOLDERS - 1));
      writeFileSync(join(home, 'load', `folder-${String(f).padStart(3, '0')}`, `file-${String(i).padStart(5, '0')}.txt`), `file ${i}\n`.repeat(100));
    }
    mkdirSync(join(home, 'big')); sparse(join(home, 'big', 'huge.bin'), 5 * 1024 ** 3);
    mkdirSync(join(home, 'zip1g')); for (let i = 0; i < 16; i++) sparse(join(home, 'zip1g', `part-${i}.bin`), 64 * MB);
    mkdirSync(join(home, 'images'));
    for (let i = 0; i < IMAGES; i++) writeFileSync(join(home, 'images', `img-${String(i).padStart(3, '0')}.jpg`), jpeg);
    return `${FILES} files in ${FOLDERS} folders, 5 GB file, 1 GB folder, ${IMAGES} images`;
  });

  await measure('rebuild of the name index', async () => {
    const [r] = await rebuildNameIndexes({ config: t.config, db: t.db }, [userId]);
    return `${r!.items} items indexed`;
  });

  await measure('storage overview', async () => {
    const r = await get('/api/v1/storage');
    if (!r.ok) throw new Error(`storage ${r.status}`);
    await r.json();
    return 'largest folders from the index';
  });

  await measure(`copy of the ${FILES}-file folder`, async () => {
    await post('/api/v1/sources/home/copy', { from: '/load', to: '/load-copy', onCollision: 'fail' }, 201);
    return `${FILES} files copied`;
  });

  await measure(`rename of the copied folder`, async () => {
    await post('/api/v1/sources/home/move', { from: '/load-copy', to: '/load-moved', onCollision: 'fail' }, 200);
    return 'index rows follow';
  });

  await measure(`delete of the copied folder to the trash`, async () => {
    await post('/api/v1/sources/home/delete', { paths: ['/load-moved'] }, 204);
    return 'one trash item';
  });

  await measure('empty the trash', async () => {
    await post('/api/v1/trash/empty', {}, 204);
    return `${FILES} files freed`;
  });

  await measure('list biggest folder (all pages of 200)', async () => {
    let cursor: string | undefined; let n = 0; let pages = 0;
    do {
      const r = await get(`/api/v1/sources/home/list?path=/load/folder-000&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      if (!r.ok) throw new Error(`list ${r.status}`);
      const body = await r.json() as { entries: unknown[]; next?: string };
      n += body.entries.length; pages++; cursor = body.next;
    } while (cursor);
    return `${n} entries in ${pages} pages`;
  });

  for (const q of ['file', 'file-09999', 'nothing-matches']) {
    await measure(`search "${q}"`, async () => {
      const r = await get(`/api/v1/search?q=${q}`);
      if (!r.ok) throw new Error(`search ${r.status}`);
      const body = await r.json() as { groups: { items: unknown[] }[] };
      return `${body.groups[0]!.items.length} results`;
    });
  }

  await measure('ZIP of a 1 GB folder', async () => {
    const r = await get('/api/v1/sources/home/zip?path=/zip1g');
    if (!r.ok || !r.body) throw new Error(`zip ${r.status}`);
    let bytes = 0;
    for await (const chunk of r.body) bytes += chunk.length;
    return `${(bytes / MB).toFixed(0)} MB streamed`;
  });

  await measure('download of the 5 GB file', async () => {
    const r = await get('/api/v1/sources/home/content?path=/big/huge.bin&download=1');
    if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
    let bytes = 0;
    for await (const chunk of r.body) bytes += chunk.length;
    return `${(bytes / MB).toFixed(0)} MB streamed`;
  });

  await measure(`${UPLOADS} parallel tus uploads of ${UPLOAD_BYTES / MB} MB`, async () => {
    const chunk = Buffer.alloc(CHUNK, 7);
    await Promise.all(Array.from({ length: UPLOADS }, async (_, i) => {
      const meta = `source ${Buffer.from('home').toString('base64')},path ${Buffer.from(`/uploads/up-${i}.bin`).toString('base64')}`;
      const c = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...write, 'upload-length': String(UPLOAD_BYTES), 'upload-metadata': meta } });
      if (c.status !== 201) throw new Error(`create ${c.status} ${await c.text()}`);
      const url = base + c.headers.get('location')!;
      for (let offset = 0; offset < UPLOAD_BYTES; offset += CHUNK) {
        const p = await fetch(url, { method: 'PATCH', body: chunk,
          headers: { ...write, 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) } });
        if (p.status !== 204) throw new Error(`patch ${p.status} ${await p.text()}`);
      }
    }));
    return `${UPLOADS * UPLOAD_BYTES / MB} MB stored`;
  });

  await measure(`thumbnails for ${IMAGES} images (6 at a time, like a browser)`, async () => {
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < IMAGES) {
        const i = next++;
        const r = await get(`/api/v1/sources/home/thumbnail?path=/images/img-${String(i).padStart(3, '0')}.jpg&size=256`);
        if (!r.ok) throw new Error(`thumbnail ${r.status}`);
        // Read to the end: a cancelled fetch body keeps undici's socket open, and the app's close would wait for it.
        await r.bytes();
      }
    }));
    return `${IMAGES} generated`;
  });

  console.log('| Step | Time | Longest event-loop stall | Peak RSS | Result |');
  console.log('| --- | ---: | ---: | ---: | --- |');
  for (const r of results) {
    console.log(`| ${r.step} | ${r.ms.toFixed(0)} ms | ${r.maxLagMs.toFixed(0)} ms | ${r.maxRssMb.toFixed(0)} MB | ${r.note} |`);
  }
} finally {
  await t.close();
}
