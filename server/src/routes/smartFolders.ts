import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SaveSmartFolderRequest, type SearchGroup, type SmartFolderList, type SmartResults } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { searchableSources } from '../storage/resolveSource.ts';
import { sourceFailure, withinTime } from '../storage/askSources.ts';
import {
  createSmartFolder, deleteSmartFolder, evaluateCloud, evaluateHome, smartFolderOf, smartFoldersOf, updateSmartFolder,
} from '../storage/smartFolders.ts';
import { SEARCH_LIMIT } from './search.ts';

const FolderId = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });

// Smart folders (#214): the caller's saved queries. Only the caller's rows are ever read or changed. The result is
// evaluated on every open: each source at once and within the time limit; one that fails is a group with its code.
export async function registerSmartFolderRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/api/v1/smart-folders', async (req): Promise<SmartFolderList> => {
    const { user } = requireUser(req);
    return { items: smartFoldersOf(db, user.id) };
  });

  app.post('/api/v1/smart-folders', async (req, reply) => {
    const { user } = requireUser(req);
    const body = SaveSmartFolderRequest.parse(req.body);
    return reply.status(201).send(createSmartFolder(db, user.id, body.name, body.query));
  });

  app.put('/api/v1/smart-folders/:id', async (req) => {
    const { user } = requireUser(req);
    const { id } = FolderId.parse(req.params);
    const body = SaveSmartFolderRequest.parse(req.body);
    return updateSmartFolder(db, user.id, id, body.name, body.query);
  });

  app.delete('/api/v1/smart-folders/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = FolderId.parse(req.params);
    deleteSmartFolder(db, user.id, id);
    return reply.status(204).send();
  });

  app.get('/api/v1/smart-folders/:id/results', async (req): Promise<SmartResults> => {
    const { user } = requireUser(req);
    const { id } = FolderId.parse(req.params);
    const { query } = smartFolderOf(db, user.id, id);
    const searchable = await searchableSources(req);
    // The sources the query names, in its order; one that is no longer the caller's is a failed group, never another one.
    const asked = query.sources ?? searchable.map((s) => s.source);
    const groups = await Promise.all(asked.map(async (source): Promise<SearchGroup> => {
      try {
        const found = searchable.find((s) => s.source === source);
        if (!found) throw new AppError('SOURCE_NOT_FOUND');
        const answer = await withinTime(config.sourceTimeoutMs, async (signal) => source === 'home'
          ? evaluateHome(db, user.id, query, SEARCH_LIMIT)
          : evaluateCloud(db, user.id, source, found.backend, query, SEARCH_LIMIT, signal));
        return { source, ...answer };
      } catch (e) { // handled: reported as this source's error code next to the other sources' results; logged if unexpected
        return { source, items: [], more: false, error: { code: sourceFailure(e, req.log, source) } };
      }
    }));
    return { groups };
  });
}
