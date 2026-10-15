import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorStatus, type ErrorCode } from '@files/shared';

// A framework 4xx gets the error code that owns its status, but only when exactly one code does (415, 413, 416, …).
// Shared statuses (400, 403, 409) and unknown ones stay VALIDATION, since guessing would mislabel them.
const codeForStatus = new Map<number, ErrorCode>();
for (const [status, codes] of Object.entries(Object.groupBy(Object.keys(errorStatus) as ErrorCode[], (c) => errorStatus[c]))) {
  if (codes?.length === 1) codeForStatus.set(Number(status), codes[0]!);
}

export class AppError extends Error {
  constructor(public code: ErrorCode, public params?: Record<string, string | number>, options?: ErrorOptions) {
    super(code, options);
  }
}

export function errorHandler(err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    const status = errorStatus[err.code];
    if (status >= 500) req.log.error({ err }, err.code);
    return reply.status(status).send(err.params ? { code: err.code, params: err.params } : { code: err.code });
  }
  if ((err as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE' || (err as FastifyError).statusCode === 413) {
    return reply.status(413).send({ code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err instanceof ZodError) return reply.status(400).send({ code: 'VALIDATION' });
  const status = (err as FastifyError).statusCode;
  if ((err as FastifyError).validation || (status !== undefined && status >= 400 && status < 500)) {
    req.log.warn({ err }, 'client error');
    const code = status === undefined ? 'VALIDATION' : (codeForStatus.get(status) ?? 'VALIDATION');
    return reply.status(status ?? 400).send({ code });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({ code: 'INTERNAL' });
}
