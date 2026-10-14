import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeRoot } from '../src/storage/local.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp; let a: { cookie: string; csrf: string }; let m: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
beforeAll(async () => { t = await startTestApp(); a = await login(t, 'testuser'); m = await login(t, 'member'); });
afterAll(() => t.close());

const put = (s: typeof a, path: string, payload: string | Buffer, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload,
});
const get = (s: typeof a, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url, headers: { cookie: s.cookie, ...headers } });

describe('sources/home', () => {
  it('upload, list and download round-trip a file with an awkward name', async () => {
    const name = '/Prüfung #1 50%.txt';
    const up = await put(a, name, 'hallo');
    expect(up.statusCode).toBe(201);
    const list = (await get(a, '/api/v1/sources/home/list?path=%2F')).json();
    expect(list.entries.map((e: { name: string }) => e.name)).toContain('Prüfung #1 50%.txt');
    const dl = await get(a, `/api/v1/sources/home/content?path=${encodeURIComponent(name)}&download=1`);
    expect(dl.body).toBe('hallo');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('Prüfung #1 50%.txt')}`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
  it('answers a Range request with 206', async () => {
    await put(a, '/digits.txt', '0123456789');
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fdigits.txt', { range: 'bytes=2-4' });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe('234');
    expect(r.headers['content-range']).toBe('bytes 2-4/10');
    expect(r.headers['content-length']).toBe('3');
  });
  it('answers an unsatisfiable Range with 416 and content-range', async () => {
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fdigits.txt', { range: 'bytes=10-' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
    expect(r.json()).toEqual({ code: 'RANGE_NOT_SATISFIABLE' });
  });
  it('answers HEAD with headers and no body', async () => {
    const r = await t.app.inject({ method: 'HEAD', url: '/api/v1/sources/home/content?path=%2Fdigits.txt', headers: { cookie: a.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('10');
    expect(r.body).toBe('');
  });
  it('serves active content types as attachment even without download=1', async () => {
    await put(a, '/evil.html', '<script>alert(1)</script>');
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fevil.html');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
  });
  it('serves plain text inline', async () => {
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fdigits.txt');
    expect(String(r.headers['content-disposition'])).toMatch(/^inline/);
  });
  it('rejects content on a directory', async () => {
    await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: '/adir' } });
    const r = await get(a, '/api/v1/sources/home/content?path=%2Fadir');
    expect(r.json()).toEqual({ code: 'IS_A_DIRECTORY' });
  });
  it('isolates members: a member cannot see the admin home', async () => {
    const list = (await get(m, '/api/v1/sources/home/list?path=%2F')).json();
    expect(list.entries).toEqual([]);
    const r = await get(m, '/api/v1/sources/home/content?path=%2Fdigits.txt');
    expect(r.statusCode).toBe(404);
  });
  it('rejects traversal in every parameter', async () => {
    expect((await get(a, '/api/v1/sources/home/list?path=%2F..%2F..')).json()).toEqual({ code: 'PATH_INVALID' });
    expect((await put(a, '/../escape.txt', 'x')).json()).toEqual({ code: 'PATH_INVALID' });
  });
  it('pages the listing with limit and cursor and rejects a bad limit', async () => {
    for (const n of ['p1', 'p2', 'p3']) await put(a, `/page/${n}.txt`, n);
    const first = (await get(a, '/api/v1/sources/home/list?path=%2Fpage&limit=2')).json();
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = (await get(a, `/api/v1/sources/home/list?path=%2Fpage&limit=2&cursor=${encodeURIComponent(first.next)}`)).json();
    expect(second.entries.map((e: { name: string }) => e.name)).toEqual(['p3.txt']);
    expect((await get(a, '/api/v1/sources/home/list?path=%2Fpage&limit=0')).statusCode).toBe(400);
    expect((await get(a, '/api/v1/sources/home/list?path=%2Fpage&limit=abc')).statusCode).toBe(400);
  });
  it('stats an entry', async () => {
    const r = await get(a, '/api/v1/sources/home/stat?path=%2Fdigits.txt');
    expect(r.json()).toMatchObject({ name: 'digits.txt', type: 'file', size: 10 });
  });
  it('returns FILE_EXISTS on collision with fail and keeps both with keep-both', async () => {
    await put(a, '/dup.txt', 'one');
    expect((await put(a, '/dup.txt', 'two')).statusCode).toBe(409);
    expect((await put(a, '/dup.txt', 'two', 'keep-both')).json().name).toBe('dup (2).txt');
  });
  it('rejects an upload without the octet-stream content type', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fct.txt&onCollision=fail',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'text/plain' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ code: 'VALIDATION' });
  });
  it('rejects an upload larger than FILES_MAX_UPLOAD_BYTES', async () => {
    const small = await startTestApp({ FILES_MAX_UPLOAD_BYTES: '10' });
    const s = await login(small);
    const r = await small.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fbig.bin&onCollision=fail',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(11) });
    expect(r.statusCode).toBe(413);
    await small.close();
  });
  it('rejects an oversized chunked upload (no content-length) and leaves no file', async () => {
    const small = await startTestApp({ FILES_MAX_UPLOAD_BYTES: '10' });
    const s = await login(small);
    await small.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (small.app.server.address() as AddressInfo).port;
    const req = http.request({ port, host: '127.0.0.1', method: 'PUT', path: '/api/v1/sources/home/content?path=%2Fchunk.bin&onCollision=fail',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    req.on('error', () => undefined); // server may reset after 413
    const done = once(req, 'response');
    req.write(Buffer.alloc(8)); req.write(Buffer.alloc(8)); req.end();
    const [res] = (await done) as [http.IncomingMessage];
    res.resume();
    expect(res.statusCode).toBe(413);
    const root = homeRoot(small.config.dataDir, 'testuser');
    const files = existsSync(root) ? readdirSync(root, { recursive: true }).map(String) : [];
    expect(files.filter((f) => !f.startsWith('.'))).toEqual([]);
    await small.close();
  });
  it('creates folders', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: '/Neu/Ordner' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Ordner', type: 'directory' });
  });
  it('requires a session', async () => {
    expect((await t.app.inject('/api/v1/sources/home/list?path=%2F')).statusCode).toBe(401);
  });
  it('rejects unknown sources', async () => {
    expect((await get(a, '/api/v1/sources/conn:1/list?path=%2F')).statusCode).toBe(404);
  });
  it('does not leak a file descriptor when the client aborts a download', async () => {
    expect((await put(a, '/big.bin', Buffer.alloc(5 * 1024 * 1024, 1))).statusCode).toBe(201);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const fds = () => readdirSync('/proc/self/fd').length;
    const before = fds();
    for (let i = 0; i < 5; i++) {
      const req = http.get({ port, host: '127.0.0.1', path: '/api/v1/sources/home/content?path=%2Fbig.bin', headers: { cookie: a.cookie } });
      const [res] = (await once(req, 'response')) as [http.IncomingMessage];
      await once(res, 'data');
      req.destroy();
      res.on('error', () => undefined);
    }
    let after = fds();
    for (let i = 0; i < 40 && after > before; i++) { await new Promise((r) => setTimeout(r, 50)); after = fds(); }
    expect(after).toBeLessThanOrEqual(before);
  });
});
