import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { basic, createAppPassword, multistatus } from './support/dav.ts';

// #321: what the phone apps of the setup page (Documents by Readdle, FE File Explorer, Solid Explorer, Material Files)
// send, replayed over a real socket: the user name is the login the page shows, the password an app password. The same
// sequence without a password, or with a wrong one, gets nothing but 401.
let t: TestApp; let port: number; let pw: string; let loginName: string;

beforeAll(async () => {
  t = await startTestApp();
  const s = await login(t, 'testuser');
  pw = await createAppPassword(t, s, 'Test phone');
  loginName = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().login as string;
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterAll(async () => { t.app.server.closeAllConnections(); await t.close(); });

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
/**
 * One request as the clients send it: `chunks` go out with chunked transfer encoding and `Expect: 100-continue`, the
 * way the iOS and Android HTTP stacks stream a large upload; a string body goes with its Content-Length.
 */
function send(method: string, path: string, headers: Record<string, string>, payload?: string | Buffer[]): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const chunked = Array.isArray(payload);
    const r = request({ host: '127.0.0.1', port, method, path, headers: {
      ...headers, ...(chunked ? { 'transfer-encoding': 'chunked', expect: '100-continue' } : {}),
    } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) }));
    });
    r.on('error', reject);
    if (!chunked) { r.end(payload); return; }
    // The body waits for the server's 100 Continue, as a client with `Expect` does.
    r.on('continue', () => { for (const c of payload) r.write(c); r.end(); });
  });
}

const ALLPROP = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';
const LOCKINFO = '<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>'
  + '<D:locktype><D:write/></D:locktype><D:owner><D:href>Test User</D:href></D:owner></D:lockinfo>';
const xml = { 'content-type': 'text/xml; charset="utf-8"' };
const CLIENTS = [
  { name: 'Documents by Readdle', ua: 'Documents/8.9 CFNetwork/1498.700.2 Darwin/23.6.0', dir: 'readdle' },
  { name: 'FE File Explorer', ua: 'FE File Explorer/5.6 CFNetwork/1498.700.2 Darwin/23.6.0', dir: 'fe' },
  { name: 'Solid Explorer', ua: 'Solid Explorer/2.8 (Android 14)', dir: 'solid' },
  { name: 'Material Files', ua: 'okhttp/4.12.0 Material Files/1.7', dir: 'material' },
];

/** The client's session from connecting to moving its upload into place; `auth` is what it sends as Authorization. */
async function session(c: typeof CLIENTS[number], auth: Record<string, string>) {
  const h = { 'user-agent': c.ua, ...auth };
  const big = Array.from({ length: 48 }, () => randomBytes(64 * 1024)); // 3 MiB in 64 KiB chunks
  const dir = `/dav/${c.dir}`;
  const steps: [string, () => Promise<Answer>][] = [
    ['OPTIONS', () => send('OPTIONS', '/dav/', h)],
    ['PROPFIND allprop', () => send('PROPFIND', '/dav/', { ...h, ...xml, depth: '1' }, ALLPROP)],
    ['PROPFIND infinity', () => send('PROPFIND', '/dav/', { ...h, ...xml, depth: 'infinity' }, ALLPROP)],
    ['MKCOL', () => send('MKCOL', `${dir}/`, h)],
    ['PUT chunked', () => send('PUT', `${dir}/Video%202026.mov`, { ...h, 'content-type': 'video/quicktime' }, big)],
    ['PUT target', () => send('PUT', `${dir}/Final.mov`, { ...h, 'content-type': 'video/quicktime' }, 'the old one')],
    ['LOCK', () => send('LOCK', `${dir}/Video%202026.mov`, { ...h, ...xml, depth: '0', timeout: 'Infinite, Second-4100000000' }, LOCKINFO)],
  ];
  const out: Record<string, Answer> = {};
  for (const [name, step] of steps) out[name] = await step();
  const token = /^<(.+)>$/.exec(String(out.LOCK!.headers['lock-token'] ?? ''))?.[1];
  out.UNLOCK = await send('UNLOCK', `${dir}/Video%202026.mov`, { ...h, 'lock-token': `<${token ?? 'opaquelocktoken:none'}>` });
  const destination = `https://files.example.com${dir}/Final.mov`;
  out['MOVE Overwrite F'] = await send('MOVE', `${dir}/Video%202026.mov`, { ...h, destination, overwrite: 'F' });
  out['MOVE Overwrite T'] = await send('MOVE', `${dir}/Video%202026.mov`, { ...h, destination, overwrite: 'T' });
  out.GET = await send('GET', `${dir}/Final.mov`, h);
  return { out, sha: createHash('sha256').update(Buffer.concat(big)).digest('hex') };
}

describe('the phone apps of the setup page (#321)', () => {
  it('the login the page shows is the member\'s login name', () => {
    expect(loginName).toBe('testuser');
  });

  it.each(CLIENTS)('$name: the whole sequence works with the login and an app password', async (c) => {
    const { out, sha } = await session(c, { authorization: basic(pw, loginName) });
    expect(out.OPTIONS!.status).toBe(200);
    expect(String(out.OPTIONS!.headers.dav).split(',').map((s) => s.trim())).toEqual(expect.arrayContaining(['1', '2']));
    expect(out['PROPFIND allprop']!.status).toBe(207);
    const listed = multistatus(out['PROPFIND allprop']!.body.toString('utf8'));
    expect(listed[0]!.href).toBe('/dav/');
    expect(listed[0]!.props.has('{DAV:}resourcetype')).toBe(true);
    // Refused politely: 403 with the precondition element, so the client falls back to Depth: 1.
    expect(out['PROPFIND infinity']!.status).toBe(403);
    expect(out['PROPFIND infinity']!.body.toString('utf8')).toMatch(/<D:error xmlns:D="DAV:"><D:propfind-finite-depth\/><\/D:error>/);
    expect(out.MKCOL!.status).toBe(201);
    expect(out['PUT chunked']!.status).toBe(201);
    expect(out['PUT target']!.status).toBe(201);
    expect(out.LOCK!.status).toBe(200);
    expect(out.UNLOCK!.status).toBe(204);
    expect(out['MOVE Overwrite F']!.status).toBe(412);
    expect(out['MOVE Overwrite T']!.status).toBe(204);
    expect(out.GET!.status).toBe(200);
    expect(createHash('sha256').update(out.GET!.body).digest('hex')).toBe(sha);
  }, 30_000);

  it.each(CLIENTS)('$name: without a password, or with a wrong one, every step is 401', async (c) => {
    for (const auth of [{} as Record<string, string>, { authorization: basic(`${pw.slice(0, -1)}${pw.endsWith('a') ? 'b' : 'a'}`, loginName) }]) {
      const { out } = await session(c, auth);
      expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.status])))
        .toEqual(Object.fromEntries(Object.keys(out).map((k) => [k, 401])));
      expect(String(out.OPTIONS!.headers['www-authenticate'])).toMatch(/^Basic realm="/);
    }
  }, 30_000);
});
