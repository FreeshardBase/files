import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry, SearchResponse } from '@files/shared';
import { DEFAULT_MIGRATIONS, openDb } from '../src/db.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #235: the home's name search ignores accents as well as case. "umlaut" finds "Ümlaut-Liste.txt", "cafe" finds
// "Café.md" (in either Unicode form) and "CAFÉ" finds both spellings. An index written before this change is folded again
// by a migration.

type S = { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';

describe('accent-insensitive name search (#235)', () => {
  let t: TestApp; let a: S;
  beforeAll(async () => {
    t = await startTestApp();
    a = await login(t, 'testuser');
    for (const name of ['Ümlaut-Liste.txt', 'Café decomposed.md', 'Café.md', 'Smørrebrød.txt', 'plain.txt']) {
      const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(`/${name}`)}&onCollision=fail`,
        headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x') });
      expect(r.statusCode, r.body).toBe(201);
    }
  });
  afterAll(() => t.close());

  const names = async (q: string) => {
    const r = await t.app.inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}`, headers: { cookie: a.cookie } });
    expect(r.statusCode, r.body).toBe(200);
    const home = (r.json() as SearchResponse).groups.find((g) => g.source === 'home')!;
    return home.items.map((e: Entry) => e.name).sort();
  };

  it('finds a name with an umlaut or an accent from the plain letters, in any case', async () => {
    expect(await names('umlaut')).toEqual(['Ümlaut-Liste.txt']);
    expect(await names('ÜMLAUT')).toEqual(['Ümlaut-Liste.txt']);
    // Names are stored in NFC, so the decomposed one comes back composed.
    expect(await names('cafe')).toEqual(['Café decomposed.md', 'Café.md']);
    expect(await names('CAFÉ')).toEqual(['Café decomposed.md', 'Café.md']);
    // Letters of their own (ø) are not accents and stay as they are.
    expect(await names('smørrebrød')).toEqual(['Smørrebrød.txt']);
    expect(await names('plain')).toEqual(['plain.txt']);
  });

  it('a smart folder\'s name criterion folds the same way', async () => {
    const made = await t.app.inject({ method: 'POST', url: '/api/v1/smart-folders',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { name: 'Umlaute', query: { name: 'umlaut', sources: ['home'] } } });
    expect(made.statusCode, made.body).toBe(201);
    const r = await t.app.inject({ url: `/api/v1/smart-folders/${made.json().id as string}/results`, headers: { cookie: a.cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as SearchResponse).groups[0]!.items.map((e: Entry) => e.name)).toEqual(['Ümlaut-Liste.txt']);
  });
});

describe('the migration that folds an existing name index again (#235)', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'files-fold-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('rewrites every row\'s fold from its name', () => {
    // A database as it was before: every migration up to 025.
    const old = join(dir, 'old-migrations');
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f) && f < '026')) {
      copyFileSync(join(DEFAULT_MIGRATIONS, f), join(old, f));
    }
    const file = join(dir, 'files.db');
    const before = openDb(file, old);
    before.prepare(`INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login) VALUES ('u1',
      'https://idp.example.com', 'sub-1', 'Test User', 'testuser@example.com', 'admin', '2026-10-17T00:00:00.000Z',
      '2026-10-17T00:00:00.000Z')`).run();
    const row = before.prepare(`INSERT INTO name_index (user_id, path, name_fold, type, size, modified) VALUES ('u1', ?, ?, 'file', 1,
      '2026-10-17T00:00:00.000Z')`);
    row.run('/Ordner/Ümlaut-Liste.txt', 'ümlaut-liste.txt');
    row.run('/Café.md', 'café.md');
    before.close();

    const after = openDb(file);
    const folds = after.prepare('SELECT path, name_fold FROM name_index ORDER BY path').all();
    after.close();
    expect(folds).toEqual([{ path: '/Café.md', name_fold: 'cafe.md' }, { path: '/Ordner/Ümlaut-Liste.txt', name_fold: 'umlaut-liste.txt' }]);
  });
});
