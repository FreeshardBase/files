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
  it('maps STORAGE_FULL to 507', () => {
    expect(errorStatus.STORAGE_FULL).toBe(507);
  });
  it('pins INTERNAL and NOT_FOUND statuses', () => {
    expect(errorStatus.INTERNAL).toBe(500);
    expect(errorStatus.NOT_FOUND).toBe(404);
  });
});

describe('EntrySchema', () => {
  const base = { path: '/a', name: 'a', type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' };
  it('accepts a valid entry', () => {
    expect(EntrySchema.safeParse(base).success).toBe(true);
  });
  it('rejects a relative path', () => {
    expect(EntrySchema.safeParse({ ...base, path: 'a' }).success).toBe(false);
  });
  it('rejects an entry without a name', () => {
    expect(EntrySchema.safeParse({ path: '/a', type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' }).success).toBe(false);
  });
});
