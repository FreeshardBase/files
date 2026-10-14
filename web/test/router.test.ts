import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router.ts';
import FolderView from '../src/views/FolderView.vue';

const mk = () => createRouter({ history: createMemoryHistory(), routes });

describe('router', () => {
  it('redirects / to /home and keeps the query', async () => {
    const r = mk();
    await r.push('/?loginError=1');
    expect(r.currentRoute.value.fullPath).toBe('/home?loginError=1');
  });
  it('puts the folder path under the source segment, so folders named like server routes are just folders', async () => {
    const r = mk();
    for (const name of ['api', 'auth', 'healthz']) {
      await r.push(`/home/${name}/x`);
      expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
      expect(r.currentRoute.value.params).toEqual({ source: 'home', path: [name, 'x'] });
    }
  });
  it('treats /home as the root folder', async () => {
    const r = mk();
    await r.push('/home');
    expect(r.currentRoute.value.params.source).toBe('home');
    expect(['', []]).toContainEqual(r.currentRoute.value.params.path); // vue-router gives '' for an empty repeatable param
  });
});
