import type { FastifyInstance } from 'fastify';
import { ClientErrorReport, cleanReport } from '@files/shared';
import { requireUser } from '../auth/guard.ts';

/** Reports logged per session and window (#298); later ones in the window are dropped. */
export const CLIENT_ERRORS_PER_WINDOW = 20;
export const CLIENT_ERRORS_WINDOW_MS = 60_000;

/**
 * Counts per key in a fixed window that starts with the first count. In memory: the app runs as one process, and losing
 * the counts on a restart only lets one more window of reports through.
 */
class WindowCounter {
  private entries = new Map<string, { count: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Counts one for `key`; false once `max` were counted in the current window. */
  take(key: string, now = Date.now()): boolean {
    if (this.entries.size >= 1024) for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) { this.entries.set(key, { count: 1, resetAt: now + this.windowMs }); return true; }
    if (e.count >= this.max) return false;
    e.count++;
    return true;
  }
}

// Browser errors (#298): a signed-in member's app reports what failed in the browser, and the server logs it at warn with
// the member's internal id. No table: the log is where an operator looks. Over the limit a report is dropped with the
// same 204, so a page stuck in an error loop neither floods the log nor sees a failure it would report again.
export async function registerClientErrorRoutes(app: FastifyInstance): Promise<void> {
  const limiter = new WindowCounter(CLIENT_ERRORS_PER_WINDOW, CLIENT_ERRORS_WINDOW_MS);
  app.post('/api/v1/client-errors', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    const { user, session } = requireUser(req);
    const report = cleanReport(ClientErrorReport.parse(req.body));
    if (limiter.take(session.idHash)) req.log.warn({ userId: user.id, clientError: report }, 'client error');
    return reply.status(204).send();
  });
}
