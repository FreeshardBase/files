import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateLinkRequest, LinkToken, UnlockRequest, UpdateLinkRequest, type PublicLinkInfo, type PublicLinkList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { cookieNames } from '../auth/cookies.ts';
import { AttemptLimiter } from '../http/attempts.ts';
import { readRanged, sendContent } from '../http/content.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { ownerSource, parseSource, resolveSource } from '../storage/resolveSource.ts';
import { ShareBackend } from '../storage/shares.ts';
import { createLink, hashPassword, isExpired, linkByToken, linksOf, ownLink, parseExpiry, passwordStamp, removeLink,
  takeDownload, toPublicLink, updateLink, verifyPassword, type LinkRow } from '../storage/publicLinks.ts';

const LinkId = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });
// Wrong passwords: 5 per link and 20 per address within 15 minutes, then 429 until the window ends (#104).
const WINDOW_MS = 15 * 60_000;
const PER_LINK = 5;
const PER_IP = 20;
// How long an entered password holds, for this link only.
const UNLOCK_MS = 60 * 60_000;

// Public links (#147): the owner's management API under /api/v1/links (session and CSRF like every route), and the
// visitor's side under /s/<token>/…, the one public route family. The SPA serves the share page itself at /s/<token>.
export async function registerLinkRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const cookie = cookieNames(config).link;
  const perLink = new AttemptLimiter(PER_LINK, WINDOW_MS);
  const perIp = new AttemptLimiter(PER_IP, WINDOW_MS);

  app.post('/api/v1/links', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateLinkRequest.parse(req.body);
    // Only the caller's own items: a share is never passed on, not even as a link.
    if (parseSource(body.source).kind === 'share') throw new AppError('FORBIDDEN');
    const path = normalizeUserPath(body.path);
    if (path === '/') throw new AppError('PATH_INVALID');
    const expiresAt = parseExpiry(body.expiresAt) ?? null;
    const { backend } = await resolveSource(req, body.source);
    const entry = await backend.stat(path);
    const row = createLink(db, { ownerId: user.id, source: body.source, path: entry.path, type: entry.type, label: body.label,
      passwordHash: body.password === null ? null : await hashPassword(body.password), expiresAt, maxDownloads: body.maxDownloads });
    return reply.status(201).send(toPublicLink(row));
  });

  app.get('/api/v1/links', async (req): Promise<PublicLinkList> => {
    const { user } = requireUser(req);
    const q = z.object({ source: z.string().min(1), path: z.string().min(1) }).parse(req.query);
    return { items: linksOf(db, user.id, q.source, normalizeUserPath(q.path)).map(toPublicLink) };
  });

  app.patch('/api/v1/links/:id', async (req) => {
    const { user } = requireUser(req);
    const { id } = LinkId.parse(req.params);
    const body = UpdateLinkRequest.parse(req.body);
    ownLink(db, id, user.id);
    const expiresAt = parseExpiry(body.expiresAt);
    const passwordHash = body.password === undefined ? undefined : body.password === null ? null : await hashPassword(body.password);
    return toPublicLink(updateLink(db, id, user.id, { ...(body.label !== undefined ? { label: body.label } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}), ...(passwordHash !== undefined ? { passwordHash } : {}),
      ...(body.maxDownloads !== undefined ? { maxDownloads: body.maxDownloads } : {}) }));
  });

  app.delete('/api/v1/links/:id', async (req, reply) => {
    const { user } = requireUser(req);
    removeLink(db, LinkId.parse(req.params).id, user.id);
    return reply.status(204).send();
  });

  // A live link: unknown and revoked tokens are NOT_FOUND, a deleted item or an unlinked connection SHARE_ORPHANED (it
  // never falls back to another source, #95), a passed expiry LINK_EXPIRED. Checked again on every request.
  function liveLink(token: string): LinkRow {
    const row = LinkToken.safeParse(token).success ? linkByToken(db, token) : undefined;
    if (!row) throw new AppError('NOT_FOUND');
    if (row.orphaned_at !== null) throw new AppError('SHARE_ORPHANED');
    if (isExpired(row)) throw new AppError('LINK_EXPIRED');
    return row;
  }
  // The visitor's view: `/` is the linked item, every path lies beneath it (the same confinement as an internal share).
  const backendOf = async (row: LinkRow) => new ShareBackend(await ownerSource(app.deps, row), row.path, row.type);

  const unlockValue = (row: LinkRow, until: number) => `${row.id}.${passwordStamp(row)}.${until}`;
  function unlocked(req: FastifyRequest, row: LinkRow): boolean {
    if (row.password_hash === null) return true;
    const raw = req.cookies[cookie];
    if (!raw) return false;
    const c = req.unsignCookie(raw);
    if (!c.valid || c.value === null) return false;
    const [id, stamp, until] = c.value.split('.');
    return id === row.id && stamp === passwordStamp(row) && Number(until) > Date.now();
  }
  const requireUnlocked = (req: FastifyRequest, row: LinkRow) => { if (!unlocked(req, row)) throw new AppError('PASSWORD_REQUIRED'); };

  async function info(req: FastifyRequest, row: LinkRow): Promise<PublicLinkInfo> {
    const b = await backendOf(row);
    if (!unlocked(req, row)) return { name: row.path.slice(row.path.lastIndexOf('/') + 1), type: row.type, locked: true };
    const e = await b.stat('/');
    return { name: e.name, type: e.type, locked: false, size: e.size, ...(e.mime ? { mime: e.mime } : {}), expiresAt: row.expires_at,
      downloadsLeft: row.max_downloads === null ? null : Math.max(0, row.max_downloads - row.downloads) };
  }

  async function unlock(req: FastifyRequest, reply: FastifyReply, row: LinkRow) {
    // No session here, but still only from the share page: another site cannot make a visitor's browser guess.
    if (req.headers.origin !== config.publicUrl.origin) throw new AppError('CSRF');
    const { password } = UnlockRequest.parse(req.body);
    await backendOf(row);
    if (row.password_hash === null) return reply.status(204).send();
    const keys = [`link:${row.id}`, `ip:${req.ip}`] as const;
    const wait = Math.max(perLink.blockedFor(keys[0]), perIp.blockedFor(keys[1]));
    if (wait > 0) { reply.header('retry-after', String(wait)); throw new AppError('TOO_MANY_ATTEMPTS'); }
    // Reserved before the first await, so parallel guesses see this one as counted (#196). A check that throws counts
    // as a failure.
    perLink.begin(keys[0]); perIp.begin(keys[1]);
    let right = false;
    try { right = await verifyPassword(row.password_hash, password); }
    finally { perLink.end(keys[0], !right); perIp.end(keys[1], !right); }
    if (!right) throw new AppError('PASSWORD_WRONG');
    const until = Date.now() + UNLOCK_MS;
    reply.setCookie(cookie, unlockValue(row, until), { signed: true, httpOnly: true, sameSite: 'strict', path: `/s/${row.token}/`,
      secure: cookieNames(config).prefixed, maxAge: UNLOCK_MS / 1000 });
    return reply.status(204).send();
  }

  async function list(req: FastifyRequest, row: LinkRow) {
    requireUnlocked(req, row);
    const q = z.object({ path: z.string().min(1).default('/'), cursor: z.string().optional() }).parse(req.query);
    return (await backendOf(row)).list(q.path, q.cursor);
  }

  // Every byte-serving answer counts against the limit, whatever the query (`inline`, a Range, anything): a preview is a
  // download (#104). The file is opened first, so a missing file or an unsatisfiable range costs nothing.
  async function content(req: FastifyRequest, reply: FastifyReply, row: LinkRow) {
    requireUnlocked(req, row);
    const q = z.object({ path: z.string().min(1).default('/'), inline: z.string().optional() }).parse(req.query);
    const r = await readRanged(await backendOf(row), q.path, req, reply);
    if (!takeDownload(db, row.id)) {
      r.stream.destroy();
      throw new AppError('DOWNLOAD_LIMIT_REACHED');
    }
    return sendContent(reply, r, q.inline !== undefined, 'private, no-store');
  }

  app.route({
    method: ['GET', 'POST'], url: '/s/:token/*',
    // Not derived from GET: a HEAD would run the handler and count as a download without serving a byte.
    exposeHeadRoute: false,
    // Public (spec §3.1): visitors of a public link have no session. The token (128 random bits), the password, the
    // expiry and the download limit are the guard, checked on every request in the handler.
    config: { public: true },
    handler: async (req, reply) => {
      const p = z.object({ token: z.string(), '*': z.string() }).parse(req.params);
      const op = `${req.method} ${p['*']}`;
      try {
        const row = liveLink(p.token);
        switch (op) {
          case 'GET info': return await info(req, row);
          case 'POST unlock': return await unlock(req, reply, row);
          case 'GET list': return await list(req, row);
          case 'GET content': return await content(req, reply, row);
          default: throw new AppError('NOT_FOUND');
        }
      } catch (e) {
        // handled: a download link the browser navigated to gets the share page with the error, not a JSON body.
        if (op === 'GET content' && e instanceof AppError && req.headers['sec-fetch-mode'] === 'navigate'
          && LinkToken.safeParse(p.token).success) {
          return reply.redirect(`/s/${p.token}?error=${e.code}`, 303);
        }
        throw e;
      }
    },
  });
}
