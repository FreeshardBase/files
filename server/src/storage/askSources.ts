import type { FastifyBaseLogger } from 'fastify';
import { errorStatus, type ErrorCode } from '@files/shared';
import { AppError } from '../errors.ts';

/**
 * `work`, or `SOURCE_TIMEOUT` once `ms` have passed (#214). The work itself is not cancelled (a backend call has no
 * abort), but nothing waits for it any longer; what it settles to later is dropped.
 */
export async function withinTime<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('SOURCE_TIMEOUT')), ms); });
  try { return await Promise.race([work, late]); }
  finally { clearTimeout(timer); }
}

/**
 * The error code a source's failure is reported as, next to the other sources' answers (global search, smart folders,
 * the tag view): its own code for an `AppError`, else `SEARCH_FAILED`. Unexpected failures and 5xx codes are logged.
 */
export function sourceFailure(e: unknown, log: FastifyBaseLogger, source: string): ErrorCode {
  const code = e instanceof AppError ? e.code : 'SEARCH_FAILED';
  if (!(e instanceof AppError) || errorStatus[code] >= 500) log.error({ err: e, source }, 'a source failed to answer');
  return code;
}
