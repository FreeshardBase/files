import { vi } from 'vitest';
import { installFakeXhr, type XhrRequest } from './fakeXhr.ts';

type Upload = { id: string; path: string; length: number; offset: number; policy: string };
type Answer = { status: number; text: string; headers?: Record<string, string> } | 'error' | 'abort';
export type FakeTusOptions = {
  /** A name that is taken on the server (creation with `fail` and the last PATCH answer FILE_EXISTS). */
  taken?: (path: string) => boolean;
  /** Overrides the answer to a creation (e.g. a quota error) or simulates a network failure. */
  onCreate?: (path: string) => Answer | undefined | Promise<Answer | undefined>;
  /** Overrides the answer to a PATCH; `keep` bytes of the chunk are stored first (a connection that dropped). */
  onPatch?: (u: Upload, req: XhrRequest) => { answer: Answer | Promise<Answer>; keep?: number } | undefined;
  /** Entries for every listing. */
  list?: () => unknown[];
};

/**
 * A tus server in memory behind `fetch` (creation, HEAD, DELETE, finish, listings) and XMLHttpRequest (PATCH), for
 * driving the upload client, store and views without a network.
 */
export function installFakeTus(opts: FakeTusOptions = {}) {
  const uploads = new Map<string, Upload>();
  const log = { created: [] as string[], placed: [] as string[], heads: [] as string[], deleted: [] as string[], patches: [] as string[], lists: 0 };
  let seq = 0;
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });
  const exists = (path: string) => opts.taken?.(path) ?? false;
  const place = (u: Upload, policy: string): { status: number; text: string; headers?: Record<string, string> } => {
    if (policy === 'fail' && exists(u.path)) {
      return { status: 409, text: JSON.stringify({ code: 'FILE_EXISTS', params: { name: u.path.split('/').pop() } }) };
    }
    uploads.delete(u.id);
    log.placed.push(`${u.path}:${policy}`);
    return { status: 204, text: '', headers: { 'upload-offset': String(u.offset) } };
  };
  const meta = (header: string) => Object.fromEntries(header.split(',').map((p) => {
    const [k, v = ''] = p.split(' ');
    return [k, new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))];
  }));

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, 'http://x');
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname.endsWith('/list')) { log.lists++; return json({ entries: opts.list?.() ?? [] }); }
    if (u.pathname === '/api/v1/uploads' && method === 'GET') { // the unfinished uploads (#233)
      return json({ items: [...uploads.values()].map((x) => ({ id: x.id, path: x.path, length: x.length, offset: x.offset,
        expiresAt: '2026-10-16T00:00:00.000Z' })) });
    }
    if (u.pathname === '/api/v1/uploads' && method === 'POST') {
      const m = meta(headers['upload-metadata']!);
      log.created.push(`${m.path}:${m.onCollision}`);
      const override = await opts.onCreate?.(m.path!);
      if (override === 'error' || override === 'abort') throw new TypeError('Failed to fetch');
      if (override) return new Response(override.text, { status: override.status });
      if (m.onCollision === 'fail' && exists(m.path!)) {
        return json({ code: 'FILE_EXISTS', params: { name: m.path!.split('/').pop() } }, 409);
      }
      const id = `u${++seq}`;
      uploads.set(id, { id, path: m.path!, length: Number(headers['upload-length']), offset: 0, policy: m.onCollision! });
      return new Response(null, { status: 201, headers: { location: `/api/v1/uploads/${id}` } });
    }
    const id = /^\/api\/v1\/uploads\/([^/]+)/.exec(u.pathname)?.[1];
    const up = id ? uploads.get(id) : undefined;
    if (method === 'HEAD') {
      log.heads.push(id!);
      return up ? new Response(null, { status: 200, headers: { 'upload-offset': String(up.offset), 'upload-length': String(up.length) } })
        : new Response(null, { status: 404 });
    }
    if (method === 'DELETE') {
      log.deleted.push(id!);
      if (!up) return json({ code: 'NOT_FOUND' }, 404);
      uploads.delete(id!);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && u.pathname.endsWith('/finish')) {
      if (!up) return json({ code: 'NOT_FOUND' }, 404);
      const policy = JSON.parse(String(init.body)).onCollision as string;
      const r = place(up, policy);
      if (r.status !== 204) return new Response(r.text, { status: r.status });
      return json({ name: up.path.split('/').pop(), path: up.path, type: 'file', size: up.length, modified: '2026-10-15T00:00:00.000Z' }, 201);
    }
    throw new Error(`fake tus: unexpected ${method} ${url}`);
  }));

  const xhr = installFakeXhr(async (url, body, req) => {
    const id = /^\/api\/v1\/uploads\/([^/]+)$/.exec(url)?.[1];
    const up = id ? uploads.get(id) : undefined;
    if (req.method !== 'PATCH' || !up) return { status: 404, text: '{"code":"NOT_FOUND"}' };
    const offset = Number(req.headers['upload-offset']);
    log.patches.push(`${up.path}@${offset}`);
    if (offset !== up.offset) return { status: 409, text: JSON.stringify({ code: 'OFFSET_MISMATCH', params: { offset: up.offset } }) };
    const size = (body as Blob).size;
    const custom = opts.onPatch?.(up, req);
    if (custom) {
      up.offset += Math.min(custom.keep ?? 0, size);
      return custom.answer;
    }
    up.offset += size;
    if (up.offset < up.length) return { status: 204, text: '', headers: { 'upload-offset': String(up.offset) } };
    return place(up, up.policy);
  });
  return { uploads, log, xhr };
}
