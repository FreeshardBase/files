import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyLink, OutgoingShare } from '@files/shared';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #299: "My shares" lists the caller's own public links and the internal shares they granted, across every source (home
// and each connection), with the item each one belongs to. Another member's links and shares never appear.

type S = { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let fake: FakeProvider; let owner: S; let member: S; let drive = '';
let ownerId = ''; let memberId = '';

const as = (s: S, method: string, url: string, payload?: unknown) => t.app.inject({ method, url,
  headers: method === 'GET' ? { cookie: s.cookie } : { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN },
  ...(payload !== undefined ? { payload: payload as object } : {}) });
async function ok(s: S, method: string, url: string, payload?: unknown) {
  const r = await as(s, method, url, payload);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
  return r;
}
async function put(s: S, source: string, path: string) {
  const r = await t.app.inject({ method: 'PUT',
    url: `/api/v1/sources/${encodeURIComponent(source)}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x') });
  expect(r.statusCode, r.body).toBe(201);
}
const link = async (s: S, source: string, path: string, extra: Record<string, unknown> = {}) =>
  (await ok(s, 'POST', '/api/v1/links', { source, path, ...extra })).json().id as string;
const share = async (s: S, source: string, path: string, grantee: string, access: 'read' | 'edit') =>
  (await ok(s, 'POST', '/api/v1/shares', { source, path, grantee, access })).json().id as string;
const mine = async (s: S) => (await ok(s, 'GET', '/api/v1/links/mine')).json().items as MyLink[];
const outgoing = async (s: S) => (await ok(s, 'GET', '/api/v1/shares/outgoing')).json().items as OutgoingShare[];

beforeAll(async () => {
  fake = await startFakeProvider();
  t = await startTestApp({}, undefined, undefined, { providers: [fake.driveProvider()] });
  owner = await login(t, 'testuser'); member = await login(t, 'member');
  ownerId = (await ok(owner, 'GET', '/api/v1/me')).json().id as string;
  memberId = (await ok(member, 'GET', '/api/v1/me')).json().id as string;
  const r = await ok(owner, 'POST', '/api/v1/connections/authorize', { provider: 'google-drive' });
  const back = await fake.consent(r.json().url as string);
  const cb = await as(owner, 'GET', back.pathname + back.search);
  drive = decodeURIComponent(String(cb.headers.location).slice(1));
  expect(drive).toMatch(/^conn:[0-9a-f]{32}$/);
});
afterAll(async () => { await t.close(); await fake.close(); });

describe('GET /api/v1/links/mine (#299)', () => {
  it('lists the caller\'s links across home and connections with their item, never another member\'s', async () => {
    await put(owner, 'home', '/mine-links/report.txt');
    await ok(owner, 'POST', '/api/v1/sources/home/mkdir', { path: '/mine-links/Photos' });
    await put(owner, drive, '/Drive folder/plan.txt');
    await put(member, 'home', '/member-links/theirs.txt');
    const homeFile = await link(owner, 'home', '/mine-links/report.txt', { label: 'For Test User', password: 'secret1', maxDownloads: 3 });
    const homeDir = await link(owner, 'home', '/mine-links/Photos');
    const driveFile = await link(owner, drive, '/Drive folder/plan.txt');
    const theirs = await link(member, 'home', '/member-links/theirs.txt');

    const items = await mine(owner);
    expect(items.map((l) => l.id).sort()).toEqual([homeFile, homeDir, driveFile].sort());
    expect(items.find((l) => l.id === homeFile)).toMatchObject({ source: 'home', path: '/mine-links/report.txt', type: 'file',
      label: 'For Test User', hasPassword: true, maxDownloads: 3, downloads: 0, orphaned: false });
    expect(items.find((l) => l.id === homeDir)).toMatchObject({ source: 'home', path: '/mine-links/Photos', type: 'directory',
      hasPassword: false });
    expect(items.find((l) => l.id === driveFile)).toMatchObject({ source: drive, path: '/Drive folder/plan.txt', type: 'file' });

    expect((await mine(member)).map((l) => l.id)).toEqual([theirs]);
  });

  it('shows a revoked link no more and keeps an orphaned one, marked, for the owner to revoke', async () => {
    await put(owner, 'home', '/mine-gone/old.txt');
    const kept = await link(owner, 'home', '/mine-gone/old.txt');
    const revoked = await link(owner, 'home', '/mine-gone/old.txt');
    await ok(owner, 'DELETE', `/api/v1/links/${revoked}`);
    await ok(owner, 'POST', '/api/v1/sources/home/delete', { paths: ['/mine-gone/old.txt'] });
    const items = await mine(owner);
    expect(items.map((l) => l.id)).not.toContain(revoked);
    expect(items.find((l) => l.id === kept)).toMatchObject({ orphaned: true });
  });
});

describe('GET /api/v1/shares/outgoing (#299)', () => {
  it('lists the shares the caller granted across sources with item, grantee and access, never another member\'s', async () => {
    await put(owner, 'home', '/out/notes.txt');
    await put(owner, drive, '/Drive out/budget.txt');
    await put(member, 'home', '/member-out/back.txt');
    const homeShare = await share(owner, 'home', '/out/notes.txt', memberId, 'edit');
    const driveShare = await share(owner, drive, '/Drive out/budget.txt', memberId, 'read');
    const theirs = await share(member, 'home', '/member-out/back.txt', ownerId, 'read');

    const items = await outgoing(owner);
    expect(items.map((s) => s.id).sort()).toEqual([homeShare, driveShare].sort());
    expect(items.find((s) => s.id === homeShare)).toMatchObject({ source: 'home', path: '/out/notes.txt', type: 'file',
      access: 'edit', grantee: { id: memberId, displayName: 'Test Member' }, orphaned: false });
    expect(items.find((s) => s.id === driveShare)).toMatchObject({ source: drive, path: '/Drive out/budget.txt', access: 'read' });

    const theirList = await outgoing(member);
    expect(theirList.map((s) => s.id)).toEqual([theirs]);
    expect(theirList[0]).toMatchObject({ grantee: { id: ownerId } });

    // What was shared with the caller is "Shared with me", not here; a removed share is gone from the list.
    await ok(owner, 'DELETE', `/api/v1/shares/${driveShare}`);
    expect((await outgoing(owner)).map((s) => s.id)).toEqual([homeShare]);
  });
});
