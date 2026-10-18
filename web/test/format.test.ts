import { describe, expect, it } from 'vitest';
import { formatSize } from '../src/format.ts';

// #315: below a kilobyte the unit is a word that follows the count ("25 bytes", "1 byte"); CLDR's short English form
// is "byte" for every count.
describe('formatSize', () => {
  it('says bytes in English, plural-aware', () => {
    expect(formatSize(25, 'en-GB')).toBe('25 bytes');
    expect(formatSize(1, 'en-GB')).toBe('1 byte');
    expect(formatSize(0, 'en-GB')).toBe('0 bytes');
  });
  it('says Byte in German for every count', () => {
    // CLDR puts a no-break space before some German units and not before others; the space itself is not the point.
    expect(formatSize(25, 'de-DE').replace(/\s/g, ' ')).toBe('25 Byte');
    expect(formatSize(1, 'de-DE').replace(/\s/g, ' ')).toBe('1 Byte');
  });
  it('keeps the short form from a kilobyte on', () => {
    expect(formatSize(2500, 'en-GB')).toBe('2.5 kB');
    expect(formatSize(15e9, 'de-DE')).toMatch(/^15\sGB$/);
  });
});
