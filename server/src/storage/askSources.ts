import type { FastifyBaseLogger } from 'fastify';
import { errorStatus, type ErrorCode } from '@files/shared';
import { AppError } from '../errors.ts';

/** How many `stat`s of one source are in flight at once when many items are resolved (tag view, smart folders; #307). */
export const STAT_CONCURRENCY = 6;
/** How many tagged items one request resolves at most; the rest are answered with `more: true` (#307). */
export const MAX_RESOLVED = 500;

/**
 * `fn` over every item with at most `n` calls in flight: `n` workers pull the next item until none is left. The first
 * failure rejects the whole and the workers start no further calls, as does `signal` once it aborts (nobody waits for
 * the answer any longer); the results keep the items' order.
 */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`mapLimit needs at least one worker, got ${n}`);
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      try { out[i] = await fn(items[i]!); }
      catch (e) { failed = true; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * `work`, or `SOURCE_TIMEOUT` once `ms` have passed (#214). A backend call in flight is not cancelled (it has no
 * abort), but nothing waits for it any longer and what it settles to later is dropped; the signal `work` gets aborts
 * then, so it starts no further calls (#307).
 */
export async function withinTime<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const e = new AppError('SOURCE_TIMEOUT'); abort.abort(e); reject(e); }, ms);
  });
  try { return await Promise.race([work(abort.signal), late]); }
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
