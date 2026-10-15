import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthorizeRequest, ConnectionId, type AuthorizeResponse, type Connection, type ConnectionList, type ErrorCode } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';

/** The provider sends the browser back here. Fixed from the configured public URL, never from `Host` (#106). */
export const CONNECT_CALLBACK_PATH = '/api/v1/connections/callback';

const Params = z.object({ id: ConnectionId });
// Only the fields the flow reads; anything else the provider adds (`scope`, `iss`, …) is ignored. Bounded, so a forged
// callback cannot make the server store or log much.
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().min(1).max(256).optional(),
});

/** Where a failed consent sends the browser: the connections page names the error. */
const failedUrl = (code: ErrorCode) => `/connections?error=${code}`;

// Cloud connections (#148): the member's own list, starting a consent flow (new account or signing in again), the
// provider's callback, a live status check and unlinking. Every route needs the session; another member's connection
// answers NOT_FOUND like an unknown one.
export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  const { cloud } = app.deps;

  app.get('/api/v1/connections', async (req): Promise<ConnectionList> => {
    const { user } = requireUser(req);
    return { items: cloud.list(user.id), providers: cloud.providers() };
  });

  app.post('/api/v1/connections/authorize', async (req): Promise<AuthorizeResponse> => {
    const { user, session } = requireUser(req);
    const body = AuthorizeRequest.parse(req.body);
    return { url: cloud.authorize(session.idHash, user.id, body) };
  });

  // A top-level navigation from the provider: the session cookie (SameSite=Lax) comes along, and the state must be one
  // this session started. The query (code, state) is never logged: the request serializer drops it.
  app.get(CONNECT_CALLBACK_PATH, async (req, reply) => {
    const { user, session } = requireUser(req);
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) {
      req.log.warn({ reason: 'malformed callback query' }, 'connect failed');
      return reply.redirect(failedUrl('CONNECT_FAILED'));
    }
    let id: string;
    try { id = await cloud.complete(session.idHash, user.id, q.data, req.log); }
    catch (err) { // handled: an expected refusal goes back to the connections page with its code; anything else is rethrown
      if (err instanceof AppError && (err.code === 'CONNECT_FAILED' || err.code === 'CONNECT_ACCOUNT_MISMATCH' || err.code === 'NOT_FOUND')) {
        return reply.redirect(failedUrl(err.code === 'NOT_FOUND' ? 'CONNECT_FAILED' : err.code));
      }
      throw err;
    }
    return reply.redirect(`/conn:${id}`);
  });

  app.post('/api/v1/connections/:id/check', async (req): Promise<Connection> => {
    const { user } = requireUser(req);
    const { id } = Params.parse(req.params);
    return cloud.check(user.id, id, req.log);
  });

  app.delete('/api/v1/connections/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = Params.parse(req.params);
    cloud.unlink(user.id, id);
    return reply.status(204).send();
  });
}
