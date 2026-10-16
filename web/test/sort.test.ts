import { describe, expect, it } from 'vitest';
import type { Entry, Sort } from '@files/shared';
import { sortEntries } from '../src/sort.ts';

// #226: folders first, then natural, locale-aware order by the member's key and direction.

const file = (name: string, size = 0, modified?: string): Entry => ({ name, path: `/${name}`, type: 'file', size, ...(modified ? { modified } : {}) });
const dir = (name: string, modified?: string): Entry => ({ name, path: `/${name}`, type: 'directory', size: 0, ...(modified ? { modified } : {}) });
const names = (entries: Entry[], sort: Sort, locale = 'en-GB') => sortEntries(entries, sort, locale).map((e) => e.name);

describe('sortEntries', () => {
  it('orders names naturally, ignoring case, leading spaces and dots, with folders first', () => {
    const entries = [file('file-10'), file('file-2'), file(' spaced'), file('.hidden'), file('Banana'), file('apple'),
      dir('zeta'), dir('Alpha'), dir('folder-10'), dir('folder-9')];
    expect(names(entries, { key: 'name', dir: 'asc' })).toEqual(
      ['Alpha', 'folder-9', 'folder-10', 'zeta', 'apple', 'Banana', 'file-2', 'file-10', '.hidden', ' spaced']);
    expect(names(entries, { key: 'name', dir: 'desc' })).toEqual(
      ['zeta', 'folder-10', 'folder-9', 'Alpha', ' spaced', '.hidden', 'file-10', 'file-2', 'Banana', 'apple']);
  });

  it('is locale-aware', () => {
    expect(names([file('zebra'), file('Äpfel'), file('Bär')], { key: 'name', dir: 'asc' }, 'de-DE')).toEqual(['Äpfel', 'Bär', 'zebra']);
  });

  it('sorts by size and by modification time in both directions, ties by name, folders still first', () => {
    const entries = [file('b', 300, '2026-01-03T00:00:00Z'), file('a', 100, '2026-01-01T00:00:00Z'),
      file('c', 100, '2026-01-02T00:00:00Z'), file('d', 200), dir('x', '2026-01-05T00:00:00Z'), dir('w', '2026-01-04T00:00:00Z')];
    expect(names(entries, { key: 'size', dir: 'asc' })).toEqual(['w', 'x', 'a', 'c', 'd', 'b']);
    expect(names(entries, { key: 'size', dir: 'desc' })).toEqual(['w', 'x', 'b', 'd', 'a', 'c']);
    expect(names(entries, { key: 'modified', dir: 'asc' })).toEqual(['w', 'x', 'd', 'a', 'c', 'b']);
    expect(names(entries, { key: 'modified', dir: 'desc' })).toEqual(['x', 'w', 'b', 'c', 'a', 'd']);
  });

  it('leaves its input alone', () => {
    const entries = [file('b'), file('a')];
    sortEntries(entries, { key: 'name', dir: 'asc' }, 'en-GB');
    expect(entries.map((e) => e.name)).toEqual(['b', 'a']);
  });
});
