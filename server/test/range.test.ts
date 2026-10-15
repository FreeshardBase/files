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
    ['bytes=5-2', 100, 'unsatisfiable'],
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
