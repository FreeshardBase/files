import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { createLoginAttempt, takeLoginAttempt } from '../src/auth/sessions.ts';

describe('login attempts', () => {
  it('can be taken exactly once', () => {
    const db = openDb(':memory:');
    const id = createLoginAttempt(db, { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' });
    expect(takeLoginAttempt(db, id)).toMatchObject({ state: 's' });
    expect(takeLoginAttempt(db, id)).toBeUndefined();
    db.close();
  });
});
