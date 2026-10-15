import type { FastifyInstance } from 'fastify';

/** The manifest's `share_target.action` (#158); the service worker (`web/public/sw.js`) answers it in the browser. */
export const SHARE_TARGET_PATH = '/api/v1/share-target';
/** The SPA page where the member picks the folder for the shared files. */
const SHARE_PAGE = '/share-target';

/**
 * The Web Share Target as the server sees it: only when no service worker took the share (the app was never opened on
 * this device, or the browser has none). The shared files stay in the browser with the service worker until the member
 * picks a folder; here they are never read. A share sheet's POST carries no CSRF token, so the route is public and
 * changes nothing: without a session it sends the member to login, with one to the share page, which says the share did
 * not arrive. The unread body is discarded by Node once the answer is sent.
 */
export async function registerShareTargetRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Accept the multipart body without reading it, so it is never parsed, buffered or stored.
    scope.addContentTypeParser('multipart/form-data', (_req, _payload, done) => { done(null, undefined); });
    scope.post(SHARE_TARGET_PATH, { config: { public: true } }, async (req, reply) => {
      if (!req.user) return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(SHARE_PAGE)}`, 303);
      return reply.redirect(SHARE_PAGE, 303);
    });
  });
}
