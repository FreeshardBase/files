import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #158: the Web Share Target. The service worker takes the phone's share and keeps the files in the browser until the
// member picks a folder; this route is reached only when no service worker took it. It never reads the shared files.
let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

const MARKER = 'shared-photo-bytes-7f3a91c2e8';
const BOUNDARY = '----files-share-target';
const share = (headers: Record<string, string> = {}) => t.app.inject({
  method: 'POST', url: '/api/v1/share-target',
  // As the share sheet sends it: a navigation from the installed app, without a CSRF token.
  headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
  payload: [`--${BOUNDARY}`, 'Content-Disposition: form-data; name="files"; filename="photo.jpg"', 'Content-Type: image/jpeg', '',
    MARKER, `--${BOUNDARY}--`, ''].join('\r\n'),
});

// Every file under the data dir whose bytes contain the shared content.
const holding = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return holding(p);
  return e.isFile() && readFileSync(p).includes(MARKER) ? [p] : [];
});

describe('POST /api/v1/share-target', () => {
  it('without a session redirects to login, back to the share page, and keeps no file data', async () => {
    const r = await share();
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/auth/login?returnTo=%2Fshare-target');
    expect(holding(t.dataDir)).toEqual([]);
  });

  it('with a session but no CSRF token goes to the share page and still stores nothing', async () => {
    const s = await login(t);
    const r = await share({ cookie: s.cookie, origin: 'https://evil.example.com' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/share-target');
    const list = await t.app.inject({ url: '/api/v1/sources/home/list?path=%2F', headers: { cookie: s.cookie } });
    expect(list.json().entries).toEqual([]);
    expect(holding(t.dataDir)).toEqual([]);
  });
});
