import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/http/range.ts';

describe('parseRange', () => {
  it.each([
    [undefined, 100, undefined],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    // RFC 9110 §14.1.1: first-pos > last-pos is an invalid range-spec, so the header is ignored.
    ['bytes=5-2', 100, undefined],
    ['bytes=8-5', 4, undefined],
    ['bytes=0-', 10, { start: 0, end: 9 }],
    ['bytes=-5', 10, { start: 5, end: 9 }],
    ['bytes=2-4', 10, { start: 2, end: 4 }],
    ['bytes=999999-', 10, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=0-0', 0, 'unsatisfiable'],
    ['bytes=0-1,4-5', 100, undefined],
    ['items=0-1', 100, undefined],
    ['bytes=-', 100, undefined],
    ['bytes=1.5-3', 100, undefined],
  ] as const)('%s of %d', (h, size, expected) => {
    expect(parseRange(h, size)).toEqual(expected);
  });
});
