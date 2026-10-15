import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// What the preview overlay (#142) relies on: the content route serves media inline only from the allowlist, always
// with `CSP: sandbox`, also for a Range request; active content (SVG, HTML, XML) is always an attachment.
let t: TestApp; let a: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
const CSP = "sandbox; default-src 'none'";
beforeAll(async () => { t = await startTestApp(); a = await login(t, 'testuser'); });
afterAll(() => t.close());

let counter = 0;
async function put(name: string, body: string): Promise<string> {
  const path = `/preview-${++counter}/${name}`;
  const r = await t.app.inject({
    method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload: body,
  });
  expect(r.statusCode).toBe(201);
  return path;
}
const content = (path: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie, ...headers } });

describe('content route for the preview', () => {
  it.each([
    ['x.svg', 'image/svg+xml'], ['X.SVG', 'image/svg+xml'], ['x.html', 'text/html'], ['x.htm', 'text/html'],
    ['Y.HTML', 'text/html'], ['x.xhtml', 'application/xhtml+xml'], ['x.xml', 'application/xml'],
  ])('%s is %s and always an attachment, also for a Range request', async (name, mime) => {
    const path = await put(name, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const headers of [{}, { range: 'bytes=0-9' }] as Record<string, string>[]) {
      const r = await content(path, headers);
      expect([200, 206]).toContain(r.statusCode);
      expect(r.headers['content-type']).toBe(mime);
      expect(String(r.headers['content-disposition'])).toMatch(/^attachment;/);
      expect(r.headers['content-security-policy']).toBe(CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it.each([
    ['a.png', 'image/png'], ['a.webp', 'image/webp'], ['a.avif', 'image/avif'], ['a.pdf', 'application/pdf'],
    ['a.txt', 'text/plain'], ['a.log', 'text/plain'], ['a.webm', 'video/webm'], ['a.ogv', 'video/ogg'],
    ['a.wav', 'audio/wav'], ['a.m4a', 'audio/mp4'], ['a.flac', 'audio/flac'], ['a.opus', 'audio/ogg'],
  ])('%s is served inline as %s with CSP sandbox, also for a Range request', async (name, mime) => {
    const path = await put(name, '0123456789abcdef');
    const full = await content(path);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe(mime);
    expect(String(full.headers['content-disposition'])).toMatch(/^inline;/);
    expect(full.headers['content-security-policy']).toBe(CSP);
    const part = await content(path, { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    expect(String(part.headers['content-disposition'])).toMatch(/^inline;/);
    expect(part.headers['content-security-policy']).toBe(CSP);
  });

  it.each([
    ['notes.md', 'text/markdown'], ['notes.markdown', 'text/markdown'], ['data.csv', 'text/csv'], ['data.json', 'application/json'],
  ])('%s is listed as %s (the SPA picks the preview from it) and served as an attachment', async (name, mime) => {
    const path = await put(name, '# Title');
    const dir = path.slice(0, path.lastIndexOf('/'));
    const list = (await t.app.inject({ url: `/api/v1/sources/home/list?path=${encodeURIComponent(dir)}`, headers: { cookie: a.cookie } })).json();
    expect(list.entries).toEqual([expect.objectContaining({ name, mime })]);
    const r = await content(path, { range: 'bytes=0-1' });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe('# ');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(r.headers['content-security-policy']).toBe(CSP);
  });

  it('download=1 forces an attachment for an inline type', async () => {
    const path = await put('b.png', 'x');
    const r = await t.app.inject({ url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&download=1`, headers: { cookie: a.cookie } });
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment;/);
  });
});
