import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { CollisionPolicy } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { LocalBackend, homeRoot } from '../storage/local.ts';
import type { StorageBackend } from '../storage/backend.ts';
import { parseRange } from '../http/range.ts';

const ACTIVE = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml']);
const PathQ = z.object({ path: z.string().min(1) });

function backendFor(app: FastifyInstance, req: FastifyRequest): StorageBackend {
  const { source } = z.object({ source: z.string() }).parse(req.params);
  if (source !== 'home') throw new AppError('NOT_FOUND');
  return new LocalBackend(homeRoot(app.deps.config.dataDir, requireUser(req).user.id));
}

const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`;

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
    const r = await b.read(q.path, range);
    const kind = q.download || ACTIVE.has(r.mime) ? 'attachment' : 'inline';
    reply.header('content-type', r.mime).header('etag', r.etag).header('accept-ranges', 'bytes')
      .header('content-disposition', disposition(kind, entry.name)).header('cache-control', 'private, no-cache');
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${r.size}`)
        .header('content-length', range.end - range.start + 1);
    } else {
      reply.header('content-length', r.size);
    }
    return reply.send(r.stream);
  });

  app.put('/api/v1/sources/:source/content', { bodyLimit: app.deps.config.maxUploadBytes }, async (req, reply) => {
    // Other content types run through Fastify's default parsers and would not yield a stream.
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/octet-stream')) {
      throw Object.assign(new Error('unsupported media type'), { statusCode: 415 });
    }
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
