import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { errorStatus, type ErrorCode } from '@files/shared';

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
  const status = (err as FastifyError).statusCode;
  if ((err as FastifyError).validation || (status !== undefined && status >= 400 && status < 500)) {
    req.log.warn({ err }, 'client error');
    return reply.status(status ?? 400).send({ code: 'VALIDATION' });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({ code: 'INTERNAL' });
}
