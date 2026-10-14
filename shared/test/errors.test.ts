import { describe, expect, it } from 'vitest';
import { errorStatus, ERROR_CODES, EntrySchema } from '../src/index.ts';

describe('error codes', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      expect(errorStatus[code], code).toBeGreaterThanOrEqual(400);
    }
  });
  it('uses distinct statuses for auth vs csrf', () => {
    expect(errorStatus.UNAUTHENTICATED).toBe(401);
    expect(errorStatus.CSRF).toBe(403);
  });
});

describe('EntrySchema', () => {
  it('rejects an entry without a name', () => {
    expect(EntrySchema.safeParse({ path: '/a', type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' }).success).toBe(false);
  });
});
