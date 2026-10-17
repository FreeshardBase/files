import type { FastifyInstance } from 'fastify';
import { SearchQuery, type SearchGroup, type SearchResponse } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { searchableSources } from '../storage/resolveSource.ts';
import { sourceFailure } from '../storage/askSources.ts';

/** Results per source; one more is asked for, to tell whether there are more. */
export const SEARCH_LIMIT = 50;

// Name search over the caller's home index and, live, every connected cloud whose backend can search. The sources are
// asked at once; one that fails is reported in its own group (logged when it is not an expected AppError), and the
// others still answer.
export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/search', async (req): Promise<SearchResponse> => {
    requireUser(req);
    const { q } = SearchQuery.parse(req.query);
    const sources = (await searchableSources(req)).filter((s) => s.backend.search);
    const groups = await Promise.all(sources.map(async ({ source, backend }): Promise<SearchGroup> => {
      try {
        const found = await backend.search!(q, SEARCH_LIMIT + 1);
        return { source, items: found.slice(0, SEARCH_LIMIT), more: found.length > SEARCH_LIMIT };
      } catch (e) { // handled: reported as this source's error code next to the other sources' results; logged if unexpected
        return { source, items: [], more: false, error: { code: sourceFailure(e, req.log, source) } };
      }
    }));
    return { groups };
  });
}
