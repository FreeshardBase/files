import { once } from 'node:events';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { LocalBackend } from '../src/storage/local.ts';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp; let a: { cookie: string; csrf: string }; let m: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
beforeAll(async () => { t = await startTestApp(); a = await login(t, 'testuser'); m = await login(t, 'member'); });
afterAll(() => t.close());

const put = (s: typeof a, path: string, payload: string | Buffer, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload,
});
const rootOf = async (tt: TestApp, s: { cookie: string }) =>
  homeRoot(tt.config.dataDir, (await tt.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id);
const get = (s: typeof a, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url, headers: { cookie: s.cookie, ...headers } });
// Every test sets up its own files under a unique name, so no test depends on another one running first.
let counter = 0;
const uniq = (stem: string, ext = '.txt') => `/${stem}-${++counter}${ext}`;
const q = (path: string) => encodeURIComponent(path);

describe('sources/home', () => {
  it('upload, list and download round-trip a file with an awkward name', async () => {
    const name = '/Prüfung #1 50%.txt';
    const up = await put(a, name, 'hallo');
    expect(up.statusCode).toBe(201);
    const list = (await get(a, '/api/v1/sources/home/list?path=%2F')).json();
    expect(list.entries.map((e: { name: string }) => e.name)).toContain('Prüfung #1 50%.txt');
    const dl = await get(a, `/api/v1/sources/home/content?path=${encodeURIComponent(name)}&download=1`);
    expect(dl.body).toBe('hallo');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Pr_fung #1 50%.txt"; filename*=UTF-8''${encodeURIComponent('Prüfung #1 50%.txt')}`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });
  it('answers a Range request with 206', async () => {
    const f = uniq('digits');
    await put(a, f, '0123456789');
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=2-4' });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe('234');
    expect(r.headers['content-range']).toBe('bytes 2-4/10');
    expect(r.headers['content-length']).toBe('3');
  });
  it('answers an unsatisfiable Range with 416 and content-range', async () => {
    const f = uniq('digits');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=10-' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
    expect(r.json()).toEqual({ code: 'RANGE_NOT_SATISFIABLE' });
  });
  it('ignores an invalid Range (first > last) and answers 200 with the whole file', async () => {
    const f = uniq('digits');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=5-2' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('0123456789');
    expect(r.headers['content-range']).toBeUndefined();
  });
  it('still answers a valid but unsatisfiable Range with 416', async () => {
    const f = uniq('digits');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=999999-' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
  });
  it('answers HEAD with headers and no body', async () => {
    const f = uniq('digits');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const r = await t.app.inject({ method: 'HEAD', url: `/api/v1/sources/home/content?path=${q(f)}`, headers: { cookie: a.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('10');
    expect(r.body).toBe('');
  });
  it('serves active content types as attachment even without download=1', async () => {
    const f = uniq('evil', '.html');
    expect((await put(a, f, '<script>alert(1)</script>')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`);
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
  });
  it('serves plain text inline', async () => {
    const f = uniq('plain');
    expect((await put(a, f, 'text')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(f)}`);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-disposition'])).toMatch(/^inline/);
  });
  it('rejects content on a directory', async () => {
    const d = uniq('adir', '');
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: d } })).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${q(d)}`);
    expect(r.json()).toEqual({ code: 'IS_A_DIRECTORY' });
  });
  it('isolates members: a member cannot see the admin home, and writes land in the member home', async () => {
    const adminFile = uniq('admin-only');
    expect((await put(a, adminFile, 'secret')).statusCode).toBe(201);
    expect((await get(a, `/api/v1/sources/home/content?path=${q(adminFile)}`)).body).toBe('secret');
    expect((await get(m, `/api/v1/sources/home/content?path=${q(adminFile)}`)).statusCode).toBe(404);
    const names = (await get(m, '/api/v1/sources/home/list?path=%2F')).json().entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain(adminFile.slice(1));

    const memberFile = uniq('member-own');
    expect((await put(m, memberFile, 'mine')).statusCode).toBe(201);
    const memberRoot = await rootOf(t, m); const adminRoot = await rootOf(t, a);
    expect(memberRoot).not.toBe(adminRoot);
    expect(existsSync(join(memberRoot, memberFile.slice(1)))).toBe(true);
    expect(existsSync(join(adminRoot, memberFile.slice(1)))).toBe(false);
    expect(existsSync(join(adminRoot, adminFile.slice(1)))).toBe(true);
    expect(existsSync(join(memberRoot, adminFile.slice(1)))).toBe(false);
  });
  it('rejects traversal in every parameter', async () => {
    expect((await get(a, '/api/v1/sources/home/list?path=%2F..%2F..')).json()).toEqual({ code: 'PATH_INVALID' });
    expect((await put(a, '/../escape.txt', 'x')).json()).toEqual({ code: 'PATH_INVALID' });
  });
  it('pages the listing with limit and cursor and rejects a bad limit', async () => {
    const dir = uniq('page', '');
    for (const n of ['p1', 'p2', 'p3']) expect((await put(a, `${dir}/${n}.txt`, n)).statusCode).toBe(201);
    const first = (await get(a, `/api/v1/sources/home/list?path=${q(dir)}&limit=2`)).json();
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = (await get(a, `/api/v1/sources/home/list?path=${q(dir)}&limit=2&cursor=${encodeURIComponent(first.next)}`)).json();
    expect(second.entries.map((e: { name: string }) => e.name)).toEqual(['p3.txt']);
    expect((await get(a, `/api/v1/sources/home/list?path=${q(dir)}&limit=0`)).statusCode).toBe(400);
    expect((await get(a, `/api/v1/sources/home/list?path=${q(dir)}&limit=abc`)).statusCode).toBe(400);
  });
  it('stats an entry', async () => {
    const f = uniq('digits');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/stat?path=${q(f)}`);
    expect(r.json()).toMatchObject({ name: f.slice(1), type: 'file', size: 10 });
  });
  it('returns FILE_EXISTS on collision with fail and keeps both with keep-both', async () => {
    const f = uniq('dup');
    expect((await put(a, f, 'one')).statusCode).toBe(201);
    expect((await put(a, f, 'two')).statusCode).toBe(409);
    expect((await put(a, f, 'two', 'keep-both')).json().name).toBe(`${f.slice(1, -4)} (2).txt`);
  });
  it('rejects an upload without the octet-stream content type', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fct.txt&onCollision=fail',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'text/plain' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
  it('compares the exact base media type, not a prefix', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fct2.txt&onCollision=fail',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'application/octet-streamx' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
  it('accepts the octet-stream type with parameters and any case', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fct3.txt&onCollision=fail',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'Application/Octet-Stream; charset=binary' }, payload: 'x' });
    expect(r.statusCode).toBe(201);
  });
  it('closes the connection on an early 415 rejection', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fct4.txt&onCollision=fail',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'text/plain' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
    expect(r.headers.connection).toBe('close');
  });
  it('closes the connection on an early 413 rejection', async () => {
    const small = await startTestApp({ FILES_MAX_UPLOAD_BYTES: '10' });
    const s = await login(small);
    const r = await small.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fbig2.bin&onCollision=fail',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(11) });
    expect(r.statusCode).toBe(413);
    expect(r.headers.connection).toBe('close');
    await small.close();
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
    const root = await rootOf(small, s);
    expect(existsSync(root)).toBe(true); // the user's home exists, so the emptiness check below is not vacuous
    const files = readdirSync(root, { recursive: true }).map(String);
    expect(files.filter((f) => !f.startsWith('.'))).toEqual([]);
    await small.close();
  });
  it('creates folders', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: `${uniq('Neu', '')}/Ordner` } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Ordner', type: 'directory' });
  });
  it('requires a session', async () => {
    expect((await t.app.inject('/api/v1/sources/home/list?path=%2F')).statusCode).toBe(401);
  });
  it('rejects unknown sources', async () => {
    const r = await get(a, '/api/v1/sources/conn:1/list?path=%2F');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ code: 'SOURCE_NOT_FOUND' });
  });
  it('does not leak a file descriptor when the client aborts a download', async () => {
    const f = uniq('big', '.bin');
    expect((await put(a, f, Buffer.alloc(5 * 1024 * 1024, 1))).statusCode).toBe(201);
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    const fds = () => readdirSync('/proc/self/fd').length;
    const before = fds();
    for (let i = 0; i < 5; i++) {
      const req = http.get({ port, host: '127.0.0.1', path: `/api/v1/sources/home/content?path=${q(f)}`, headers: { cookie: a.cookie } });
      const [res] = (await once(req, 'response')) as [http.IncomingMessage];
      await once(res, 'data');
      req.destroy();
      res.on('error', () => undefined);
    }
    let after = fds();
    for (let i = 0; i < 40 && after > before; i++) { await new Promise((r) => setTimeout(r, 50)); after = fds(); }
    expect(after).toBeLessThanOrEqual(before);
  });

  it('encodes RFC 5987 specials and adds an ASCII fallback filename', async () => {
    const name = `a'b"cX(*)!.txt`;
    expect((await put(a, `/${name}`, 'hi')).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${encodeURIComponent(`/${name}`)}`);
    expect(r.headers['content-disposition']).toBe(
      `inline; filename="a'b_cX(*)!.txt"; filename*=UTF-8''a%27b%22cX%28%2A%29%21.txt`);
  });
  it.each([
    ['/x.svg', '<svg/>', 'attachment'], ['/x.html', '<p/>', 'attachment'], ['/x.json', '{}', 'attachment'],
    ['/x.unknownext', 'q', 'attachment'], ['/x.png', 'q', 'inline'], ['/x.pdf', 'q', 'inline'],
    ['/x.txt', 'q', 'inline'], ['/x.mp4', 'q', 'inline'], ['/x.mp3', 'q', 'inline'],
  ])('disposition for %s', async (ext, body, expected) => {
    const path = uniq('x', ext.slice(2));
    expect((await put(a, path, body)).statusCode).toBe(201);
    const r = await get(a, `/api/v1/sources/home/content?path=${encodeURIComponent(path)}`);
    expect(String(r.headers['content-disposition'])).toMatch(new RegExp(`^${expected};`));
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
  });
  it('answers 415 before an incompatible body is read (real socket, body still streaming)', async () => {
    const s = await startTestApp();
    const c = await login(s);
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (s.app.server.address() as AddressInfo).port;
    const req = http.request({ port, host: '127.0.0.1', method: 'PUT', path: '/api/v1/sources/home/content?path=%2Fx.txt&onCollision=fail',
      headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: ORIGIN, 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } });
    req.on('error', () => undefined);
    const gotResponse = once(req, 'response');
    let written = 0;
    const pump = setInterval(() => { if (written < 2 * 1024 * 1024) { req.write(Buffer.alloc(64 * 1024)); written += 64 * 1024; } }, 5);
    const [res] = (await Promise.race([gotResponse, new Promise((_, rej) => setTimeout(() => rej(new Error('no early 415')), 3000))])) as [http.IncomingMessage];
    clearInterval(pump);
    res.resume();
    expect(res.statusCode).toBe(415);
    expect(written).toBeLessThan(2 * 1024 * 1024); // client still had data to send: server did not wait for the whole body
    req.destroy();
    await s.close();
  });
  it('answers 413 for a declared oversized Content-Length without receiving the body', async () => {
    const small = await startTestApp({ FILES_MAX_UPLOAD_BYTES: '10' });
    const c = await login(small);
    await small.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (small.app.server.address() as AddressInfo).port;
    const req = http.request({ port, host: '127.0.0.1', method: 'PUT', path: '/api/v1/sources/home/content?path=%2Fd.bin&onCollision=fail',
      headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': '11' } });
    req.on('error', () => undefined);
    req.flushHeaders(); // headers only; the 11 body bytes are never sent
    const [res] = (await Promise.race([once(req, 'response'), new Promise((_, rej) => setTimeout(() => rej(new Error('no 413 without body')), 3000))])) as [http.IncomingMessage];
    res.resume();
    expect(res.statusCode).toBe(413);
    req.destroy();
    await small.close();
  });
  // One read means the Range is resolved against the size of the opened file, so there is no stat/read race left.
  it('GET content does one backend read and no stat, with and without a Range', async () => {
    const f = uniq('one-trip');
    expect((await put(a, f, '0123456789')).statusCode).toBe(201);
    const read = vi.spyOn(LocalBackend.prototype, 'read');
    const stat = vi.spyOn(LocalBackend.prototype, 'stat');
    try {
      const whole = await get(a, `/api/v1/sources/home/content?path=${q(f)}`);
      expect(whole.statusCode).toBe(200);
      expect(whole.body).toBe('0123456789');
      expect(whole.headers['content-disposition']).toMatch(/filename="one-trip-\d+\.txt"/);
      const part = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=7-' });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe('789');
      expect(part.headers['content-range']).toBe('bytes 7-9/10');
      const bad = await get(a, `/api/v1/sources/home/content?path=${q(f)}`, { range: 'bytes=50-' });
      expect(bad.statusCode).toBe(416);
      expect(bad.headers['content-range']).toBe('bytes */10');
      expect(read).toHaveBeenCalledTimes(3);
      expect(stat).not.toHaveBeenCalled();
    } finally { read.mockRestore(); stat.mockRestore(); }
  });
  it('PUT with a stale If-Match answers 412 PRECONDITION_FAILED and keeps the file', async () => {
    const f = uniq('if-match');
    const putIfMatch = (etag: string, payload: string) => t.app.inject({
      method: 'PUT', url: `/api/v1/sources/home/content?path=${q(f)}&onCollision=replace`,
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream', 'if-match': etag },
      payload,
    });
    const etagOf = async () => String((await get(a, `/api/v1/sources/home/content?path=${q(f)}`)).headers.etag);
    expect((await put(a, f, 'one')).statusCode).toBe(201);
    const stale = await etagOf();
    expect((await put(a, f, 'two', 'replace')).statusCode).toBe(201);
    const r = await putIfMatch(stale, 'lost update');
    expect(r.statusCode).toBe(412);
    expect(r.json()).toEqual({ code: 'PRECONDITION_FAILED' });
    expect((await get(a, `/api/v1/sources/home/content?path=${q(f)}`)).body).toBe('two');
    expect((await putIfMatch(await etagOf(), 'three')).statusCode).toBe(201);
    expect((await get(a, `/api/v1/sources/home/content?path=${q(f)}`)).body).toBe('three');
  });
});
