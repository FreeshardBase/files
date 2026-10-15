import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router.ts';
import FolderView from '../src/views/FolderView.vue';
import TrashView from '../src/views/TrashView.vue';
import RecentView from '../src/views/RecentView.vue';
import SharedView from '../src/views/SharedView.vue';
import ConnectionsView from '../src/views/ConnectionsView.vue';
import { folderRoute } from '../src/api/paths.ts';

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
  it('routes a share to the folder view with `share:<id>` as its source, and /shared to "Shared with me"', async () => {
    const r = mk();
    await r.push(folderRoute('share:0123abcd', '/Fotos/2026'));
    expect(r.currentRoute.value.path).toBe('/share:0123abcd/Fotos/2026');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
    expect(r.currentRoute.value.params).toEqual({ source: 'share:0123abcd', path: ['Fotos', '2026'] });
    await r.push('/shared');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(SharedView);
    await r.push('/home/shared');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
    // Anything else that looks like a source is not one.
    for (const bad of ['/share:/x', '/share:a.b/x', '/conn:/y', '/conn:a.b/y', '/sharex/y']) {
      await r.push(bad);
      expect(r.currentRoute.value.path, bad).toBe('/home');
    }
  });
  it('routes a connection to the folder view with `conn:<id>` as its source, and /connections to "Cloud accounts" (#148)', async () => {
    const r = mk();
    await r.push(folderRoute('conn:0123abcd', '/Docs'));
    expect(r.currentRoute.value.path).toBe('/conn:0123abcd/Docs');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
    expect(r.currentRoute.value.params).toEqual({ source: 'conn:0123abcd', path: ['Docs'] });
    await r.push('/connections?error=CONNECT_FAILED');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(ConnectionsView);
    await r.push('/home/connections');
    expect(r.currentRoute.value.matched[0]?.components?.default).toBe(FolderView);
  });
  it('treats /home as the root folder', async () => {
    const r = mk();
    await r.push('/home');
    expect(r.currentRoute.value.params.source).toBe('home');
    expect(['', []]).toContainEqual(r.currentRoute.value.params.path); // vue-router gives '' for an empty repeatable param
  });
});
