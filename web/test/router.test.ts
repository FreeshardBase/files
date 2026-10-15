import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router.ts';
import FolderView from '../src/views/FolderView.vue';
import TrashView from '../src/views/TrashView.vue';
import RecentView from '../src/views/RecentView.vue';

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
  it('routes /trash to the trash view, and a folder named "trash" stays a folder', async () => {
    const r = mk();
    await r.push('/trash');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(TrashView);
    await r.push('/home/trash');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
  });
  it('routes /recent to the recent view, and a folder named "recent" stays a folder', async () => {
    const r = mk();
    await r.push('/recent');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(RecentView);
    await r.push('/home/recent');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
  });
  it('treats /home as the root folder', async () => {
    const r = mk();
    await r.push('/home');
    expect(r.currentRoute.value.params.source).toBe('home');
    expect(['', []]).toContainEqual(r.currentRoute.value.params.path); // vue-router gives '' for an empty repeatable param
  });
});
