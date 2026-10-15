import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { basic, createAppPassword } from './support/dav.ts';

// App passwords (#157): the only credential WebDAV accepts. Created, listed and revoked in settings through the API.
type Session = { cookie: string; csrf: string };
let t: TestApp; let a: Session; let m: Session;
const ORIGIN = 'https://files.example.com';

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  m = await login(t, 'member');
});
afterAll(() => t.close());

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, s: Session = a, payload?: object) => t.app.inject({
  method, url, payload, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': s.csrf, origin: ORIGIN }) },
});
const davRoot = (password: string) => t.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/', headers: { authorization: basic(password), depth: '0' } });
const list = async (s: Session = a) => (await api('GET', '/api/v1/app-passwords', s)).json().items as
  { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];

describe('app passwords', () => {
  it('creates one, shows it once, and lists it without the password', async () => {
    const r = await api('POST', '/api/v1/app-passwords', a, { label: 'Test phone' });
    expect(r.statusCode).toBe(201);
    const { item, password } = r.json();
    expect(password).toMatch(/^[a-z2-9]{40}$/);
    expect(item.label).toBe('Test phone');
    const items = await list();
    expect(items.find((i) => i.id === item.id)).toMatchObject({ label: 'Test phone', lastUsedAt: null });
    expect(JSON.stringify(items)).not.toContain(password);
    expect((await davRoot(password)).statusCode).toBe(207);
    expect((await list()).find((i) => i.id === item.id)!.lastUsedAt).not.toBeNull();
  });

  it('refuses an empty or over-long label', async () => {
    expect((await api('POST', '/api/v1/app-passwords', a, { label: '  ' })).statusCode).toBe(400);
    expect((await api('POST', '/api/v1/app-passwords', a, { label: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await api('POST', '/api/v1/app-passwords', a, { label: 'ok', userId: 'someone' })).statusCode).toBe(400);
  });

  it('a revoked app password answers 401 at once', async () => {
    const r = await api('POST', '/api/v1/app-passwords', a, { label: 'Test revoke' });
    const { item, password } = r.json();
    expect((await davRoot(password)).statusCode).toBe(207);
    expect((await api('DELETE', `/api/v1/app-passwords/${item.id}`)).statusCode).toBe(204);
    expect((await davRoot(password)).statusCode).toBe(401);
    expect((await list()).some((i) => i.id === item.id)).toBe(false);
  });

  it('a member can neither see nor revoke another member\'s app password', async () => {
    const { item, password } = (await api('POST', '/api/v1/app-passwords', a, { label: 'Test owner' })).json();
    expect((await list(m)).some((i) => i.id === item.id)).toBe(false);
    expect((await api('DELETE', `/api/v1/app-passwords/${item.id}`, m)).statusCode).toBe(404);
    expect((await davRoot(password)).statusCode).toBe(207);
  });

  it('stores an argon2id hash and a lookup prefix, never the password', async () => {
    const password = await createAppPassword(t, a, 'Test hash');
    const row = t.db.prepare('SELECT * FROM app_passwords WHERE label = ?').get('Test hash') as Record<string, unknown>;
    expect(String(row.hash)).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
    expect(row.prefix).toBe(password.slice(0, 8));
    for (const value of Object.values(row)) expect(String(value)).not.toContain(password.slice(8));
  });

  it('looks a password up by its prefix instead of checking every stored hash', async () => {
    // Rows of other prefixes whose hashes no verifier accepts: an implementation that tried each stored hash in turn
    // would fail on them (or let one of them decide); a lookup by prefix never touches them.
    const uid = 'ffffffff-0000-4000-8000-000000000001';
    t.db.prepare(`INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login)
      VALUES (?, 'https://idp.example.com', 'broken', 'Test User', 'testuser@example.com', 'member', ?, ?)`)
      .run(uid, new Date().toISOString(), new Date().toISOString());
    const insert = t.db.prepare(`INSERT INTO app_passwords (id, user_id, prefix, hash, label, created_at)
      VALUES (?, ?, ?, 'not-a-hash', 'Test broken', ?)`);
    const letter = (k: number) => 'abcdefghijkmnpqrstuvwxyz'[k % 24];
    for (let i = 0; i < 50; i++) insert.run(i.toString(16).padStart(32, 'f'), uid, `zz${letter(i)}${letter(Math.floor(i / 24))}zzzz`, new Date().toISOString());
    const password = await createAppPassword(t, a, 'Test lookup');
    expect((await davRoot(password)).statusCode).toBe(207);
    t.db.prepare("DELETE FROM app_passwords WHERE label = 'Test broken'").run();
  });

  it('a password with an unknown prefix is refused', async () => {
    const password = await createAppPassword(t, a, 'Test prefix');
    const other = (password[0] === 'a' ? 'b' : 'a') + password.slice(1);
    expect((await davRoot(other)).statusCode).toBe(401);
  });

  it('allows at most 20 per member and says so', async () => {
    const ids: string[] = [];
    let last;
    for (let i = 0; i < 21; i++) {
      last = await api('POST', '/api/v1/app-passwords', m, { label: `Test ${i}` });
      if (last.statusCode === 201) ids.push(last.json().item.id);
    }
    expect(ids).toHaveLength(20);
    expect(last!.statusCode).toBe(409);
    expect(last!.json()).toEqual({ code: 'APP_PASSWORD_LIMIT', params: { max: 20 } });
    for (const id of ids) await api('DELETE', `/api/v1/app-passwords/${id}`, m);
  });
});
