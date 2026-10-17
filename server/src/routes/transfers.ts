import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateTransferRequest, TransferId, type TransferJob, type TransferList } from '@files/shared';
import { requireUser } from '../auth/guard.ts';

const IdP = z.object({ id: TransferId });
/** A comment line now and then keeps proxies from closing an idle event stream. */
const KEEPALIVE_MS = 25_000;
/** Open event streams per member (#280): a few tabs and devices; one more ends that member's oldest. */
const MAX_STREAMS_PER_MEMBER = 8;

/**
 * `/api/v1/transfers` (#152): the caller's transfer jobs between sources. Every lookup is by id and owner, so another
 * member's job is NOT_FOUND; the event stream carries only the caller's own jobs.
 */
export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  const engine = () => app.deps.transfers;
  const streams = new Set<() => void>();
  // Each member's open streams, oldest first (a Set keeps insertion order).
  const byMember = new Map<string, Set<() => void>>();
  // Open event streams would hold the server open; they end before it closes.
  app.addHook('preClose', async () => { for (const end of [...streams]) end(); });

  app.post('/api/v1/transfers', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateTransferRequest.parse(req.body);
    return reply.status(201).send(await engine().create(user.id, body));
  });

  app.get('/api/v1/transfers', async (req): Promise<TransferList> => {
    const { user } = requireUser(req);
    return { items: engine().list(user.id) };
  });

  // Server-sent events: one `job` event with the whole job on every change and while bytes flow, starting with the
  // caller's current jobs, so a client that connects late has the full picture.
  app.get('/api/v1/transfers/events', async (req, reply) => {
    const { user } = requireUser(req);
    const mine = byMember.get(user.id) ?? new Set<() => void>();
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'x-accel-buffering': 'no', connection: 'keep-alive' });
    raw.flushHeaders(); // a member without jobs gets the headers now, not with the first event
    const send = (job: TransferJob) => { raw.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`); };
    for (const job of engine().list(user.id).reverse()) send(job);
    const unsubscribe = engine().subscribe(user.id, send);
    const keepalive = setInterval(() => { raw.write(': keepalive\n\n'); }, KEEPALIVE_MS);
    keepalive.unref();
    const end = () => {
      if (!streams.delete(end)) return;
      mine.delete(end);
      if (!mine.size && byMember.get(user.id) === mine) byMember.delete(user.id);
      clearInterval(keepalive); unsubscribe(); raw.end();
    };
    // A member never holds more than the cap: the oldest stream ends (its EventSource reconnects if still wanted).
    for (const oldest of mine) { if (mine.size < MAX_STREAMS_PER_MEMBER) break; oldest(); }
    streams.add(end);
    byMember.set(user.id, mine);
    mine.add(end);
    req.raw.on('close', end);
    if (req.raw.socket.destroyed) end(); // the client left before the listener was there
  });

  app.get('/api/v1/transfers/:id', async (req) => {
    const { user } = requireUser(req);
    return engine().get(user.id, IdP.parse(req.params).id);
  });

  // The summary export (#153): one CSV row per item, streamed from the rows.
  app.get('/api/v1/transfers/:id/report', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = IdP.parse(req.params);
    const body = engine().report(user.id, id);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="transfer-${id}.csv"`).send(body);
  });

  app.post('/api/v1/transfers/:id/cancel', async (req) => {
    const { user } = requireUser(req);
    return engine().cancel(user.id, IdP.parse(req.params).id);
  });

  // Removes one finished job from the panel (#234): a successful one once the member has seen it, a failed one when they
  // dismiss it.
  app.post('/api/v1/transfers/:id/dismiss', async (req, reply) => {
    const { user } = requireUser(req);
    engine().dismiss(user.id, IdP.parse(req.params).id);
    return reply.status(204).send();
  });

  // Removes the caller's finished jobs from the panel; running ones stay.
  app.post('/api/v1/transfers/clear', async (req, reply) => {
    const { user } = requireUser(req);
    engine().clearFinished(user.id);
    return reply.status(204).send();
  });
}
