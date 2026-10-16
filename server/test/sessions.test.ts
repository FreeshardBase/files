import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { createLoginAttempt, LOGIN_ATTEMPTS_MAX, LOGIN_TTL_MS, takeLoginAttempt } from '../src/auth/sessions.ts';

const attempt = { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' };
const count = (db: Db) => db.prepare('SELECT count(*) FROM login_attempts').pluck().get() as number;

describe('login attempts', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('can be taken exactly once', () => {
    const db = openDb(':memory:');
    const id = createLoginAttempt(db, { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' })!;
    expect(takeLoginAttempt(db, id)).toMatchObject({ state: 's' });
    expect(takeLoginAttempt(db, id)).toBeUndefined();
    db.close();
  });

  // #255: /auth/login is public and writes a row per request; rows must not pile up between hourly purges.
  it('drops expired attempts when a new one starts', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T10:00:00.000Z') });
    const db = openDb(':memory:');
    for (let i = 0; i < 5; i++) createLoginAttempt(db, attempt);
    vi.setSystemTime(Date.now() + LOGIN_TTL_MS - 1);
    const live = createLoginAttempt(db, attempt)!;
    expect(count(db)).toBe(6);
    vi.setSystemTime(Date.now() + 1);
    createLoginAttempt(db, attempt);
    // The five from the start have expired and are gone; the one started later is still there and can be taken.
    expect(count(db)).toBe(2);
    expect(takeLoginAttempt(db, live)).toMatchObject({ state: 's' });
    db.close();
  });

  it('refuses a new attempt while the most live attempts exist, and accepts again once they expire', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-16T10:00:00.000Z') });
    const db = openDb(':memory:');
    const first = createLoginAttempt(db, attempt)!;
    const insert = db.prepare('INSERT INTO login_attempts (id_hash, state, nonce, verifier, return_to, expires_at) VALUES (?,?,?,?,?,?)');
    const expires = new Date(Date.now() + LOGIN_TTL_MS).toISOString();
    db.transaction(() => { for (let i = 1; i < LOGIN_ATTEMPTS_MAX; i++) insert.run(`h${i}`, 's', 'n', 'v', '/', expires); })();
    expect(count(db)).toBe(LOGIN_ATTEMPTS_MAX);
    for (let i = 0; i < 3; i++) expect(createLoginAttempt(db, attempt)).toBeUndefined();
    expect(count(db)).toBe(LOGIN_ATTEMPTS_MAX);
    // Live attempts are never pushed out: a member who started a login before the flood can still finish it.
    expect(takeLoginAttempt(db, first)).toMatchObject({ state: 's' });
    createLoginAttempt(db, attempt);
    expect(count(db)).toBe(LOGIN_ATTEMPTS_MAX);
    vi.setSystemTime(Date.now() + LOGIN_TTL_MS);
    createLoginAttempt(db, attempt);
    expect(count(db)).toBe(1);
    db.close();
  });
});
