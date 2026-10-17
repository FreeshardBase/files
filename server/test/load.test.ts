import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import sharp from 'sharp';
import { homeRoot } from '../src/paths.ts';
import { rebuildNameIndexes } from '../src/storage/reindex.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #300: the load profile of scripts/load/run.ts, scaled to fit the suite. Everything goes over a real socket, so a
// handler that buffered a body or a file, or a synchronous pass over the whole home, shows up in the process's memory
// or as an event-loop stall. The numbers at full scale are in docs/perf.md.

const MB = 1024 ** 2;
const MAX_STALL_MS = 200;
let t: TestApp; let s: { cookie: string; csrf: string }; let home: string; let base: string; let userId: string;

beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(4 * 1024 ** 3) });
  s = await login(t);
  userId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id;
  home = homeRoot(t.dataDir, userId);
  mkdirSync(home, { recursive: true });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await t.close(); }, 30_000);

const get = (path: string) => fetch(base + path, { headers: { cookie: s.cookie } });
const write = () => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: t.config.publicUrl.origin, 'tus-resumable': '1.0.0' });

// The longest event-loop stall and the RSS growth while `fn` runs.
async function watched<T>(fn: () => Promise<T>): Promise<{ value: T; stallMs: number; rssGrowthMb: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  const start = process.memoryUsage.rss();
  let peak = start;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 10);
  h.enable();
  try {
    const value = await fn();
    return { value, stallMs: h.max / 1e6, rssGrowthMb: (Math.max(peak, process.memoryUsage.rss()) - start) / MB };
  } finally { h.disable(); clearInterval(sampler); }
}

function sparse(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
}

describe('a home of 10 000 files in 200 folders', () => {
  beforeAll(async () => {
    for (let i = 0; i < 10_000; i++) {
      const f = i < 2040 ? 0 : 1 + ((i - 2040) % 199);
      const dir = join(home, 'load', `folder-${String(f).padStart(3, '0')}`);
      if (i === 0 || i >= 2040 && i < 2040 + 199) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `file-${String(i).padStart(5, '0')}.txt`), `file ${i}\n`);
    }
    await rebuildNameIndexes({ config: t.config, db: t.db }, [userId]);
  }, 60_000);

  it('lists its biggest folder page by page, every entry once and in order, without stalling', async () => {
    const r = await watched(async () => {
      const names: string[] = []; let cursor: string | undefined;
      do {
        const res = await get(`/api/v1/sources/home/list?path=/load/folder-000&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        const body = await res.json() as { entries: { name: string }[]; next?: string };
        names.push(...body.entries.map((e) => e.name)); cursor = body.next;
      } while (cursor);
      return names;
    });
    expect(r.value).toHaveLength(2040);
    expect(r.value).toEqual([...r.value].sort());
    expect(r.value[0]).toBe('file-00000.txt');
    expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
  });

  it('searches all of it from the index without stalling', async () => {
    const r = await watched(async () => {
      const all = await (await get('/api/v1/search?q=file')).json() as { groups: { items: unknown[]; more: boolean }[] };
      const one = await (await get('/api/v1/search?q=file-09999')).json() as { groups: { items: { path: string }[] }[] };
      return { all: all.groups[0]!, one: one.groups[0]! };
    });
    expect(r.value.all.items).toHaveLength(50);
    expect(r.value.all.more).toBe(true);
    expect(r.value.one.items.map((i) => i.path)).toEqual([`/load/folder-${String(1 + ((9999 - 2040) % 199)).padStart(3, '0')}/file-09999.txt`]);
    expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
  });

  it('rebuilds the name index of all of it without stalling', async () => {
    const r = await watched(() => rebuildNameIndexes({ config: t.config, db: t.db }, [userId]));
    expect(r.value[0]!.items).toBe(10_000 + 200 + 1);
    expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
  });
});

it('streams the ZIP of a 1 GB folder without holding it in memory', async () => {
  mkdirSync(join(home, 'zip1g'));
  for (let i = 0; i < 16; i++) sparse(join(home, 'zip1g', `part-${i}.bin`), 64 * MB);
  const r = await watched(async () => {
    const res = await get('/api/v1/sources/home/zip?path=/zip1g');
    expect(res.status).toBe(200);
    let bytes = 0;
    for await (const chunk of res.body!) bytes += chunk.length;
    return bytes;
  });
  expect(r.value).toBeGreaterThan(1024 * MB);
  expect(r.value).toBeLessThan(1024 * MB + 64 * 1024);
  expect(r.rssGrowthMb).toBeLessThan(200);
  expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
}, 60_000);

it('takes 8 parallel tus uploads of 64 MB in 8 MB chunks, byte for byte, without holding them in memory', async () => {
  const size = 64 * MB; const chunkBytes = 8 * MB;
  const chunks = Array.from({ length: size / chunkBytes }, (_, i) => Buffer.alloc(chunkBytes, i + 1));
  const want = createHash('sha256'); for (const c of chunks) want.update(c);
  const r = await watched(() => Promise.all(Array.from({ length: 8 }, async (_, u) => {
    const meta = `source ${Buffer.from('home').toString('base64')},path ${Buffer.from(`/parallel/up-${u}.bin`).toString('base64')}`;
    const c = await fetch(`${base}/api/v1/uploads`, { method: 'POST', headers: { ...write(), 'upload-length': String(size), 'upload-metadata': meta } });
    expect(c.status).toBe(201);
    for (let i = 0; i < chunks.length; i++) {
      const p = await fetch(base + c.headers.get('location')!, { method: 'PATCH', body: chunks[i],
        headers: { ...write(), 'content-type': 'application/offset+octet-stream', 'upload-offset': String(i * chunkBytes) } });
      expect(p.status).toBe(204);
    }
  })));
  for (let u = 0; u < 8; u++) {
    const res = await get(`/api/v1/sources/home/content?path=/parallel/up-${u}.bin`);
    const got = createHash('sha256');
    for await (const chunk of res.body!) got.update(chunk);
    expect(got.digest('hex')).toBe(want.copy().digest('hex'));
  }
  // 8 × 64 MB arrive; holding them would add 512 MB.
  expect(r.rssGrowthMb).toBeLessThan(400);
  expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
}, 60_000);

it('generates thumbnails for 100 images, 6 requests at a time, without stalling', async () => {
  const create = { width: 1024, height: 768, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 40 } } as const;
  const jpeg = await sharp({ create }).jpeg().toBuffer();
  mkdirSync(join(home, 'images'));
  for (let i = 0; i < 100; i++) writeFileSync(join(home, 'images', `img-${i}.jpg`), jpeg);
  let next = 0; const types = new Set<string>();
  const r = await watched(() => Promise.all(Array.from({ length: 6 }, async () => {
    while (next < 100) {
      const res = await get(`/api/v1/sources/home/thumbnail?path=/images/img-${next++}.jpg&size=256`);
      expect(res.status).toBe(200);
      types.add(res.headers.get('content-type')!);
      for await (const chunk of res.body!) expect(chunk.length).toBeGreaterThan(0);
    }
  })));
  expect([...types]).toEqual(['image/webp']);
  expect(r.stallMs).toBeLessThan(MAX_STALL_MS);
}, 60_000);
