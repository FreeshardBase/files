import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #337: the display name comes from `name`, then `preferred_username`, then the email's local part; with none of them
// it stays empty (the web shows the localized "Mitglied"). Never the internal id or `sub`.
let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
  Object.assign(t.idp.users, {
    'sub-only': { groups: [] },
    'sub-email': { email: 'testuser@example.com', groups: [] },
    'sub-username': { preferred_username: 'testuser', email: 'other@example.com', groups: [] },
    'sub-name': { name: 'Test User', preferred_username: 'testuser', email: 'other@example.com', groups: [] },
  });
});
afterAll(() => t.close());

const stored = (sub: string) => t.db.prepare('SELECT display_name FROM users WHERE sub = ?').pluck().get(sub) as string;
async function me(sub: string) {
  const { cookie } = await login(t, sub);
  return (await t.app.inject({ url: '/api/v1/me', headers: { cookie } })).json() as { id: string; displayName: string };
}

describe('display name at login', () => {
  it.each([
    ['sub-only', ''],
    ['sub-email', 'testuser'],
    ['sub-username', 'testuser'],
    ['sub-name', 'Test User'],
  ])('claims of %s store %j', async (sub, expected) => {
    const m = await me(sub);
    expect(stored(sub)).toBe(expected);
    expect(m.displayName).toBe(expected);
    expect(m.displayName).not.toContain(m.id);
    expect(m.displayName).not.toContain(sub);
  });

  it('a later login with a new name updates the stored name', async () => {
    t.idp.users['renamed'] = { email: 'testuser@example.com', groups: [] };
    await me('renamed');
    expect(stored('renamed')).toBe('testuser');
    t.idp.users['renamed'] = { name: 'Test User', groups: [] };
    expect((await me('renamed')).displayName).toBe('Test User');
    expect(stored('renamed')).toBe('Test User');
  });

  it('a whitespace-only name falls through to the next claim', async () => {
    t.idp.users['blank-name'] = { name: '   ', preferred_username: ' ', email: 'testuser@example.com', groups: [] };
    expect((await me('blank-name')).displayName).toBe('testuser');
  });
});
