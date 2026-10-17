import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { CollisionPolicy, type OpenUploadList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { homeBackend, resolveSource } from '../storage/resolveSource.ts';
import { LocalBackend, UPLOAD_ID } from '../storage/local.ts';

// tus 1.0 (https://tus.io/protocols/resumable-upload) with the creation, termination and expiration extensions
// (spec §2.1 Transfer, #140). Upload ids are scoped to the member: another member's id answers 404 like an unknown one.
const TUS_VERSION = '1.0.0';
const OFFSET_TYPE = 'application/offset+octet-stream';
export const Digits = z.string().regex(/^\d{1,16}$/).transform(Number).refine(Number.isSafeInteger);
const UploadMeta = z.object({ source: z.string().min(1), path: z.string().min(1), onCollision: CollisionPolicy.default('fail') });

export const httpDate = (iso: string) => new Date(iso).toUTCString();

/** Every tus request carries `Tus-Resumable: 1.0.0`, and so does every answer. Also used by file requests (#217). */
export const tus = async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header('tus-resumable', TUS_VERSION);
  if (req.headers['tus-resumable'] !== TUS_VERSION) {
    reply.header('tus-version', TUS_VERSION).header('connection', 'close');
    throw new AppError('PRECONDITION_FAILED');
  }
};
/** A PATCH body is `application/offset+octet-stream`, checked before any parser runs. */
export const offsetStream = async (req: FastifyRequest, reply: FastifyReply) => {
  const base = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (base !== OFFSET_TYPE) {
    reply.header('connection', 'close');
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }
};
/** The PATCH body as a stream (the content type parser below hands it over unread). */
export const bodyStream = (req: FastifyRequest): Readable => req.body instanceof Readable ? req.body : Readable.from([]);
/** The declared Content-Length, if it is a usable number. */
export const declaredLength = (req: FastifyRequest): number | undefined => {
  const declared = Number(req.headers['content-length'] ?? NaN);
  return Number.isSafeInteger(declared) ? declared : undefined;
};

// `Upload-Metadata`: comma-separated `key base64value` pairs. Unknown keys (e.g. a client's `filename`) are ignored.
export function parseMetadata(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(',')) {
    const [key, value = '', ...rest] = pair.trim().split(' ');
    if (!key || rest.length > 0 || !/^[\x21-\x2b\x2d-\x7e]+$/.test(key) || key in out) throw new AppError('VALIDATION');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new AppError('VALIDATION');
    out[key] = Buffer.from(value, 'base64').toString('utf8');
  }
  return out;
}

// A malformed id gets the same answer as an unknown or foreign one.
const uploadId = (req: FastifyRequest): string => {
  const id = (req.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw new AppError('NOT_FOUND');
  return id;
};

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // The body stays a stream; the gate below runs before any parser, so no other content type is ever buffered.
  app.addContentTypeParser(OFFSET_TYPE, (_req, payload, done) => done(null, payload));

  app.options('/api/v1/uploads', async (_req, reply) => {
    return reply.status(204).header('tus-resumable', TUS_VERSION).header('tus-version', TUS_VERSION)
      .header('tus-extension', 'creation,termination,expiration').header('tus-max-size', app.deps.config.maxUploadBytes).send();
  });

  // Not tus: the caller's unfinished uploads into their home (#233), for the upload panel after a reload. Each can be
  // resumed (HEAD + PATCH, once the member picks the file again) or discarded (DELETE).
  app.get('/api/v1/uploads', async (req): Promise<OpenUploadList> => ({ items: homeBackend(req).openUploads() }));

  // Creation. Size limit, quota, path and a taken name are all refused here, before a byte is stored.
  app.post('/api/v1/uploads', { onRequest: tus }, async (req, reply) => {
    requireUser(req);
    // Upload-Defer-Length is not offered: the length must be known up front so size and quota are checked at creation.
    if (req.headers['upload-defer-length'] !== undefined) throw new AppError('VALIDATION');
    const h = z.object({ 'upload-length': Digits, 'upload-metadata': z.string().min(1) }).parse(req.headers);
    const m = UploadMeta.parse(parseMetadata(h['upload-metadata']));
    const target = await resolveSource(req, m.source);
    if (target.access !== 'edit') throw new AppError('FORBIDDEN');
    // The bytes are staged in the target home and placed there by rename; a cloud or shared target needs its own
    // placement once those sources exist (#146, #148).
    if (!(target.backend instanceof LocalBackend)) throw new AppError('SOURCE_NOT_FOUND');
    const u = await target.backend.createUpload({ source: m.source, path: m.path, length: h['upload-length'],
      onCollision: m.onCollision, maxBytes: app.deps.config.maxUploadBytes });
    return reply.status(201).header('location', `/api/v1/uploads/${u.id}`).header('upload-offset', 0)
      .header('upload-expires', httpDate(u.expiresAt)).send();
  });

  app.head('/api/v1/uploads/:id', { onRequest: tus }, async (req, reply) => {
    const id = uploadId(req);
    const s = homeBackend(req).uploadState(id);
    return reply.status(200).header('upload-offset', s.offset).header('upload-length', s.length)
      .header('upload-expires', httpDate(s.expiresAt)).header('cache-control', 'no-store').send();
  });

  app.patch('/api/v1/uploads/:id', { onRequest: [tus, offsetStream] }, async (req, reply) => {
    const id = uploadId(req);
    const h = z.object({ 'upload-offset': Digits }).parse(req.headers);
    const s = await homeBackend(req).appendUpload(id, h['upload-offset'], bodyStream(req), declaredLength(req))
      .catch((e: unknown) => {
        if (!req.raw.complete) reply.header('connection', 'close'); // refused or cut off before the body was read: stop draining it
        throw e;
      });
    return reply.status(204).header('upload-offset', s.offset).header('upload-expires', httpDate(s.expiresAt)).send();
  });

  app.delete('/api/v1/uploads/:id', { onRequest: tus }, async (req, reply) => {
    await homeBackend(req).terminateUpload(uploadId(req));
    return reply.status(204).send();
  });

  // Not tus: places a complete upload whose name was taken at the end (FILE_EXISTS from the last PATCH), with the
  // policy the user chose in the collision dialog.
  app.post('/api/v1/uploads/:id/finish', async (req, reply) => {
    const id = uploadId(req);
    const body = z.object({ onCollision: CollisionPolicy }).parse(req.body);
    return reply.status(201).send(await homeBackend(req).finishUpload(id, body.onCollision));
  });
}
