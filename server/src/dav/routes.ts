import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { Element } from '@xmldom/xmldom';
import type { Entry } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireDavUser } from '../auth/guard.ts';
import { homeOf } from '../storage/resolveSource.ts';
import type { LocalBackend } from '../storage/local.ts';
import { readRanged, sendContent } from '../http/content.ts';
import type { User } from '../users.ts';
import { ForeignUrl, headerPath, hrefOf, parentOf, requestPath } from './paths.ts';
import { LockStore, parseTimeout, type Lock } from './locks.ts';
import { parseIf, sameEtag, submittedTokens, type IfList } from './ifHeader.ts';
import { changeProps, checkCopyFits, copyProps, deadProps, tooLarge, type PropChange } from './props.ts';
import {
  child, children, DAV, escapeXml, isDav, parseXml, propElement, propKey, propNameOf, readText, serialize, STATUS, XML_HEAD,
  type PropName,
} from './xml.ts';

// WebDAV class 1 and 2 over the member's own home (#157, spec §2.1). Every operation goes through the home's
// `LocalBackend`, so every path passes `resolveInRoot`, `.files/` stays unaddressable, DELETE and "Overwrite: T" go to
// the trash, overwrites keep versions and the quota holds. Authentication is the app password (guard.ts).

const METHODS = ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];
const CUSTOM: [string, boolean][] = [['PROPFIND', true], ['PROPPATCH', true], ['MKCOL', true], ['COPY', false], ['MOVE', false],
  ['LOCK', true], ['UNLOCK', false]];

/** The ETag of an entry: its size and modification time, the same in PROPFIND, GET and `If`. */
const etagOf = (e: Entry): string => `"${e.size.toString(16)}-${Date.parse(e.modified ?? '0').toString(16)}"`;

const LIVE: PropName[] = ['creationdate', 'displayname', 'getcontentlength', 'getcontenttype', 'getetag', 'getlastmodified',
  'resourcetype', 'supportedlock', 'lockdiscovery'].map((name) => ({ ns: DAV, name }));
const QUOTA = ['quota-available-bytes', 'quota-used-bytes'];
const PROTECTED = new Set([...LIVE.map((p) => p.name), ...QUOTA]);

type Ctx = { user: User; home: LocalBackend; locks: LockStore; req: FastifyRequest };

async function statOrUndefined(home: LocalBackend, path: string): Promise<Entry | undefined> {
  return home.stat(path).catch((e: unknown) => {
    if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: the item does not exist
    throw e;
  });
}

const multistatus = (reply: FastifyReply, body: string) =>
  reply.status(207).header('content-type', 'application/xml; charset=utf-8')
    .send(`${XML_HEAD}<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`);

const davError = (reply: FastifyReply, status: number, condition: string) =>
  reply.status(status).header('content-type', 'application/xml; charset=utf-8')
    .send(`${XML_HEAD}<D:error xmlns:D="DAV:"><D:${condition}/></D:error>`);

function activeLock(l: Lock): string {
  return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${l.scope}/></D:lockscope>`
    + `<D:depth>${l.depth === '0' ? '0' : 'infinity'}</D:depth>${l.ownerXml}`
    + `<D:timeout>Second-${Math.max(0, Math.round((l.expires - Date.now()) / 1000))}</D:timeout>`
    + `<D:locktoken><D:href>${escapeXml(l.token)}</D:href></D:locktoken>`
    + `<D:lockroot><D:href>${escapeXml(hrefOf(l.root, false))}</D:href></D:lockroot></D:activelock>`;
}

/** The value of a live property, or undefined where the item has none (a folder's length). */
async function liveValue(c: Ctx, e: Entry, name: string): Promise<string | undefined> {
  const dir = e.type === 'directory';
  switch (name) {
    case 'creationdate': return e.modified && escapeXml(e.modified);
    case 'displayname': return e.path === '/' ? '' : escapeXml(e.name);
    case 'getcontentlength': return dir ? undefined : String(e.size);
    case 'getcontenttype': return dir ? undefined : escapeXml(e.mime ?? 'application/octet-stream');
    case 'getetag': return dir ? undefined : escapeXml(etagOf(e));
    case 'getlastmodified': return e.modified && new Date(e.modified).toUTCString();
    case 'resourcetype': return dir ? '<D:collection/>' : '';
    case 'supportedlock': return ['exclusive', 'shared'].map((s) =>
      `<D:lockentry><D:lockscope><D:${s}/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>`).join('');
    case 'lockdiscovery': return c.locks.protecting(c.user.id, e.path, false).map(activeLock).join('');
    case 'quota-used-bytes': return dir ? String((await c.home.usage()).total) : undefined;
    case 'quota-available-bytes': {
      const quota = c.home.quotaBytes();
      return dir && quota !== null ? String(Math.max(0, quota - (await c.home.usage()).total)) : undefined;
    }
    default: return undefined;
  }
}

type Want = { kind: 'allprop' } | { kind: 'propname' } | { kind: 'prop'; props: PropName[] };

async function responseFor(c: Ctx, e: Entry, want: Want): Promise<string> {
  const dead = deadProps(c.req.server.deps.db, c.user.id, e.path);
  const found: string[] = []; const missing: string[] = [];
  if (want.kind === 'propname') {
    for (const p of LIVE) if (await liveValue(c, e, p.name) !== undefined) found.push(propElement(p));
    for (const p of dead) found.push(propElement(p));
  } else {
    const names = want.kind === 'allprop' ? LIVE : want.props;
    for (const p of names) {
      if (p.ns === DAV && (PROTECTED.has(p.name))) {
        const v = await liveValue(c, e, p.name);
        if (v === undefined) missing.push(propElement(p)); else found.push(propElement(p, v));
        continue;
      }
      const d = dead.find((x) => x.ns === p.ns && x.name === p.name);
      if (d) found.push(d.xml); else missing.push(propElement(p));
    }
    if (want.kind === 'allprop') for (const d of dead) found.push(d.xml);
  }
  const propstat = (items: string[], status: number) => items.length === 0 ? ''
    : `<D:propstat><D:prop>${items.join('')}</D:prop><D:status>${STATUS[status]}</D:status></D:propstat>`;
  return `<D:response><D:href>${escapeXml(hrefOf(e.path, e.type === 'directory'))}</D:href>`
    + `${propstat(found, 200)}${propstat(missing, 404)}</D:response>`;
}

export async function registerDavRoutes(app: FastifyInstance): Promise<void> {
  for (const [method, hasBody] of CUSTOM) app.addHttpMethod(method, { hasBody });
  const locks = new LockStore();
  const { config, db } = app.deps;

  await app.register(async (dav) => {
    // Bodies stay streams whatever their type: a PUT of a JSON file must never be parsed or buffered.
    dav.removeAllContentTypeParsers();
    dav.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    const ctxOf = (req: FastifyRequest): Ctx => {
      const user = requireDavUser(req);
      return { user, home: homeOf(app.deps, user.id), locks, req };
    };
    const body = (req: FastifyRequest) => req.body as Readable | undefined;
    const hasBody = (req: FastifyRequest) => req.headers['transfer-encoding'] !== undefined
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    // The header's path as a home path, or undefined for another server's URL; a malformed one is 400.
    const pathOfHeader = (value: string): string | undefined => {
      try { return headerPath(value); }
      catch (e) { if (e instanceof ForeignUrl) return undefined; throw e; } // handled: the caller answers or skips a foreign URL
    };

    /**
     * Preconditions of a change (RFC 4918 §10.4, §7): the `If` header must hold (412 otherwise), and every lock that
     * protects a changed path must have its token submitted (423 otherwise). `paths`: the request URL and, for COPY and
     * MOVE, the destination; `membership` when the item appears or disappears; `deep` when everything beneath goes too.
     */
    async function preconditions(c: Ctx, paths: { path: string; membership: boolean; deep: boolean }[]): Promise<number | undefined> {
      const header = c.req.headers.if;
      let lists: IfList[] = [];
      if (typeof header === 'string') {
        lists = parseIf(header);
        const own = requestPath(c.req.url);
        let holds = false;
        for (const l of lists) {
          const target = l.tag === undefined ? own : pathOfHeader(l.tag);
          if (target === undefined) continue; // a resource on another server: its list holds for nothing here
          const entry = await statOrUndefined(c.home, target);
          const protecting = c.locks.protecting(c.user.id, target, false);
          const ok = l.conditions.every((cond) => {
            const truth = 'token' in cond ? protecting.some((lk) => lk.token === cond.token)
              : entry !== undefined && entry.type === 'file' && sameEtag(cond.etag, etagOf(entry));
            return cond.not ? !truth : truth;
          });
          if (ok) { holds = true; break; }
        }
        if (!holds) return 412;
      }
      const submitted = submittedTokens(lists);
      for (const p of paths) {
        const guarding = c.locks.protecting(c.user.id, p.path, p.membership);
        if (guarding.length > 0 && !guarding.some((l) => submitted.has(l.token))) return 423;
        if (p.deep) {
          for (const l of c.locks.beneath(c.user.id, p.path)) if (!submitted.has(l.token)) return 423;
        }
      }
      return undefined;
    }

    const refuse = (reply: FastifyReply, status: number) => status === 423
      ? davError(reply, 423, 'lock-token-submitted') : reply.status(status).send({ code: 'PRECONDITION_FAILED' });

    // The parent folder of a new item must exist (409 otherwise, RFC 4918 §9.3.1, §9.7.1); the backend would create it.
    async function parentMissing(c: Ctx, path: string): Promise<boolean> {
      const parent = await statOrUndefined(c.home, parentOf(path));
      return parent?.type !== 'directory';
    }

    const handlers: Record<string, (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>> = {
      async OPTIONS(req, reply) {
        ctxOf(req);
        return reply.header('dav', '1, 2').header('allow', METHODS.join(', ')).header('ms-author-via', 'DAV').status(200).send();
      },

      async GET(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        const e = await c.home.stat(path);
        if (e.type === 'directory') return reply.status(405).header('allow', METHODS.filter((m) => m !== 'GET' && m !== 'HEAD').join(', ')).send();
        const r = await readRanged(c.home, path, req, reply);
        // The same sandbox and attachment rules as the API: a browser that has the credentials never runs a file here.
        return sendContent(reply.header('last-modified', new Date(r.entry.modified!).toUTCString()), { ...r, etag: etagOf(r.entry) },
          false, 'private, no-cache');
      },

      // What GET would send, without opening the file.
      async HEAD(req, reply) {
        const c = ctxOf(req);
        const e = await c.home.stat(requestPath(req.url));
        if (e.type === 'directory') return reply.status(405).send();
        return reply.status(200).header('content-type', e.mime ?? 'application/octet-stream').header('content-length', e.size)
          .header('etag', etagOf(e)).header('last-modified', new Date(e.modified!).toUTCString()).header('accept-ranges', 'bytes').send();
      },

      async PUT(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        if (path === '/') throw new AppError('IS_A_DIRECTORY');
        const close = () => { if (!req.raw.complete) reply.header('connection', 'close'); }; // stop draining an unread body
        const existing = await statOrUndefined(c.home, path);
        if (existing?.type === 'directory') { close(); return reply.status(405).send(); }
        if (!existing && await parentMissing(c, path)) { close(); return reply.status(409).send({ code: 'NOT_FOUND' }); }
        const refused = await preconditions(c, [{ path, membership: !existing, deep: false }]);
        if (refused) { close(); return refuse(reply, refused); }
        const declared = Number(req.headers['content-length'] ?? NaN);
        if (Number.isFinite(declared) && declared > config.maxUploadBytes) { close(); throw new AppError('PAYLOAD_TOO_LARGE'); }
        const entry = await c.home.write(path, body(req) ?? Readable.from([]), { onCollision: 'replace', maxBytes: config.maxUploadBytes,
          ...(Number.isSafeInteger(declared) ? { size: declared } : {}) }).catch((e: unknown) => { close(); throw e; });
        return reply.status(existing ? 204 : 201).header('etag', etagOf(entry)).send();
      },

      async MKCOL(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        if (hasBody(req)) { reply.header('connection', 'close'); throw new AppError('UNSUPPORTED_MEDIA_TYPE'); }
        if (path === '/' || await statOrUndefined(c.home, path)) return reply.status(405).send();
        if (await parentMissing(c, path)) return reply.status(409).send({ code: 'NOT_FOUND' });
        const refused = await preconditions(c, [{ path, membership: true, deep: false }]);
        if (refused) return refuse(reply, refused);
        await c.home.mkdir(path);
        return reply.status(201).send();
      },

      async DELETE(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        if (path === '/') throw new AppError('FORBIDDEN');
        await c.home.stat(path);
        const refused = await preconditions(c, [{ path, membership: true, deep: true }]);
        if (refused) return refuse(reply, refused);
        // The one way out of the home is the trash (#138); WebDAV must never bypass it (#105).
        await c.home.delete([path]);
        c.locks.removeUnder(c.user.id, path);
        return reply.status(204).send();
      },

      async COPY(req, reply) { return copyOrMove(req, reply, 'COPY'); },
      async MOVE(req, reply) { return copyOrMove(req, reply, 'MOVE'); },

      async PROPFIND(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        const depth = req.headers.depth ?? 'infinity';
        if (depth !== '0' && depth !== '1') return davError(reply, 403, 'propfind-finite-depth');
        const doc = parseXml(await readText(body(req)));
        let want: Want = { kind: 'allprop' };
        if (doc) {
          const root = doc.documentElement!;
          if (!isDav(root, 'propfind')) throw new AppError('VALIDATION');
          const prop = child(root, 'prop');
          if (prop) want = { kind: 'prop', props: children(prop).map(propNameOf) };
          else if (child(root, 'propname')) want = { kind: 'propname' };
          else if (!child(root, 'allprop')) throw new AppError('VALIDATION');
        }
        const self = await c.home.stat(path);
        const parts = [await responseFor(c, self, want)];
        if (depth === '1' && self.type === 'directory') {
          let cursor: string | undefined;
          do {
            const page = await c.home.list(path, cursor, 1000);
            for (const e of page.entries) parts.push(await responseFor(c, e, want));
            cursor = page.next;
          } while (cursor);
        }
        return multistatus(reply, parts.join(''));
      },

      async PROPPATCH(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        const doc = parseXml(await readText(body(req)));
        const root = doc?.documentElement;
        if (!root || !isDav(root, 'propertyupdate')) throw new AppError('VALIDATION');
        const e = await c.home.stat(path);
        const refused = await preconditions(c, [{ path, membership: false, deep: false }]);
        if (refused) return refuse(reply, refused);
        const changes: PropChange[] = [];
        for (const instr of children(root)) {
          const op = isDav(instr, 'set') ? 'set' : isDav(instr, 'remove') ? 'remove' : undefined;
          const prop = op && child(instr, 'prop');
          if (!op || !prop) throw new AppError('VALIDATION');
          for (const el of children(prop)) {
            const name = propNameOf(el);
            changes.push(op === 'set' ? { op, prop: { ...name, xml: serialize(el as Element) } } : { op, prop: name });
          }
        }
        // Live properties are the server's: one of them in the request fails the whole request (RFC 4918 §9.2).
        const denied = changes.filter((ch) => ch.prop.ns === DAV);
        // Beyond the bounds on dead properties (#254) nothing is applied. 507 goes to the properties too large, or else
        // (too many on the item, too many bytes for the member) to every property to be set; the rest get 424.
        const applied = denied.length === 0 && changeProps(db, c.user.id, e.path, changes);
        const sets = changes.flatMap((ch) => ch.op === 'set' ? [ch.prop] : []);
        const large = sets.filter(tooLarge);
        const full = new Set((large.length > 0 ? large : sets).map(propKey));
        const names = [...new Map(changes.map((ch) => [propKey(ch.prop), ch.prop])).values()];
        const status = (p: PropName) => denied.length > 0 ? (p.ns === DAV ? 403 : 424) : applied ? 200 : full.has(propKey(p)) ? 507 : 424;
        const groups = [200, 403, 424, 507].map((s) => [s, names.filter((p) => status(p) === s)] as const).filter(([, ps]) => ps.length > 0);
        return multistatus(reply, `<D:response><D:href>${escapeXml(hrefOf(e.path, e.type === 'directory'))}</D:href>${groups.map(([s, ps]) =>
          `<D:propstat><D:prop>${ps.map((p) => propElement(p)).join('')}</D:prop><D:status>${STATUS[s]}</D:status></D:propstat>`).join('')}</D:response>`);
      },

      async LOCK(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        const timeout = parseTimeout(req.headers.timeout as string | undefined);
        const doc = parseXml(await readText(body(req)));
        const answer = (l: Lock, status: number) => reply.status(status).header('content-type', 'application/xml; charset=utf-8')
          .header('lock-token', `<${l.token}>`)
          .send(`${XML_HEAD}<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLock(l)}</D:lockdiscovery></D:prop>`);
        if (!doc) {
          // A refresh: no body, and the lock named in the If header must protect this item.
          const header = req.headers.if;
          if (typeof header !== 'string') throw new AppError('VALIDATION');
          const lock = [...submittedTokens(parseIf(header))].map((t) => c.locks.get(c.user.id, t))
            .find((l) => l && c.locks.protecting(c.user.id, path, false).includes(l));
          if (!lock) return refuse(reply, 412);
          return answer(c.locks.refresh(lock, timeout), 200);
        }
        const info = doc.documentElement!;
        const scopeEl = child(info, 'lockscope');
        const scope = scopeEl && child(scopeEl, 'exclusive') ? 'exclusive' : scopeEl && child(scopeEl, 'shared') ? 'shared' : undefined;
        const typeEl = child(info, 'locktype');
        if (!isDav(info, 'lockinfo') || !scope || !typeEl || !child(typeEl, 'write')) throw new AppError('VALIDATION');
        const depthHeader = req.headers.depth ?? 'infinity';
        if (depthHeader !== '0' && depthHeader !== 'infinity') throw new AppError('VALIDATION');
        const owner = child(info, 'owner');
        const ownerXml = owner ? serialize(owner) : '';
        // Before the empty file of an unmapped URL is created, so a refused lock leaves nothing behind (create checks again).
        c.locks.admit(c.user.id, ownerXml);
        const existing = await statOrUndefined(c.home, path);
        if (!existing && await parentMissing(c, path)) return reply.status(409).send({ code: 'NOT_FOUND' });
        if (c.locks.conflicts(c.user.id, path, depthHeader, scope)) return davError(reply, 423, 'no-conflicting-lock');
        if (!existing) {
          const refused = await preconditions(c, [{ path, membership: true, deep: false }]);
          if (refused) return refuse(reply, refused);
          // A lock on an unmapped URL creates an empty file (RFC 4918 §9.10.4).
          await c.home.write(path, Readable.from([]), { onCollision: 'fail', maxBytes: config.maxUploadBytes, size: 0 });
        }
        const lock = c.locks.create({ userId: c.user.id, root: path, depth: depthHeader, scope, timeoutSeconds: timeout,
          ownerXml });
        return answer(lock, existing ? 200 : 201);
      },

      async UNLOCK(req, reply) {
        const c = ctxOf(req);
        const path = requestPath(req.url);
        const m = /^\s*<([^>]+)>\s*$/.exec(String(req.headers['lock-token'] ?? ''));
        if (!m) throw new AppError('VALIDATION');
        const lock = c.locks.get(c.user.id, m[1]!);
        if (!lock || !c.locks.protecting(c.user.id, path, false).includes(lock)) return davError(reply, 409, 'lock-token-matches-request-uri');
        c.locks.remove(lock.token);
        return reply.status(204).send();
      },
    };

    async function copyOrMove(req: FastifyRequest, reply: FastifyReply, method: 'COPY' | 'MOVE') {
      const c = ctxOf(req);
      const from = requestPath(req.url);
      const destination = req.headers.destination;
      if (typeof destination !== 'string') throw new AppError('VALIDATION');
      const to = pathOfHeader(destination);
      // Another server's resource: this server cannot copy there (RFC 4918 §9.8.5).
      if (to === undefined) return reply.status(502).send({ code: 'VALIDATION' });
      const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase();
      if (overwrite !== 'T' && overwrite !== 'F') throw new AppError('VALIDATION');
      const depth = req.headers.depth ?? 'infinity';
      if (depth !== 'infinity' && !(method === 'COPY' && depth === '0')) throw new AppError('VALIDATION');
      if (from === '/' || to === '/' || from === to) throw new AppError('FORBIDDEN');
      const src = await c.home.stat(from);
      if (await parentMissing(c, to)) return reply.status(409).send({ code: 'NOT_FOUND' });
      const target = await statOrUndefined(c.home, to);
      if (target && overwrite === 'F') return reply.status(412).send({ code: 'FILE_EXISTS' });
      const refused = await preconditions(c, [
        ...(method === 'MOVE' ? [{ path: from, membership: true, deep: true }] : []),
        { path: to, membership: true, deep: true },
      ]);
      if (refused) return refuse(reply, refused);
      const policy = target ? 'replace' : 'fail';
      // The copy's dead properties must fit the member's bound (#254): checked before anything is copied.
      if (method === 'COPY') checkCopyFits(db, c.user.id, from, to, !(depth === '0' && src.type === 'directory'));
      if (method === 'MOVE') {
        await c.home.move(from, to, policy); // dead properties follow in the move's transaction (PATH_TABLES)
        c.locks.removeUnder(c.user.id, from);
      } else if (depth === '0' && src.type === 'directory') {
        // Only the folder itself: the replaced item goes to the trash first, as with any replace.
        if (target) await c.home.delete([to]);
        await c.home.mkdir(to);
        copyProps(db, c.user.id, from, to, false);
      } else {
        await c.home.copy(from, to, policy);
        copyProps(db, c.user.id, from, to, true);
      }
      if (target) c.locks.removeUnder(c.user.id, to);
      return reply.status(target ? 204 : 201).send();
    }

    for (const url of ['/dav', '/dav/*']) {
      dav.route({ method: METHODS, url, exposeHeadRoute: false, config: { appPassword: true },
        handler: (req, reply) => handlers[req.method]!(req, reply) });
    }
  });
}
