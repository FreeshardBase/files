import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { CollisionPolicy } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { LocalBackend, homeRoot } from '../storage/local.ts';
import type { StorageBackend } from '../storage/backend.ts';
import { parseRange } from '../http/range.ts';

// Allowlist, not denylist: anything not known to be inert in a browser is downloaded, never rendered.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const inlineSafe = (mime: string): boolean => {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return INLINE.has(base) || base.startsWith('video/') || base.startsWith('audio/');
};
const CONTENT_CSP = "sandbox; default-src 'none'";
const PathQ = z.object({ path: z.string().min(1) });

function backendFor(app: FastifyInstance, req: FastifyRequest): StorageBackend {
  const { source } = z.object({ source: z.string() }).parse(req.params);
  if (source !== 'home') throw new AppError('NOT_FOUND');
  return new LocalBackend(homeRoot(app.deps.config.dataDir, requireUser(req).user.id));
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
    const q = z.object({
      path: z.string().min(1), cursor: z.string().optional(), limit: z.coerce.number().int().optional(),
    }).parse(req.query);
    return backendFor(app, req).list(q.path, q.cursor, q.limit);
  });

  app.get('/api/v1/sources/:source/stat', async (req) => backendFor(app, req).stat(PathQ.parse(req.query).path));

  // Fastify derives HEAD from GET: the body is dropped and the stream destroyed by reply.send.
  app.get('/api/v1/sources/:source/content', async (req, reply) => {
    const q = z.object({ path: z.string().min(1), download: z.literal('1').optional() }).parse(req.query);
    const b = backendFor(app, req);
    const entry = await b.stat(q.path);
    if (entry.type === 'directory') throw new AppError('IS_A_DIRECTORY');
    const range = parseRange(req.headers.range, entry.size);
    if (range === 'unsatisfiable') {
      reply.header('content-range', `bytes */${entry.size}`);
      throw new AppError('RANGE_NOT_SATISFIABLE');
    }
    const r = await b.read(q.path, range).catch(async (e: unknown) => {
      if (e instanceof AppError && e.code === 'RANGE_NOT_SATISFIABLE') {
        // File changed between stat and read: report its current size, not the stale one.
        reply.header('content-range', `bytes */${(await b.stat(q.path)).size}`);
      }
      throw e;
    });
    const kind = q.download || !inlineSafe(r.mime) ? 'attachment' : 'inline';
    reply.header('content-type', r.mime).header('etag', r.etag).header('accept-ranges', 'bytes')
      .header('content-disposition', disposition(kind, entry.name)).header('cache-control', 'private, no-cache').header('content-security-policy', CONTENT_CSP);
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${r.size}`)
        .header('content-length', range.end - range.start + 1);
    } else {
      reply.header('content-length', r.size);
    }
    return reply.send(r.stream);
  });

  // The gate runs in onRequest, before any content-type parser: otherwise JSON/text bodies would be
  // buffered up to the body limit first. No route bodyLimit: Fastify only enforces it in its built-in
  // buffering parsers, never for our raw-stream parser; the size cap is the declared-length check
  // below plus maxBytes in the backend write.
  const requireOctetStream = async (req: FastifyRequest) => {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/octet-stream')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    }
  };
  app.put('/api/v1/sources/:source/content', { onRequest: requireOctetStream }, async (req, reply) => {
    const q = z.object({ path: z.string().min(1), onCollision: CollisionPolicy }).parse(req.query);
    const max = app.deps.config.maxUploadBytes;
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new AppError('PAYLOAD_TOO_LARGE');
    const entry = await backendFor(app, req).write(q.path, req.body as Readable, { onCollision: q.onCollision, maxBytes: max });
    return reply.status(201).send(entry);
  });

  app.post('/api/v1/sources/:source/mkdir', async (req, reply) => {
    const body = PathQ.parse(req.body);
    return reply.status(201).send(await backendFor(app, req).mkdir(body.path));
  });
}
