import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection, TransferJob } from '@files/shared';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #342: OneDrive's name rules are checked before anything reaches Graph. A transfer with the member's chosen name lands
// under it; an unattended one lands under the suggestion and lists the rename in the job and its report; a name the fake
// Graph refuses although the rules let it pass is NAME_NOT_ALLOWED with Graph's reason, never a generic failure.

type S = { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let fake: FakeProvider; let a: S; let conn: string;

const as = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method, url, headers: { cookie: a.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': a.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const put = (source: string, path: string, body: string) => as('PUT', `/api/v1/sources/${source}/content?${q(path)}&onCollision=fail`,
  Buffer.from(body), { 'content-type': 'application/octet-stream' });
async function names(source: string, path: string): Promise<string[]> {
  const r = await as('GET', `/api/v1/sources/${source}/list?${q(path)}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().entries as { name: string }[]).map((e) => e.name).sort();
}
async function finished(id: string): Promise<TransferJob> {
  const end = Date.now() + 20_000;
  for (;;) {
    const job = (await as('GET', `/api/v1/transfers/${id}`)).json() as TransferJob;
    if (job.status !== 'running') return job;
    if (Date.now() > end) throw new Error(`job still running: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function transfer(items: { path: string; onCollision: string; name?: string }[], dir = '/') {
  return as('POST', '/api/v1/transfers', { mode: 'copy', from: 'home', to: conn, dir, items });
}

beforeAll(async () => {
  fake = await startFakeProvider({});
  t = await startTestApp({}, undefined, undefined, { providers: fake.graphProviders() });
  a = await login(t, 'testuser');
  for (const [p, body] of [['/a:b.txt', 'ab'], ['/Q3/Bericht: Q3.pdf', 'pdf'], ['/Q3/CON.txt', 'con'], ['/Q3/fine.txt', 'fine']]) {
    expect((await put('home', p!, body!)).statusCode).toBe(201);
  }
  const r = await as('POST', '/api/v1/connections/authorize', { provider: 'onedrive' });
  const back = await fake.consent(r.json().url as string);
  await as('GET', back.pathname + back.search);
  conn = `conn:${((await as('GET', '/api/v1/connections')).json().items as Connection[])[0]!.id}`;
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(() => { fake.graph.refusedRequests.length = 0; fake.graph.refusedNames.clear(); });

describe('OneDrive name rules', () => {
  it('tells the SPA each source\'s rules with its listing', async () => {
    expect((await as('GET', `/api/v1/sources/${conn}/list?${q('/')}`)).json().nameRules).toBe('onedrive');
    expect((await as('GET', `/api/v1/sources/home/list?${q('/')}`)).json().nameRules).toBe('universal');
  });

  it('lands a transfer of a:b.txt with the member\'s rename choice as a_b.txt', async () => {
    const r = await transfer([{ path: '/a:b.txt', onCollision: 'fail', name: 'a_b.txt' }]);
    expect(r.statusCode, r.body).toBe(201);
    const job = await finished(r.json().id as string);
    expect(job.status).toBe('completed');
    expect(job.renamed).toEqual([]);
    expect(await names(conn, '/')).toContain('a_b.txt');
    expect(fake.graph.refusedRequests).toEqual([]);
  });

  it('refuses a chosen name the target does not allow, before the job starts', async () => {
    const r = await transfer([{ path: '/a:b.txt', onCollision: 'fail', name: 'x:y.txt' }]);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toEqual({ code: 'NAME_NOT_ALLOWED', params: { name: 'x:y.txt', rules: 'onedrive', issue: 'char', char: ':' } });
  });

  it('an unattended job applies the suggestion itself and lists every rename in the job and its report', async () => {
    const r = await transfer([{ path: '/Q3', onCollision: 'keep-both' }, { path: '/a:b.txt', onCollision: 'replace' }], '/');
    expect(r.statusCode, r.body).toBe(201);
    const job = await finished(r.json().id as string);
    expect(job.status, JSON.stringify(job.failed)).toBe('completed');
    expect(await names(conn, '/Q3')).toEqual(['Bericht_ Q3.pdf', 'CON_.txt', 'fine.txt']);
    expect(job.renamed).toEqual([
      { path: '/a:b.txt', name: 'a_b.txt', issues: [{ code: 'char', char: ':' }] },
      { path: '/Q3/Bericht: Q3.pdf', name: 'Bericht_ Q3.pdf', issues: [{ code: 'char', char: ':' }] },
      { path: '/Q3/CON.txt', name: 'CON_.txt', issues: [{ code: 'reserved' }] },
    ]);
    const report = (await as('GET', `/api/v1/transfers/${job.id}/report`)).body;
    expect(report.split('\r\n')[0]).toContain('"renamed"');
    expect(report).toContain('"/Q3/Bericht: Q3.pdf","/Q3/Bericht_ Q3.pdf"');
    expect(report).toContain('"char "":"""');
    expect(report).toContain('"reserved"');
    expect(fake.graph.refusedRequests).toEqual([]);
  });

  it('refuses an upload, a new folder and a rename to a forbidden name before Graph sees it', async () => {
    const up = await put(conn, '/x:y.txt', 'x');
    expect(up.statusCode, up.body).toBe(422);
    expect(up.json()).toEqual({ code: 'NAME_NOT_ALLOWED', params: { name: 'x:y.txt', rules: 'onedrive', issue: 'char', char: ':' } });
    const dir = await as('POST', `/api/v1/sources/${conn}/mkdir`, { path: '/LPT1' });
    expect(dir.statusCode, dir.body).toBe(422);
    expect(dir.json().params).toMatchObject({ name: 'LPT1', issue: 'reserved' });
    expect((await put(conn, '/plain.txt', 'p')).statusCode).toBe(201);
    const mv = await as('POST', `/api/v1/sources/${conn}/move`, { from: '/plain.txt', to: '/x:y', onCollision: 'fail' });
    expect(mv.statusCode, mv.body).toBe(422);
    expect(mv.json().code).toBe('NAME_NOT_ALLOWED');
    expect(fake.graph.refusedRequests).toEqual([]);
  });

  it('maps Graph refusing a name the rules missed to NAME_NOT_ALLOWED with Graph\'s reason', async () => {
    fake.graph.refusedNames.add('odd.txt');
    const r = await put(conn, '/odd.txt', 'odd');
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toEqual({ code: 'NAME_NOT_ALLOWED', params: { name: 'odd.txt', reason: 'The name is not allowed.' } });
    expect(fake.graph.refusedRequests).toEqual(['odd.txt']);
  });
});
