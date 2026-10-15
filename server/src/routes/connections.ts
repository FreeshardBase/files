import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthorizeRequest, ConnectionId, GraphId, PickLibraryRequest, type AuthorizeResponse, type Connection, type ConnectionList,
  type ErrorCode, type LibraryList, type SiteList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';

/** The provider sends the browser back here. Fixed from the configured public URL, never from `Host` (#106). */
export const CONNECT_CALLBACK_PATH = '/api/v1/connections/callback';

const Params = z.object({ id: ConnectionId });
const SitesQuery = z.object({ q: z.string().max(200).optional() });
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
    let done: { id: string; pick: boolean };
    try { done = await cloud.complete(session.idHash, user.id, q.data, req.log); }
    catch (err) { // handled: an expected refusal goes back to the connections page with its code; anything else is rethrown
      if (err instanceof AppError && (err.code === 'CONNECT_FAILED' || err.code === 'CONNECT_ACCOUNT_MISMATCH' || err.code === 'NOT_FOUND')) {
        return reply.redirect(failedUrl(err.code === 'NOT_FOUND' ? 'CONNECT_FAILED' : err.code));
      }
      throw err;
    }
    // A SharePoint connection goes on to the library picker first (#151).
    return reply.redirect(done.pick ? `/connections?pick=${done.id}` : `/conn:${done.id}`);
  });

  // The library picker of a pending SharePoint connection (#151): the account's sites, a site's document libraries, and
  // picking one. Site and library ids go into Graph paths on the fixed Graph host only, after GraphId's character check.
  app.get('/api/v1/connections/:id/sites', async (req): Promise<SiteList> => {
    const { user } = requireUser(req);
    const { id } = Params.parse(req.params);
    const { q } = SitesQuery.parse(req.query);
    return { items: await cloud.sites(user.id, id, q ?? '') };
  });

  app.get('/api/v1/connections/:id/sites/:site/libraries', async (req): Promise<LibraryList> => {
    const { user } = requireUser(req);
    const { id, site } = Params.extend({ site: GraphId }).parse(req.params);
    return { items: await cloud.libraries(user.id, id, site) };
  });

  app.put('/api/v1/connections/:id/library', async (req): Promise<Connection> => {
    const { user } = requireUser(req);
    const { id } = Params.parse(req.params);
    const body = PickLibraryRequest.parse(req.body);
    return cloud.pickLibrary(user.id, id, body.site, body.library);
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
