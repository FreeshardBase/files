import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { MemBackend } from './support/memBackend.ts';

// #234: what the transfer panel needs from a job. A job of several picked items names them all (the label says "2 items",
// the details list the names), and one finished job can be dismissed on its own, so a successful job leaves the panel
// once seen while a failed one stays until the member dismisses it.

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; status: string; name: string; picked: number; names: string[] };
const ORIGIN = 'https://files.example.com';

const as = (t: TestApp, s: S, method: string, url: string, payload?: unknown) => t.app.inject({
  method: method as 'GET', url,
  headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});

describe('transfer jobs for the panel (#234)', () => {
  let t: TestApp; let a: S; let b: S;
  const src = new MemBackend();
  const dst = new MemBackend();
  const mine: ConnectedBackend[] = [{ id: 'src', backend: src }, { id: 'dst', backend: dst }];

  beforeAll(async () => {
    t = await startTestApp({}, undefined, undefined, { connections: async (u) => (u.id === a?.id ? mine : []) });
    const signIn = async (user: string): Promise<S> => {
      const s = await login(t, user);
      return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
    };
    a = await signIn('testuser');
    b = await signIn('member');
  });
  afterAll(async () => { await t.close(); });

  const start = async (paths: string[], dir = '/') => {
    const r = await as(t, a, 'POST', '/api/v1/transfers', { mode: 'copy', from: 'conn:src', to: 'conn:dst', dir,
      items: paths.map((path) => ({ path, onCollision: 'keep-both' })) });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Job;
  };
  const settled = async (id: string): Promise<Job> => {
    for (let i = 0; i < 500; i++) {
      const j = (await as(t, a, 'GET', `/api/v1/transfers/${id}`)).json() as Job;
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`job ${id} did not end`);
  };
  const listed = async () => ((await as(t, a, 'GET', '/api/v1/transfers')).json().items as Job[]).map((j) => j.id);

  it('a job of several picked items counts and names them, not their contents', async () => {
    src.put('/photo1.jpg', 'one').put('/photo2.jpg', 'two').put('/Album/inner.jpg', 'three');
    const job = await settled((await start(['/photo1.jpg', '/photo2.jpg', '/Album'])).id);
    expect(job).toMatchObject({ status: 'completed', picked: 3, names: ['photo1.jpg', 'photo2.jpg', 'Album'] });
    const one = await settled((await start(['/photo1.jpg'])).id);
    expect(one).toMatchObject({ picked: 1, names: ['photo1.jpg'], name: 'photo1.jpg' });
  });

  it('names at most 20 of the picked items; the count holds them all', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `/many-${String(i).padStart(2, '0')}.txt`);
    for (const p of paths) src.put(p, 'x');
    const job = await settled((await start(paths)).id);
    expect(job.picked).toBe(25);
    expect(job.names).toEqual(paths.slice(0, 20).map((p) => p.slice(1)));
  });

  it('dismisses one finished job and leaves the others; a running job and another member\'s job are refused', async () => {
    src.put('/keep.txt', 'k').put('/gone.txt', 'g');
    const keep = await settled((await start(['/keep.txt'])).id);
    const gone = await settled((await start(['/gone.txt'])).id);
    const r = await as(t, a, 'POST', `/api/v1/transfers/${gone.id}/dismiss`, {});
    expect(r.statusCode, r.body).toBe(204);
    expect(await listed()).toContain(keep.id);
    expect(await listed()).not.toContain(gone.id);
    expect((await as(t, a, 'GET', `/api/v1/transfers/${gone.id}`)).statusCode).toBe(404);
    // Dismissing it again is the same answer as any unknown job.
    expect((await as(t, a, 'POST', `/api/v1/transfers/${gone.id}/dismiss`, {})).json().code).toBe('NOT_FOUND');
    // Another member cannot touch it.
    expect((await as(t, b, 'POST', `/api/v1/transfers/${keep.id}/dismiss`, {})).json().code).toBe('NOT_FOUND');
    expect(await listed()).toContain(keep.id);

    src.put('/slow.txt', 'slow');
    src.stall('/slow.txt');
    const running = await start(['/slow.txt']);
    const refused = await as(t, a, 'POST', `/api/v1/transfers/${running.id}/dismiss`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('JOB_RUNNING');
    src.release('/slow.txt');
    expect((await settled(running.id)).status).toBe('completed');
  });
});
