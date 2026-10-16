import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { basic, createAppPassword, multistatus, propText } from './support/dav.ts';

// WebDAV class 1 and 2 on the member's home (#157), authenticated with app passwords only.
type Session = { cookie: string; csrf: string };
let t: TestApp; let a: Session; let m: Session; let pw: string; let memberPw: string; let root: string; let memberRoot: string;
let outside: string;
const ORIGIN = 'https://files.example.com';

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  m = await login(t, 'member');
  pw = await createAppPassword(t, a);
  memberPw = await createAppPassword(t, m);
  const id = (s: Session) => t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } }).then((r) => r.json().id as string);
  root = homeRoot(t.config.dataDir, await id(a));
  memberRoot = homeRoot(t.config.dataDir, await id(m));
  mkdirSync(root, { recursive: true });
  outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'outside the home');
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});

let port: number;
/** A request whose path goes on the wire exactly as written. */
const raw = (method: string, path: string, payload?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, method, path, headers: { authorization: basic(pw) } }, (res) => {
    let body = '';
    res.setEncoding('utf8').on('data', (c: string) => { body += c; }).on('end', () => resolve({ status: res.statusCode!, body }));
  });
  r.on('error', reject);
  r.end(payload);
});
// Keep-alive sockets of the raw requests would hold close() open for Fastify's keep-alive timeout.
afterAll(async () => { t.app.server.closeAllConnections(); await t.close(); rmSync(outside, { recursive: true, force: true }); });

type Opts = { headers?: Record<string, string>; payload?: string | Buffer; password?: string | null };
const dav = (method: string, path: string, o: Opts = {}) => t.app.inject({
  method: method as 'GET', url: `/dav${path}`, payload: o.payload,
  headers: { ...(o.password === null ? {} : { authorization: basic(o.password ?? pw) }), ...o.headers },
});
const dest = (path: string) => ({ destination: `https://files.example.com/dav${path}` });
const propfind = (path: string, depth: '0' | '1', body?: string, o: Opts = {}) =>
  dav('PROPFIND', path, { ...o, headers: { depth, 'content-type': 'application/xml', ...o.headers }, payload: body ?? '' });
let n = 0;
const fresh = (stem: string) => `/${stem}-${++n}`;
const trashList = async () => (await t.app.inject({ url: '/api/v1/trash', headers: { cookie: a.cookie } })).json() as
  { items: { id: string; originalPath: string }[] };

describe('authentication', () => {
  it('advertises class 1 and 2 on OPTIONS', async () => {
    const r = await dav('OPTIONS', '/');
    expect(r.statusCode).toBe(200);
    expect(String(r.headers.dav).split(',').map((s) => s.trim())).toEqual(expect.arrayContaining(['1', '2']));
    expect(String(r.headers.allow)).toMatch(/PROPFIND/);
    expect(String(r.headers.allow)).toMatch(/LOCK/);
  });

  it('answers 401 with a Basic challenge without credentials or with a wrong password', async () => {
    const none = await dav('PROPFIND', '/', { password: null, headers: { depth: '0' } });
    expect(none.statusCode).toBe(401);
    expect(String(none.headers['www-authenticate'])).toMatch(/^Basic realm="/);
    expect((await dav('PROPFIND', '/', { password: pw.slice(0, -1) + (pw.endsWith('a') ? 'b' : 'a'), headers: { depth: '0' } })).statusCode).toBe(401);
    expect((await dav('PROPFIND', '/', { password: 'not-an-app-password', headers: { depth: '0' } })).statusCode).toBe(401);
  });

  it('a session cookie does not open WebDAV, and an app password does not open the rest of the app', async () => {
    const withCookie = await t.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/', headers: { cookie: a.cookie, depth: '0' } });
    expect(withCookie.statusCode).toBe(401);
    const api = await t.app.inject({ url: '/api/v1/me', headers: { authorization: basic(pw) } });
    expect(api.statusCode).toBe(401);
    const put = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=/x.txt&onCollision=fail',
      headers: { authorization: basic(pw), 'content-type': 'application/octet-stream', origin: ORIGIN }, payload: 'x' });
    expect(put.statusCode).toBe(401);
  });

  it('refuses a request that a web page sent from another origin', async () => {
    const r = await dav('PUT', '/cross-site.txt', { payload: 'x', headers: { origin: 'https://evil.example.org' } });
    expect(r.statusCode).toBe(403);
    expect(existsSync(join(root, 'cross-site.txt'))).toBe(false);
  });

  it('each member reaches only their own home', async () => {
    const p = fresh('mine');
    expect((await dav('PUT', `${p}.txt`, { payload: 'member data', password: memberPw })).statusCode).toBe(201);
    expect(readFileSync(join(memberRoot, `${p}.txt`), 'utf8')).toBe('member data');
    expect(existsSync(join(root, `${p}.txt`))).toBe(false);
    expect((await dav('GET', `${p}.txt`)).statusCode).toBe(404);
  });
});

describe('files and folders', () => {
  it('PUT streams a file in, GET returns it with the ETag that PROPFIND reports, and Range works', async () => {
    const p = `${fresh('doc')}.txt`;
    expect((await dav('PUT', p, { payload: 'hello webdav' })).statusCode).toBe(201);
    expect(readFileSync(join(root, p), 'utf8')).toBe('hello webdav');
    const get = await dav('GET', p);
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('hello webdav');
    const [entry] = multistatus((await propfind(p, '0')).body);
    expect(propText(entry, 'getetag')).toBe(get.headers.etag);
    expect(propText(entry, 'getcontentlength')).toBe('12');
    const head = await dav('HEAD', p);
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('12');
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.body).toBe('');
    const part = await dav('GET', p, { headers: { range: 'bytes=6-' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('webdav');
    // Overwriting answers 204 and changes the ETag; the old content is kept as a version (#154).
    expect((await dav('PUT', p, { payload: 'changed' })).statusCode).toBe(204);
    const again = await dav('GET', p);
    expect(again.body).toBe('changed');
    expect(again.headers.etag).not.toBe(get.headers.etag);
  });

  it('serves content with the sandbox CSP, nosniff and as an attachment for HTML', async () => {
    const p = `${fresh('page')}.html`;
    await dav('PUT', p, { payload: '<script>alert(1)</script>' });
    const r = await dav('GET', p);
    expect(r.headers['content-security-policy']).toMatch(/sandbox/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('PUT and MKCOL refuse a missing parent with 409, MKCOL refuses a taken name with 405 and a body with 415', async () => {
    const d = fresh('dir');
    expect((await dav('PUT', `${d}/missing/file.txt`, { payload: 'x' })).statusCode).toBe(409);
    expect(existsSync(join(root, d))).toBe(false);
    expect((await dav('MKCOL', `${d}/missing/sub`)).statusCode).toBe(409);
    expect((await dav('MKCOL', d)).statusCode).toBe(201);
    expect((await dav('MKCOL', d)).statusCode).toBe(405);
    expect((await dav('MKCOL', `${d}/withbody`, { payload: '<x/>', headers: { 'content-type': 'application/xml' } })).statusCode).toBe(415);
    await dav('PUT', `${d}/plain.txt`, { payload: 'x' });
    expect((await dav('MKCOL', `${d}/plain.txt`)).statusCode).toBe(405);
  });

  it('PROPFIND lists a folder with encoded hrefs, collections with a slash, and never the internal area', async () => {
    const d = fresh('list');
    await dav('MKCOL', d);
    await dav('MKCOL', `${d}/a b`);
    await dav('PUT', `${d}/a b/${encodeURIComponent('ä#%.txt')}`, { payload: 'umlaut' });
    const r = await propfind(`${d}/a%20b/`, '1');
    expect(r.statusCode).toBe(207);
    const hrefs = multistatus(r.body).map((x) => x.href);
    expect(hrefs).toEqual([`/dav${d}/a%20b/`, `/dav${d}/a%20b/%C3%A4%23%25.txt`]);
    expect(readFileSync(join(root, d, 'a b', 'ä#%.txt'), 'utf8')).toBe('umlaut');
    const top = multistatus((await propfind('/', '1')).body);
    expect(top[0]!.href).toBe('/dav/');
    expect(top[0]!.props.get('{DAV:}resourcetype')!.el.getElementsByTagNameNS('DAV:', 'collection').length).toBe(1);
    // Earlier tests left trash and versions under .files/; it never shows.
    expect(existsSync(join(root, '.files'))).toBe(true);
    expect(top.map((x) => x.href).filter((h) => h.includes('.files'))).toEqual([]);
  });

  it('refuses PROPFIND with Depth: infinity', async () => {
    const r = await dav('PROPFIND', '/', { headers: { depth: 'infinity' } });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('propfind-finite-depth');
  });

  it('refuses malformed XML and any DOCTYPE', async () => {
    expect((await propfind('/', '0', '<D:propfind xmlns:D="DAV:"><D:prop>')).statusCode).toBe(400);
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]>
      <D:propfind xmlns:D="DAV:"><D:prop><D:displayname>&e;</D:displayname></D:prop></D:propfind>`;
    expect((await propfind('/', '0', xxe)).statusCode).toBe(400);
  });

  it('holds PUT to the member quota (#156)', async () => {
    const uid = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: m.cookie } })).json().id;
    t.db.prepare('UPDATE users SET quota_bytes = 10 WHERE id = ?').run(uid);
    try {
      const r = await dav('PUT', `${fresh('big')}.bin`, { payload: Buffer.alloc(4096), password: memberPw });
      expect(r.statusCode).toBe(507);
    } finally { t.db.prepare('UPDATE users SET quota_bytes = NULL WHERE id = ?').run(uid); }
  });
});

describe('DELETE goes to the trash (#105)', () => {
  it('a deleted file is in the trash and restorable with its content', async () => {
    const p = `${fresh('gone')}.txt`;
    await dav('PUT', p, { payload: 'keep me' });
    expect((await dav('DELETE', p)).statusCode).toBe(204);
    expect(existsSync(join(root, p))).toBe(false);
    expect((await dav('GET', p)).statusCode).toBe(404);
    const item = (await trashList()).items.find((i) => i.originalPath === p);
    expect(item).toBeDefined();
    const restore = await t.app.inject({ method: 'POST', url: '/api/v1/trash/restore',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { id: item!.id, onCollision: 'fail' } });
    expect(restore.statusCode).toBe(200);
    expect((await dav('GET', p)).body).toBe('keep me');
  });

  it('a deleted folder goes to the trash as one item', async () => {
    const d = fresh('gonedir');
    await dav('MKCOL', d);
    await dav('PUT', `${d}/inner.txt`, { payload: 'inner' });
    expect((await dav('DELETE', `${d}/`)).statusCode).toBe(204);
    expect((await trashList()).items.filter((i) => i.originalPath === d)).toHaveLength(1);
    expect((await dav('DELETE', d)).statusCode).toBe(404);
  });

  it('refuses to delete the root', async () => {
    expect((await dav('DELETE', '/')).statusCode).toBe(403);
  });
});

describe('COPY and MOVE', () => {
  it('copies a file, honours Overwrite: F with 412 and replaces into the trash with Overwrite: T', async () => {
    const d = fresh('cp');
    await dav('MKCOL', d);
    await dav('PUT', `${d}/a.txt`, { payload: 'A' });
    await dav('PUT', `${d}/b.txt`, { payload: 'B' });
    expect((await dav('COPY', `${d}/a.txt`, { headers: dest(`${d}/c.txt`) })).statusCode).toBe(201);
    expect(readFileSync(join(root, d, 'c.txt'), 'utf8')).toBe('A');
    expect((await dav('COPY', `${d}/a.txt`, { headers: { ...dest(`${d}/b.txt`), overwrite: 'F' } })).statusCode).toBe(412);
    expect(readFileSync(join(root, d, 'b.txt'), 'utf8')).toBe('B');
    expect((await dav('COPY', `${d}/a.txt`, { headers: { ...dest(`${d}/b.txt`), overwrite: 'T' } })).statusCode).toBe(204);
    expect(readFileSync(join(root, d, 'b.txt'), 'utf8')).toBe('A');
    expect((await trashList()).items.some((i) => i.originalPath === `${d}/b.txt`)).toBe(true);
    // Overwrite defaults to T.
    expect((await dav('COPY', `${d}/a.txt`, { headers: dest(`${d}/c.txt`) })).statusCode).toBe(204);
    expect((await dav('COPY', `${d}/a.txt`, { headers: dest(`${d}/nope/c.txt`) })).statusCode).toBe(409);
    expect((await dav('COPY', `${d}/a.txt`, { headers: dest(`${d}/a.txt`) })).statusCode).toBe(403);
  });

  it('copies a folder deeply, or only the folder with Depth: 0', async () => {
    const d = fresh('cpdir');
    await dav('MKCOL', d);
    await dav('MKCOL', `${d}/src`);
    await dav('PUT', `${d}/src/f.txt`, { payload: 'F' });
    expect((await dav('COPY', `${d}/src/`, { headers: dest(`${d}/deep/`) })).statusCode).toBe(201);
    expect(readFileSync(join(root, d, 'deep', 'f.txt'), 'utf8')).toBe('F');
    expect((await dav('COPY', `${d}/src/`, { headers: { ...dest(`${d}/shallow/`), depth: '0' } })).statusCode).toBe(201);
    expect(existsSync(join(root, d, 'shallow'))).toBe(true);
    expect(existsSync(join(root, d, 'shallow', 'f.txt'))).toBe(false);
  });

  it('moves a file and a folder, with the Overwrite rules', async () => {
    const d = fresh('mv');
    await dav('MKCOL', d);
    await dav('PUT', `${d}/a.txt`, { payload: 'A' });
    await dav('PUT', `${d}/b.txt`, { payload: 'B' });
    expect((await dav('MOVE', `${d}/a.txt`, { headers: { ...dest(`${d}/b.txt`), overwrite: 'F' } })).statusCode).toBe(412);
    expect((await dav('MOVE', `${d}/a.txt`, { headers: dest(`${d}/c.txt`) })).statusCode).toBe(201);
    expect(existsSync(join(root, d, 'a.txt'))).toBe(false);
    expect((await dav('MOVE', `${d}/c.txt`, { headers: { ...dest(`${d}/b.txt`), overwrite: 'T' } })).statusCode).toBe(204);
    expect(readFileSync(join(root, d, 'b.txt'), 'utf8')).toBe('A');
    await dav('MKCOL', `${d}/sub`);
    expect((await dav('MOVE', `${d}/sub/`, { headers: dest(`${d}/moved/`) })).statusCode).toBe(201);
    expect(existsSync(join(root, d, 'moved'))).toBe(true);
  });
});

describe('paths that must not resolve', () => {
  it('rejects .. and encoded traversal sent as they are', async () => {
    // Over a socket with the path exactly as written: an HTTP client library would resolve the dot segments first.
    writeFileSync(join(root, '..', 'neighbour.txt'), 'another home');
    for (const url of ['/../neighbour.txt', '/%2e%2e/neighbour.txt', '/a/%2E%2E/%2E%2E/neighbour.txt', '/..%2fneighbour.txt',
      '/a/%2e%2e%2f%2e%2e%2fneighbour.txt', '/./%2e/neighbour.txt']) {
      const get = await raw('GET', `/dav${url}`);
      expect(get.status, url).toBe(400);
      expect(get.body, url).not.toContain('another home');
      expect((await raw('PUT', `/dav${url}-new`, 'x')).status, url).toBe(400);
      expect((await raw('DELETE', `/dav${url}`)).status, url).toBe(400);
    }
    expect(readFileSync(join(root, '..', 'neighbour.txt'), 'utf8')).toBe('another home');
    // A raw fragment never addresses the folder before it.
    const d = fresh('frag');
    await dav('MKCOL', d);
    expect((await raw('DELETE', `/dav${d}/#ment`)).status).toBe(400);
    expect(existsSync(join(root, d))).toBe(true);
    expect(existsSync(join(root, '..', 'neighbour.txt-new'))).toBe(false);
    const viaDest = await dav('PUT', `${fresh('trav')}.txt`, { payload: 'x' });
    expect(viaDest.statusCode).toBe(201);
    const mv = await dav('MOVE', `/trav-${n}.txt`, { headers: { destination: 'https://files.example.com/dav/%2e%2e/escaped.txt' } });
    expect(mv.statusCode).toBe(400);
    expect(existsSync(join(root, '..', 'escaped.txt'))).toBe(false);
    // A Destination outside the WebDAV tree is not ours.
    const other = await dav('COPY', `/trav-${n}.txt`, { headers: { destination: 'https://files.example.com/api/v1/x.txt' } });
    expect(other.statusCode).toBe(502);
  });

  it('rejects symlinks, also as an intermediate folder', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'linkdir'));
    for (const p of ['/link.txt', '/linkdir/secret.txt']) {
      const get = await dav('GET', p);
      expect(get.statusCode, p).toBe(400);
      expect(get.body).not.toContain('outside the home');
      expect((await propfind(p, '0')).statusCode, p).toBe(400);
      expect((await dav('DELETE', p)).statusCode, p).toBe(400);
    }
    expect((await dav('PUT', '/linkdir/planted.txt', { payload: 'x' })).statusCode).toBe(400);
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
    expect((await dav('MKCOL', '/linkdir/sub')).statusCode).toBe(400);
    expect((await dav('COPY', '/linkdir/secret.txt', { headers: dest('/stolen.txt') })).statusCode).toBe(400);
    const src = `${fresh('into')}.txt`;
    await dav('PUT', src, { payload: 'x' });
    expect((await dav('MOVE', src, { headers: dest('/linkdir/moved.txt') })).statusCode).toBe(400);
    expect(existsSync(join(outside, 'moved.txt'))).toBe(false);
    // A listing never shows them.
    expect(multistatus((await propfind('/', '1')).body).map((x) => x.href)).not.toContain('/dav/link.txt');
  });

  it('rejects the internal area .files/', async () => {
    for (const p of ['/.files', '/.files/', '/.files/trash', '/%2efiles/trash']) {
      expect((await propfind(p, '1')).statusCode, p).toBe(400);
      expect((await dav('GET', p)).statusCode, p).toBe(400);
    }
    expect((await dav('PUT', '/.files/planted.txt', { payload: 'x' })).statusCode).toBe(400);
    expect((await dav('MKCOL', '/.files/x')).statusCode).toBe(400);
    expect((await dav('DELETE', '/.files')).statusCode).toBe(400);
    const src = `${fresh('hide')}.txt`;
    await dav('PUT', src, { payload: 'x' });
    expect((await dav('MOVE', src, { headers: dest('/.files/trash/x') })).statusCode).toBe(400);
    expect((await dav('COPY', src, { headers: dest('/.files/x') })).statusCode).toBe(400);
    expect(existsSync(join(root, '.files', 'planted.txt'))).toBe(false);
  });
});

const PROPPATCH = (set: string, remove = '') => `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="http://example.com/ns">
  ${set ? `<D:set><D:prop>${set}</D:prop></D:set>` : ''}${remove ? `<D:remove><D:prop>${remove}</D:prop></D:remove>` : ''}
</D:propertyupdate>`;
const askProps = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:Z="http://example.com/ns">
  <D:prop><Z:colour/><Z:nested/></D:prop></D:propfind>`;

describe('properties', () => {
  it('stores dead properties, returns them with their XML, follows MOVE and goes with DELETE', async () => {
    const p = `${fresh('props')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    const set = await dav('PROPPATCH', p, { payload: PROPPATCH('<Z:colour>blue 𐀀</Z:colour><Z:nested><Z:a xmlns:Q="urn:q"><Q:b>1</Q:b></Z:a></Z:nested>'),
      headers: { 'content-type': 'application/xml' } });
    expect(set.statusCode).toBe(207);
    expect([...multistatus(set.body)[0]!.props.values()].map((v) => v.status)).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);
    const moved = `${fresh('props')}.txt`;
    expect((await dav('MOVE', p, { headers: dest(moved) })).statusCode).toBe(201);
    const [r] = multistatus((await propfind(moved, '0', askProps)).body);
    expect(r!.props.get('{http://example.com/ns}colour')!.el.textContent).toBe('blue 𐀀');
    const nested = r!.props.get('{http://example.com/ns}nested')!.el;
    expect(nested.getElementsByTagNameNS('urn:q', 'b').item(0)!.textContent).toBe('1');
    // Removed with the file: a new file at the path starts without them.
    await dav('DELETE', moved);
    await dav('PUT', moved, { payload: 'new' });
    const [after] = multistatus((await propfind(moved, '0', askProps)).body);
    expect(after!.props.get('{http://example.com/ns}colour')!.status).toBe('HTTP/1.1 404 Not Found');
  });

  it('removes a property and refuses protected live properties, all or nothing', async () => {
    const p = `${fresh('props')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    await dav('PROPPATCH', p, { payload: PROPPATCH('<Z:colour>red</Z:colour>') });
    const bad = await dav('PROPPATCH', p, { payload: PROPPATCH('<Z:colour>green</Z:colour><D:getetag>"forged"</D:getetag>') });
    expect(bad.statusCode).toBe(207);
    const statuses = multistatus(bad.body)[0]!.props;
    expect(statuses.get('{DAV:}getetag')!.status).toBe('HTTP/1.1 403 Forbidden');
    expect(statuses.get('{http://example.com/ns}colour')!.status).toBe('HTTP/1.1 424 Failed Dependency');
    let [r] = multistatus((await propfind(p, '0', askProps)).body);
    expect(r!.props.get('{http://example.com/ns}colour')!.el.textContent).toBe('red');
    await dav('PROPPATCH', p, { payload: PROPPATCH('', '<Z:colour/>') });
    [r] = multistatus((await propfind(p, '0', askProps)).body);
    expect(r!.props.get('{http://example.com/ns}colour')!.status).toBe('HTTP/1.1 404 Not Found');
  });

  it('COPY copies dead properties', async () => {
    const p = `${fresh('props')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    await dav('PROPPATCH', p, { payload: PROPPATCH('<Z:colour>teal</Z:colour>') });
    const c = `${fresh('props')}.txt`;
    expect((await dav('COPY', p, { headers: dest(c) })).statusCode).toBe(201);
    const [r] = multistatus((await propfind(c, '0', askProps)).body);
    expect(r!.props.get('{http://example.com/ns}colour')!.el.textContent).toBe('teal');
  });
});

const LOCKINFO = `<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>testuser</D:owner></D:lockinfo>`;
const SHARED = LOCKINFO.replace('<D:exclusive/>', '<D:shared/>');
const lock = (p: string, o: { depth?: string; body?: string; password?: string } = {}) => dav('LOCK', p,
  { payload: o.body ?? LOCKINFO, headers: { 'content-type': 'application/xml', timeout: 'Second-600', depth: o.depth ?? '0' },
    ...(o.password ? { password: o.password } : {}) });
const tokenOf = (r: { headers: Record<string, unknown> }) => /^<(.+)>$/.exec(String(r.headers['lock-token']))![1]!;

describe('locks', () => {
  it('an exclusive lock blocks changes without its token and allows them with it', async () => {
    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'v1' });
    const l = await lock(p);
    expect(l.statusCode).toBe(200);
    const token = tokenOf(l);
    expect(token).toMatch(/^opaquelocktoken:[0-9a-f-]{36}$/);
    expect(l.body).toContain(token);
    expect(l.body).toContain('testuser');
    expect((await dav('PUT', p, { payload: 'v2' })).statusCode).toBe(423);
    expect((await dav('DELETE', p)).statusCode).toBe(423);
    expect((await dav('PROPPATCH', p, { payload: PROPPATCH('<Z:colour>x</Z:colour>') })).statusCode).toBe(423);
    expect((await dav('MOVE', p, { headers: dest(`${p}.moved`) })).statusCode).toBe(423);
    expect((await lock(p)).statusCode).toBe(423);
    expect((await lock(p, { body: SHARED })).statusCode).toBe(423);
    // A token that is not this lock's is not submitting it.
    expect((await dav('PUT', p, { payload: 'v2', headers: { if: `(<${token}x>) (Not <DAV:no-lock>)` } })).statusCode).toBe(423);
    expect((await dav('PUT', p, { payload: 'v2', headers: { if: `(<${token}>)` } })).statusCode).toBe(204);
    expect(readFileSync(join(root, p), 'utf8')).toBe('v2');
    // The lock is discoverable.
    const [d] = multistatus((await propfind(p, '0', '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>')).body);
    expect(d!.props.get('{DAV:}lockdiscovery')!.el.getElementsByTagNameNS('DAV:', 'href').item(0)!.textContent).toBe(token);
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${token}>` } })).statusCode).toBe(204);
    expect((await dav('PUT', p, { payload: 'v3' })).statusCode).toBe(204);
    // A condition on a token that is no longer a lock fails.
    expect((await dav('PUT', p, { payload: 'v4', headers: { if: `(<${token}>)` } })).statusCode).toBe(412);
  });

  it('evaluates ETags and Not in If, tagged and untagged', async () => {
    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'v1' });
    const token = tokenOf(await lock(p));
    const etag = String((await dav('GET', p)).headers.etag);
    const url = `https://files.example.com/dav${p}`;
    expect((await dav('PUT', p, { payload: 'v2', headers: { if: `<${url}> (<${token}> ["bogus"])` } })).statusCode).toBe(412);
    expect((await dav('PUT', p, { payload: 'v2', headers: { if: `<${url}> (<${token}> [${etag}])` } })).statusCode).toBe(204);
    const etag2 = String((await dav('GET', p)).headers.etag);
    expect((await dav('PUT', p, { payload: 'v3', headers: { if: `(<${token}> [${etag2}]) (Not <DAV:no-lock> [${etag2}])` } })).statusCode).toBe(204);
    expect((await dav('PUT', p, { payload: 'v4', headers: { if: `(<${token}> ["x"]) (Not <DAV:no-lock> ["x"])` } })).statusCode).toBe(412);
    expect((await dav('PUT', p, { payload: 'v4', headers: { if: `(<${token}>) (Not <DAV:no-lock>)` } })).statusCode).toBe(204);
    await dav('UNLOCK', p, { headers: { 'lock-token': `<${token}>` } });
  });

  it('a depth-infinity lock on a folder covers its members, and refreshes through a member', async () => {
    const d = fresh('lockdir');
    await dav('MKCOL', d);
    await dav('PUT', `${d}/m.txt`, { payload: 'm' });
    const l = await lock(`${d}/`, { depth: 'infinity' });
    expect(l.statusCode).toBe(200);
    const token = tokenOf(l);
    expect((await dav('PUT', `${d}/m.txt`, { payload: 'x' })).statusCode).toBe(423);
    expect((await dav('PUT', `${d}/new.txt`, { payload: 'x' })).statusCode).toBe(423);
    expect((await dav('DELETE', `${d}/m.txt`)).statusCode).toBe(423);
    expect((await lock(`${d}/m.txt`)).statusCode).toBe(423);
    expect((await dav('PUT', `${d}/m.txt`, { payload: 'x', headers: { if: `(<${token}>)` } })).statusCode).toBe(204);
    const refresh = await dav('LOCK', `${d}/m.txt`, { headers: { if: `(<${token}>)`, timeout: 'Second-900' } });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.body).toContain(token);
    expect((await dav('UNLOCK', `${d}/m.txt`, { headers: { 'lock-token': `<${token}>` } })).statusCode).toBe(204);
    expect((await dav('PUT', `${d}/m.txt`, { payload: 'y' })).statusCode).toBe(204);
  });

  it('shared locks coexist, an exclusive one does not join them', async () => {
    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    const s1 = await lock(p, { body: SHARED });
    const s2 = await lock(p, { body: SHARED });
    expect([s1.statusCode, s2.statusCode]).toEqual([200, 200]);
    expect((await lock(p)).statusCode).toBe(423);
    for (const r of [s1, s2]) expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${tokenOf(r)}>` } })).statusCode).toBe(204);
  });

  it('locking an unmapped URL creates an empty file', async () => {
    const p = `${fresh('unmapped')}.txt`;
    const l = await lock(p);
    expect(l.statusCode).toBe(201);
    expect(readFileSync(join(root, p), 'utf8')).toBe('');
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${tokenOf(l)}>` } })).statusCode).toBe(204);
  });

  it('locks are per member: another member never sees or breaks them', async () => {
    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    await dav('PUT', p, { payload: 'x', password: memberPw });
    const token = tokenOf(await lock(p));
    expect((await dav('PUT', p, { payload: 'member', password: memberPw })).statusCode).toBe(204);
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${token}>` }, password: memberPw })).statusCode).toBe(409);
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${token}>` } })).statusCode).toBe(204);
  });

  // #253: every lock is kept in memory for up to a day, so neither its owner XML nor their number is unbounded.
  it('refuses an owner larger than 4096 bytes and keeps no lock for it', async () => {
    const withOwner = (text: string) => SHARED.replace('<D:owner>testuser</D:owner>', `<D:owner>${text}</D:owner>`);
    const unlock = async (path: string, r: { headers: Record<string, unknown> }) =>
      expect((await dav('UNLOCK', path, { headers: { 'lock-token': `<${tokenOf(r)}>` } })).statusCode).toBe(204);
    // The stored owner is the element as serialized, reported back between depth and timeout; measure its wrapping.
    const probe = `${fresh('lock')}.txt`;
    await dav('PUT', probe, { payload: 'x' });
    const small = await lock(probe, { body: withOwner('y') });
    const wrapping = Buffer.byteLength(/<\/D:depth>(.*)<D:timeout>/s.exec(small.body)![1]!) - 1;
    await unlock(probe, small);

    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    const over = withOwner('x'.repeat(4097 - wrapping));
    const r = await lock(p, { body: over });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect(r.headers['lock-token']).toBeUndefined();
    // Bytes, not characters: 1400 euro signs are 4200 bytes.
    expect((await lock(p, { body: withOwner('€'.repeat(1400)) })).statusCode).toBe(400);
    const unmapped = `${fresh('lock')}.txt`;
    expect((await lock(unmapped, { body: over })).statusCode).toBe(400);
    expect((await dav('GET', unmapped)).statusCode).toBe(404);
    // Nothing was locked: an exclusive lock still goes through.
    const l = await lock(p);
    expect(l.statusCode).toBe(200);
    await unlock(p, l);
    // An owner of exactly 4096 bytes is kept and reported back as sent.
    const text = 'y'.repeat(4096 - wrapping);
    const ok = await lock(p, { body: withOwner(text) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain(`${text}</D:owner>`);
    await unlock(p, ok);
  });

  it('caps the live locks of one member at 100; another member can still lock', async () => {
    const p = `${fresh('lock')}.txt`;
    await dav('PUT', p, { payload: 'x' });
    await dav('PUT', p, { payload: 'x', password: memberPw });
    const tokens: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await lock(p, { body: SHARED });
      expect(r.statusCode).toBe(200);
      tokens.push(tokenOf(r));
    }
    const over = await lock(p, { body: SHARED });
    expect(over.statusCode).toBe(503);
    expect(over.json().code).toBe('LOCK_LIMIT');
    expect(over.headers['lock-token']).toBeUndefined();
    // Not even on another item, and a refused lock on an unmapped URL creates no file.
    const q = `${fresh('lock')}.txt`;
    expect((await lock(q)).statusCode).toBe(503);
    expect((await dav('GET', q)).statusCode).toBe(404);
    // The other member's locks are counted apart.
    const theirs = await lock(p, { password: memberPw });
    expect(theirs.statusCode).toBe(200);
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${tokenOf(theirs)}>` }, password: memberPw })).statusCode).toBe(204);
    // A refresh adds no lock and still works at the cap.
    expect((await dav('LOCK', p, { headers: { if: `(<${tokens[0]}>)`, timeout: 'Second-900' } })).statusCode).toBe(200);
    // Releasing one frees a place.
    expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${tokens.pop()}>` } })).statusCode).toBe(204);
    const again = await lock(p, { body: SHARED });
    expect(again.statusCode).toBe(200);
    tokens.push(tokenOf(again));
    for (const tk of tokens) expect((await dav('UNLOCK', p, { headers: { 'lock-token': `<${tk}>` } })).statusCode).toBe(204);
  });
});
