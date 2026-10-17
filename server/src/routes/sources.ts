import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import { CollisionPolicy, DeleteRequest, THUMB_SIZES, TransferRequest, type ListResponse, type ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import type { StorageBackend } from '../storage/backend.ts';
import { resolveSource, type Access } from '../storage/resolveSource.ts';
import { CONTENT_CSP, disposition, readRanged, sendContent } from '../http/content.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { zipStream, type ZipRoot } from '../storage/zip.ts';
import { deleteFavourites, moveFavourites } from '../storage/favourites.ts';
import { deleteTags, moveTags } from '../storage/tags.ts';
import { deleteComments, keysOf, moveComments } from '../storage/comments.ts';
import { requireUser } from '../auth/guard.ts';

const PathQ = z.object({ path: z.string().min(1) });
const MAX_ZIP_PATHS = 1000;
const ThumbQ = z.object({ path: z.string().min(1),
  size: z.coerce.number().refine((n): n is ThumbSize => (THUMB_SIZES as readonly number[]).includes(n)) });
// `path` once for a folder or a file, repeated for a selection (the querystring parser makes that an array).
const ZipQ = z.object({ path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_ZIP_PATHS)]) });

// First thing in every handler: resolve the source and check the access the route needs, before any input is read.
async function resolvedFor(req: FastifyRequest, need: Access) {
  const { source } = z.object({ source: z.string() }).parse(req.params);
  const resolved = await resolveSource(req, source);
  if (need === 'edit' && resolved.access !== 'edit') throw new AppError('FORBIDDEN');
  return resolved;
}
const backendFor = async (req: FastifyRequest, need: Access): Promise<StorageBackend> => (await resolvedFor(req, need)).backend;

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // The listing carries the caller's access, so the SPA offers changes in a read share not at all (#146).
  app.get('/api/v1/sources/:source/list', async (req): Promise<ListResponse> => {
    const { backend, access } = await resolvedFor(req, 'read');
    const q = z.object({
      path: z.string().min(1), cursor: z.string().optional(), limit: z.coerce.number().int().optional(),
    }).parse(req.query);
    return { ...await backend.list(q.path, q.cursor, q.limit), access };
  });

  app.get('/api/v1/sources/:source/stat', async (req) => {
    const b = await backendFor(req, 'read');
    return b.stat(PathQ.parse(req.query).path);
  });

  // Fastify derives HEAD from GET: the body is dropped and the stream destroyed by reply.send.
  // One backend read: the Range is resolved against the size of the file actually opened.
  app.get('/api/v1/sources/:source/content', async (req, reply) => {
    const b = await backendFor(req, 'read');
    const q = z.object({ path: z.string().min(1), download: z.literal('1').optional() }).parse(req.query);
    const r = await readRanged(b, q.path, req, reply);
    return sendContent(reply, r, !q.download, 'private, no-cache');
  });

  // A small WebP of an image, a video frame or a PDF's first page (#144). The SPA adds the file's modified time as `v`,
  // so a changed file gets a new URL and the browser may keep this one for a day.
  app.get('/api/v1/sources/:source/thumbnail', async (req, reply) => {
    const b = await backendFor(req, 'read');
    const q = ThumbQ.parse(req.query);
    const stream = b.thumbnail ? await b.thumbnail(q.path, q.size) : null;
    if (!stream) throw new AppError('NO_THUMBNAIL');
    reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', CONTENT_CSP);
    return reply.send(stream);
  });

  // A folder or a selection in one folder, streamed as a ZIP while it is read (spec §2.1 Transfer, #139). Everything
  // that can be refused is checked before the first byte; after that an error aborts the response (see zipStream).
  app.get('/api/v1/sources/:source/zip', async (req, reply) => {
    const b = await backendFor(req, 'read');
    const q = ZipQ.parse(req.query);
    const all = [...new Set((Array.isArray(q.path) ? q.path : [q.path]).map(normalizeUserPath))];
    // An item beneath another selected one comes with it; whatever is left must share one folder.
    const top = all.includes('/') ? ['/'] : all.filter((p) => !all.some((o) => p.startsWith(o + '/')));
    const parents = new Set(top.map((p) => posix.dirname(p)));
    if (parents.size !== 1) throw new AppError('VALIDATION');
    const roots: ZipRoot[] = [];
    for (const p of top) {
      const entry = await b.stat(p);
      if (p !== '/') { roots.push({ name: entry.name, entry }); continue; }
      // The whole source: its children sit at the top of the archive.
      let cursor: string | undefined;
      do {
        const page = await b.list('/', cursor, MAX_ZIP_PATHS);
        for (const e of page.entries) roots.push({ name: e.name, entry: e });
        cursor = page.next;
      } while (cursor);
    }
    const parent = [...parents][0]!;
    const archive = top[0] === '/' ? 'files' : top.length === 1 ? roots[0]!.name : parent === '/' ? 'files' : posix.basename(parent);
    reply.header('content-type', 'application/zip').header('content-disposition', disposition('attachment', `${archive}.zip`))
      .header('cache-control', 'private, no-store').header('content-security-policy', CONTENT_CSP);
    return reply.send(Readable.from(zipStream(b, roots), { objectMode: false }));
  });

  // The gate runs in onRequest, before any content-type parser: otherwise JSON/text bodies would be
  // buffered up to the body limit first. No route bodyLimit: Fastify only enforces it in its built-in
  // buffering parsers, never for our raw-stream parser; the size cap is the declared-length check
  // below plus maxBytes in the backend write.
  // Early rejections send `connection: close` so Node stops draining the unread upload body.
  const requireOctetStream = async (req: FastifyRequest, reply: FastifyReply) => {
    const base = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (base !== 'application/octet-stream') {
      reply.header('connection', 'close');
      throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    }
  };
  app.put('/api/v1/sources/:source/content', { onRequest: requireOctetStream }, async (req, reply) => {
    const b = await backendFor(req, 'edit');
    const q = z.object({ path: z.string().min(1), onCollision: CollisionPolicy }).parse(req.query);
    const h = z.object({ 'if-match': z.string().min(1).optional() }).parse(req.headers);
    const max = app.deps.config.maxUploadBytes;
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      reply.header('connection', 'close');
      throw new AppError('PAYLOAD_TOO_LARGE');
    }
    const entry = await b.write(q.path, req.body as Readable, { onCollision: q.onCollision, maxBytes: max,
      ...(Number.isSafeInteger(declared) ? { size: declared } : {}), ...(h['if-match'] ? { ifMatch: h['if-match'] } : {}) })
      .catch((e: unknown) => {
        if (!req.raw.complete) reply.header('connection', 'close'); // rejected before the body was read (e.g. FILE_EXISTS): stop draining it
        throw e;
      });
    return reply.status(201).send(entry);
  });

  app.post('/api/v1/sources/:source/mkdir', async (req, reply) => {
    const b = await backendFor(req, 'edit');
    const body = PathQ.parse(req.body);
    return reply.status(201).send(await b.mkdir(body.path));
  });

  // Rename is a move within the same folder. In the home the caller's favourites and tags follow inside the move's
  // transaction (PATH_TABLES); in another source the provider has no transaction, so they follow once the move is done
  // (#155, #212). Comment threads (#213) hang off the owner's item: in the owner's home (also through a share) they are
  // in PATH_TABLES, in a cloud they follow here, also when a grantee moves inside a share.
  app.post('/api/v1/sources/:source/move', async (req) => {
    const { source } = z.object({ source: z.string() }).parse(req.params);
    const b = await backendFor(req, 'edit');
    const body = TransferRequest.parse(req.body);
    const userId = requireUser(req).user.id;
    const keyOf = keysOf(app.deps.db, userId, source);
    const entry = await b.move(body.from, body.to, body.onCollision);
    const from = normalizeUserPath(body.from);
    moveComments(app.deps.db, keyOf(from), keyOf(entry.path));
    if (source !== 'home') {
      moveFavourites(app.deps.db, userId, source, from, entry.path);
      moveTags(app.deps.db, userId, source, from, entry.path);
    }
    return entry;
  });

  app.post('/api/v1/sources/:source/copy', async (req, reply) => {
    const b = await backendFor(req, 'edit');
    const body = TransferRequest.parse(req.body);
    return reply.status(201).send(await b.copy(body.from, body.to, body.onCollision));
  });

  // Moves every path to the trash in one transaction: all or nothing. Favourites and tags go as with a move (#155, #212);
  // in the home the tags wait in the trash with their item. So do comment threads in the owner's home; a cloud's are
  // deleted with the item (#213).
  app.post('/api/v1/sources/:source/delete', async (req, reply) => {
    const { source } = z.object({ source: z.string() }).parse(req.params);
    const b = await backendFor(req, 'edit');
    const body = DeleteRequest.parse(req.body);
    const userId = requireUser(req).user.id;
    const keyOf = keysOf(app.deps.db, userId, source);
    await b.delete(body.paths);
    const paths = body.paths.map(normalizeUserPath);
    deleteComments(app.deps.db, paths.map(keyOf));
    if (source !== 'home') {
      deleteFavourites(app.deps.db, userId, source, paths);
      deleteTags(app.deps.db, userId, source, paths);
    }
    return reply.status(204).send();
  });
}
