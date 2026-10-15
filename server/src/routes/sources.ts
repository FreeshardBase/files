import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { CollisionPolicy } from '@files/shared';
import { AppError } from '../errors.ts';
import { RangeNotSatisfiable, type StorageBackend } from '../storage/backend.ts';
import { resolveSource, type Access } from '../storage/resolveSource.ts';
import { parseRange } from '../http/range.ts';

// Allowlist, not denylist: anything not known to be inert in a browser is downloaded, never rendered.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const inlineSafe = (mime: string): boolean => {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return INLINE.has(base) || base.startsWith('video/') || base.startsWith('audio/');
};
const CONTENT_CSP = "sandbox; default-src 'none'";
const PathQ = z.object({ path: z.string().min(1) });

// First thing in every handler: resolve the source and check the access the route needs, before any input is read.
async function backendFor(req: FastifyRequest, need: Access): Promise<StorageBackend> {
  const { source } = z.object({ source: z.string() }).parse(req.params);
  const resolved = await resolveSource(req, source);
  if (need === 'edit' && resolved.access !== 'edit') throw new AppError('FORBIDDEN');
  return resolved.backend;
}

const disposition = (kind: 'inline' | 'attachment', name: string) => {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // RFC 5987 attr-char excludes ' ( ) * ! which encodeURIComponent leaves alone.
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/api/v1/sources/:source/list', async (req) => {
    const b = await backendFor(req, 'read');
    const q = z.object({
      path: z.string().min(1), cursor: z.string().optional(), limit: z.coerce.number().int().optional(),
    }).parse(req.query);
    return b.list(q.path, q.cursor, q.limit);
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
    const r = await b.read(q.path, (size) => {
      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') throw new RangeNotSatisfiable(size);
      return range;
    }).catch((e: unknown) => {
      if (e instanceof RangeNotSatisfiable) reply.header('content-range', `bytes */${e.size}`);
      throw e;
    });
    const mime = r.entry.mime ?? 'application/octet-stream';
    const kind = q.download || !inlineSafe(mime) ? 'attachment' : 'inline';
    reply.header('content-type', mime).header('etag', r.etag).header('accept-ranges', 'bytes')
      .header('content-disposition', disposition(kind, r.entry.name)).header('cache-control', 'private, no-cache').header('content-security-policy', CONTENT_CSP);
    if (r.range) {
      reply.status(206).header('content-range', `bytes ${r.range.start}-${r.range.end}/${r.entry.size}`)
        .header('content-length', r.range.end - r.range.start + 1);
    } else {
      reply.header('content-length', r.entry.size);
    }
    return reply.send(r.stream);
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
      ...(Number.isSafeInteger(declared) ? { size: declared } : {}), ...(h['if-match'] ? { ifMatch: h['if-match'] } : {}) });
    return reply.status(201).send(entry);
  });

  app.post('/api/v1/sources/:source/mkdir', async (req, reply) => {
    const b = await backendFor(req, 'edit');
    const body = PathQ.parse(req.body);
    return reply.status(201).send(await b.mkdir(body.path));
  });
}
