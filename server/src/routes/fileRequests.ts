import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateFileRequest, LinkToken, UnlockRequest, UpdateFileRequest, type ErrorCode, type FileRequestInfo,
  type FileRequestList, type ReceivedFileList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { cookieNames } from '../auth/cookies.ts';
import { addressKey, AttemptLimiter, checkPassword, CREATIONS_PER_WINDOW, CREATIONS_WINDOW_MS, PASSWORD_PER_ITEM, PASSWORD_WINDOW_MS,
  rateLimit } from '../http/attempts.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { homeOf, ownerSource, parseSource, resolveSource } from '../storage/resolveSource.ts';
import { UPLOAD_ID, type UploadPlacement } from '../storage/local.ts';
import type { StorageBackend } from '../storage/backend.ts';
import { hashPassword, isExpired, parseExpiry, passwordStamp, verifyPassword } from '../storage/publicLinks.ts';
import { attachUpload, cleanUploader, closedCode, createRequest, discardOpenUploads, dropReservation, isVisitorsOpenUpload, markPlaced, markSeen, ownRequest,
  receivedFiles, remaining, requestByToken, requestsOf, reserveUpload, revokeRequest, sanitizeUploadName, toFileRequest,
  updateRequest, visitorUploads, type RequestRow } from '../storage/fileRequests.ts';
import { bodyStream, declaredLength, Digits, httpDate, offsetStream, parseMetadata, tus } from './uploads.ts';

const RequestId = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });
// How long an entered password holds, for this request only.
const UNLOCK_MS = 60 * 60_000;
// The visitor's metadata: the file's name and, where the request asks for it, their own. Any other key (a client's
// `path`, `onCollision`, `filename`) is ignored.
const VisitorMeta = z.object({ name: z.string().max(4096), uploader: z.string().max(1000).optional() });
const VISITOR = /^[0-9a-f]{32}$/;
// The codes a visitor may see: the request's own state and the visitor's own request (#279's rule for public links).
const VISITOR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['NOT_FOUND', 'SHARE_ORPHANED', 'LINK_EXPIRED', 'LINK_REVOKED',
  'PASSWORD_REQUIRED', 'PASSWORD_WRONG', 'TOO_MANY_ATTEMPTS', 'CSRF', 'VALIDATION', 'PRECONDITION_FAILED', 'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE', 'SIZE_MISMATCH', 'OFFSET_MISMATCH', 'UPLOAD_LOCKED', 'REQUEST_FILE_LIMIT', 'REQUEST_SIZE_LIMIT',
  'REQUEST_UPLOADS_OPEN', 'QUOTA_EXCEEDED', 'STORAGE_FULL']);

// File requests (#217): the owner's management API under /api/v1/requests (session and CSRF like every route), and the
// visitor's side under /r/<token>/…, a public route family that only ever accepts files: info, unlock and tus (creation,
// HEAD, PATCH). The SPA serves the visitor's page itself at /r/<token>.
export async function registerFileRequestRoutes(app: FastifyInstance, perIp: AttemptLimiter): Promise<void> {
  const { db, config } = app.deps;
  const cookie = cookieNames(config).request;
  const perRequest = new AttemptLimiter(PASSWORD_PER_ITEM, PASSWORD_WINDOW_MS);
  const creationsPerVisitor = new AttemptLimiter(CREATIONS_PER_WINDOW, CREATIONS_WINDOW_MS);
  const creationsPerIp = new AttemptLimiter(CREATIONS_PER_WINDOW, CREATIONS_WINDOW_MS);

  app.post('/api/v1/requests', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateFileRequest.parse(req.body);
    // Only the caller's own folders: a share received from someone else is never handed on, not even for uploads.
    if (parseSource(body.source).kind === 'share') throw new AppError('FORBIDDEN');
    const path = normalizeUserPath(body.path);
    const expiresAt = parseExpiry(body.expiresAt) ?? null;
    const { backend, access } = await resolveSource(req, body.source);
    if (access !== 'edit') throw new AppError('FORBIDDEN');
    const entry = await backend.stat(path);
    if (entry.type !== 'directory') throw new AppError('NOT_A_DIRECTORY');
    const row = createRequest(db, { ownerId: user.id, source: body.source, path: entry.path, label: body.label,
      passwordHash: body.password === null ? null : await hashPassword(body.password), expiresAt, maxFiles: body.maxFiles,
      maxBytes: body.maxBytes, askName: body.askName });
    return reply.status(201).send(toFileRequest(db, row));
  });

  app.get('/api/v1/requests', async (req): Promise<FileRequestList> => {
    const { user } = requireUser(req);
    return { items: requestsOf(db, user.id).map((r) => toFileRequest(db, r)) };
  });

  app.patch('/api/v1/requests/:id', async (req) => {
    const { user } = requireUser(req);
    const { id } = RequestId.parse(req.params);
    const body = UpdateFileRequest.parse(req.body);
    ownRequest(db, id, user.id);
    const expiresAt = parseExpiry(body.expiresAt);
    const passwordHash = body.password === undefined ? undefined : body.password === null ? null : await hashPassword(body.password);
    return toFileRequest(db, updateRequest(db, id, user.id, { label: body.label, expiresAt, passwordHash, maxFiles: body.maxFiles,
      maxBytes: body.maxBytes, askName: body.askName }));
  });

  app.delete('/api/v1/requests/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = RequestId.parse(req.params);
    revokeRequest(db, id, user.id);
    // Revoked first, so no new reservation is taken (`reserveUpload` reads it again); then the open ones stop holding the
    // owner's quota (#304). One opening right now is terminated by its own creation once attached.
    await discardOpenUploads(db, homeOf(app.deps, user.id), id);
    return reply.status(204).send();
  });

  // The owner drops the visitors' unfinished uploads and keeps the request open (#304). One receiving bytes right now
  // is left; it finishes or expires.
  app.delete('/api/v1/requests/:id/uploads', async (req, reply) => {
    const { user } = requireUser(req);
    const row = ownRequest(db, RequestId.parse(req.params).id, user.id);
    await discardOpenUploads(db, homeOf(app.deps, user.id), row.id);
    return reply.status(204).send();
  });

  app.get('/api/v1/requests/:id/files', async (req): Promise<ReceivedFileList> => {
    const { user } = requireUser(req);
    return { items: receivedFiles(db, ownRequest(db, RequestId.parse(req.params).id, user.id).id) };
  });

  app.post('/api/v1/requests/:id/seen', async (req, reply) => {
    const { user } = requireUser(req);
    markSeen(db, ownRequest(db, RequestId.parse(req.params).id, user.id).id);
    return reply.status(204).send();
  });

  // A live request: unknown tokens are NOT_FOUND; a revoked one LINK_REVOKED, a deleted folder or an unlinked connection
  // SHARE_ORPHANED, a passed expiry LINK_EXPIRED (all 410). Checked again on every request, and before a file is placed.
  function liveRequest(token: string): RequestRow {
    const row = LinkToken.safeParse(token).success ? requestByToken(db, token) : undefined;
    if (!row) throw new AppError('NOT_FOUND');
    if (row.revoked_at !== null) throw new AppError('LINK_REVOKED');
    if (row.orphaned_at !== null) throw new AppError('SHARE_ORPHANED');
    if (isExpired(row)) throw new AppError('LINK_EXPIRED');
    return row;
  }

  // The visitor cookie: `<request id>.<visitor id>.<password stamp>.<unlocked until>`, signed. The visitor id is random
  // per browser session; the last two parts are empty until the password is entered.
  type Visit = { visitor: string; unlockedUntil: number };
  function visitOf(req: FastifyRequest, row: RequestRow): Visit | undefined {
    const raw = req.cookies[cookie];
    if (!raw) return undefined;
    const c = req.unsignCookie(raw);
    if (!c.valid || c.value === null) return undefined;
    const [id, visitor, stamp, until] = c.value.split('.');
    if (id !== row.id || !visitor || !VISITOR.test(visitor)) return undefined;
    return { visitor, unlockedUntil: stamp === passwordStamp(row) ? Number(until) : 0 };
  }
  function setVisit(reply: FastifyReply, row: RequestRow, v: Visit): void {
    const unlock = v.unlockedUntil > 0 ? `${passwordStamp(row)}.${v.unlockedUntil}` : '.';
    reply.setCookie(cookie, `${row.id}.${v.visitor}.${unlock}`, { signed: true, httpOnly: true, sameSite: 'strict',
      path: `/r/${row.token}/`, secure: cookieNames(config).prefixed });
  }
  /** The visitor's session, minted on the first request that has none. */
  function visit(req: FastifyRequest, reply: FastifyReply, row: RequestRow): Visit {
    const known = visitOf(req, row);
    if (known) return known;
    const v = { visitor: randomBytes(16).toString('hex'), unlockedUntil: 0 };
    setVisit(reply, row, v);
    return v;
  }
  const unlocked = (row: RequestRow, v: Visit | undefined) => row.password_hash === null || (v !== undefined && v.unlockedUntil > Date.now());
  // No session here, but mutating requests still only from the request's page: another site cannot upload through a
  // visitor's browser or make it guess passwords.
  const sameOrigin = (req: FastifyRequest) => { if (req.headers.origin !== config.publicUrl.origin) throw new AppError('CSRF'); };

  function info(req: FastifyRequest, reply: FastifyReply, row: RequestRow): FileRequestInfo {
    const v = visit(req, reply, row);
    if (!unlocked(row, v)) return { label: row.label, locked: true };
    return { label: row.label, locked: false, askName: row.ask_name === 1, expiresAt: row.expires_at, ...remaining(db, row, v.visitor),
      uploads: visitorUploads(db, row.id, v.visitor) };
  }

  async function unlock(req: FastifyRequest, reply: FastifyReply, row: RequestRow) {
    sameOrigin(req);
    const { password } = UnlockRequest.parse(req.body);
    const v = visit(req, reply, row);
    const hash = row.password_hash;
    if (hash === null) return reply.status(204).send();
    await checkPassword(reply, [[perRequest, `request:${row.id}`], [perIp, `ip:${req.ip}`]], () => verifyPassword(hash, password));
    setVisit(reply, row, { ...v, unlockedUntil: Date.now() + UNLOCK_MS });
    return reply.status(204).send();
  }

  // A visitor whose session may upload: the right origin, unlocked, with a visitor id.
  function uploader(req: FastifyRequest, reply: FastifyReply, row: RequestRow): Visit {
    sameOrigin(req);
    const v = visitOf(req, row);
    if (!unlocked(row, v)) throw new AppError('PASSWORD_REQUIRED');
    return v ?? visit(req, reply, row);
  }

  // tus creation. The file and size limits and the quota (the owner's home, which stages the bytes, and a cloud
  // provider's free space) are checked before a byte is accepted; the name is sanitised and the collision policy is
  // always keep-both.
  async function createUpload(req: FastifyRequest, reply: FastifyReply, row: RequestRow) {
    const v = uploader(req, reply, row);
    // Every attempt counts, a refused one too: creation is what the file caps guard, so it cannot be hammered (#401).
    rateLimit(reply, [[creationsPerVisitor, `visitor:${row.id}:${v.visitor}`], [creationsPerIp, `ip:${addressKey(req.ip)}`]]);
    if (req.headers['upload-defer-length'] !== undefined) throw new AppError('VALIDATION');
    const h = z.object({ 'upload-length': Digits, 'upload-metadata': z.string().min(1) }).parse(req.headers);
    const length = h['upload-length'];
    const m = VisitorMeta.parse(parseMetadata(h['upload-metadata']));
    if (length > config.maxUploadBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const name = sanitizeUploadName(m.name);
    const target = await ownerSource(app.deps, row);
    if (row.source !== 'home') {
      // The folder must still be there: a provider creates missing folders on upload, so a folder deleted or renamed
      // at the provider would be created anew in the owner's account (#418).
      await requireFolder(target, row.path);
      const q = await target.quota?.();
      if (q?.total !== undefined && length > q.total - q.used) throw new AppError('QUOTA_EXCEEDED');
    }
    const reservation = reserveUpload(db, row, { visitor: v.visitor, name, length,
      uploader: row.ask_name === 1 ? cleanUploader(m.uploader) : null });
    const home = homeOf(app.deps, row.owner_id);
    let id: string;
    try {
      const u = await home.createUpload({ source: row.source, path: childPath(row.path, name), length,
        onCollision: 'keep-both', maxBytes: config.maxUploadBytes, visitor: true });
      id = u.id;
      attachUpload(db, reservation, id);
      reply.header('upload-expires', httpDate(u.expiresAt));
    } catch (e) {
      dropReservation(db, reservation);
      throw e;
    }
    // Revoked while the upload opened: a revocation's discard may have run before it was attached, so it goes here (#304).
    const closed = closedCode(db, row.id);
    if (closed) {
      await home.terminateUpload(id).catch((e: unknown) => {
        if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e; // handled: the revocation's discard got it first
      });
      db.prepare('DELETE FROM file_request_uploads WHERE id = ?').run(reservation);
      throw new AppError(closed);
    }
    return reply.status(201).header('location', `/r/${row.token}/uploads/${id}`).header('upload-offset', 0).send();
  }

  // Only the visitor's own upload in progress; anyone else's, a finished one and an unknown id all look the same.
  function ownUpload(req: FastifyRequest, reply: FastifyReply, row: RequestRow, id: string): void {
    const v = uploader(req, reply, row);
    if (!UPLOAD_ID.test(id) || !isVisitorsOpenUpload(db, row.id, v.visitor, id)) throw new AppError('NOT_FOUND');
  }

  function uploadState(req: FastifyRequest, reply: FastifyReply, row: RequestRow, id: string) {
    const v = visitOf(req, row);
    if (!unlocked(row, v) || !v || !UPLOAD_ID.test(id) || !isVisitorsOpenUpload(db, row.id, v.visitor, id)) throw new AppError('NOT_FOUND');
    const s = homeOf(app.deps, row.owner_id).uploadState(id);
    return reply.status(200).header('upload-offset', s.offset).header('upload-length', s.length)
      .header('upload-expires', httpDate(s.expiresAt)).header('cache-control', 'no-store').send();
  }

  // PATCH: the bytes go to the owner's staging area; once complete, the file is placed in the target folder as it is
  // then (a moved folder, a request revoked meanwhile), always keep-both.
  async function append(req: FastifyRequest, reply: FastifyReply, row: RequestRow, id: string) {
    ownUpload(req, reply, row, id);
    const h = z.object({ 'upload-offset': Digits }).parse(req.headers);
    const placement = async (): Promise<UploadPlacement> => {
      const live = liveRequest(row.token);
      const placed = (name: string) => markPlaced(db, id, name);
      // The name was sanitised at creation; the folder is the request's folder now.
      const path = childPath(live.path, nameOf(id));
      if (live.source === 'home') return { path, placed };
      const backend = await ownerSource(app.deps, live);
      return { placed, write: async (body, length) => {
        await requireFolder(backend, live.path);
        return backend.write(path, body, { onCollision: 'keep-both', maxBytes: config.maxUploadBytes, size: length });
      } };
    };
    const s = await homeOf(app.deps, row.owner_id).appendUpload(id, h['upload-offset'], bodyStream(req), declaredLength(req), placement)
      .catch((e: unknown) => {
        if (!req.raw.complete) reply.header('connection', 'close'); // refused or cut off before the body was read: stop draining it
        throw e;
      });
    return reply.status(204).header('upload-offset', s.offset).header('upload-expires', httpDate(s.expiresAt)).send();
  }
  const nameOf = (uploadId: string) =>
    db.prepare('SELECT name FROM file_request_uploads WHERE upload_id = ?').pluck().get(uploadId) as string;

  // #279's rule: what the owner's source says about its own state is the owner's business. The visitor gets only the
  // request's own answers; anything else is LINK_UNAVAILABLE, and the real code goes to the log with the request's id.
  function forVisitor(req: FastifyRequest, token: string, e: unknown): unknown {
    if (!(e instanceof AppError) || VISITOR_CODES.has(e.code)) return e;
    const row = LinkToken.safeParse(token).success ? requestByToken(db, token) : undefined;
    req.log.warn({ request: row?.id, code: e.code }, 'file request target failed');
    return new AppError('LINK_UNAVAILABLE', undefined, { cause: e });
  }

  app.route({
    method: ['GET', 'HEAD', 'POST', 'PATCH'], url: '/r/:token/*',
    exposeHeadRoute: false,
    // Public (spec §2.3, #217): visitors of a file request have no session. The token (128 random bits), the password,
    // the expiry, the revocation and the file and size limits are the guard, checked on every request in the handler.
    // It never lists the folder or serves a byte of it.
    config: { public: true },
    onRequest: async (req, reply) => {
      const rest = (req.params as { '*'?: string })['*'] ?? '';
      if (rest.startsWith('uploads') && req.method !== 'GET') await tus(req, reply);
      if (req.method === 'PATCH') await offsetStream(req, reply);
    },
    handler: async (req, reply) => {
      const p = z.object({ token: z.string(), '*': z.string() }).parse(req.params);
      const upload = /^uploads\/([0-9a-f]{32})$/.exec(p['*']);
      const op = upload ? `${req.method} uploads/:id` : `${req.method} ${p['*']}`;
      try {
        const row = liveRequest(p.token);
        switch (op) {
          case 'GET info': return info(req, reply, row);
          case 'POST unlock': return await unlock(req, reply, row);
          case 'POST uploads': return await createUpload(req, reply, row);
          case 'HEAD uploads/:id': return uploadState(req, reply, row, upload![1]!);
          case 'PATCH uploads/:id': return await append(req, reply, row, upload![1]!);
          default: throw new AppError('NOT_FOUND');
        }
      } catch (caught) {
        throw forVisitor(req, p.token, caught);
      }
    },
  });
}

const childPath = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`;
// The request's cloud folder is still a folder (#418); a missing one is NOT_FOUND from the backend's stat.
async function requireFolder(backend: StorageBackend, path: string): Promise<void> {
  if ((await backend.stat(path)).type !== 'directory') throw new AppError('NOT_FOUND');
}
