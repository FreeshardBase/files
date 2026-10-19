import { describe, expect, it } from 'vitest';
import { nameProblem, planRenames, renameOne, splitName } from '../src/batchRename.ts';

// #215: the plan the preview shows and the job runs, as a pure function.
const file = (name: string, policy?: 'replace' | 'keep-both' | 'skip') => ({ path: `/d/${name}`, name, type: 'file' as const, ...(policy ? { policy } : {}) });

describe('batch rename plan', () => {
  it('splits a file name at its last dot; folders and dot files have no extension', () => {
    expect(splitName('a.tar.gz', 'file')).toEqual({ stem: 'a.tar', ext: '.gz' });
    expect(splitName('.bashrc', 'file')).toEqual({ stem: '.bashrc', ext: '' });
    expect(splitName('v1.2', 'directory')).toEqual({ stem: 'v1.2', ext: '' });
  });

  it('applies find/replace, case, numbering and prefix/suffix in that order', () => {
    const ops = { find: 'img', replace: 'pic', case: 'upper' as const, numbering: { pattern: '{name}-{n:02}', start: 9 }, prefix: '[', suffix: ']' };
    expect(renameOne('img_a.jpg', 'file', ops, 0)).toBe('[PIC_A-09].jpg');
    expect(renameOne('img_a.jpg', 'file', ops, 1)).toBe('[PIC_A-10].jpg');
    // Braces that are not a token stay as typed; a pattern without {name} is the whole name.
    expect(renameOne('x.png', 'file', { numbering: { pattern: '{x} {n}', start: 1 } }, 0)).toBe('{x} 1.png');
    expect(renameOne('x.png', 'file', { find: '.', replace: '*' }, 0)).toBe('x.png');
  });

  it('names the problem of an unusable name', () => {
    expect(nameProblem('')).toBe('empty');
    expect(nameProblem('a/b')).toBe('slash');
    expect(nameProblem('é'.repeat(128))).toBe('long');
    for (const n of ['.', '..', '.files', '.0123456789abcdef.upload', 'a\u0007', 'a‮', 'a�', 'end.', 'end ']) expect(nameProblem(n)).toBe('reserved');
    expect(nameProblem('Holiday 001.jpg')).toBeNull();
  });

  it('flags collisions inside the batch and with other items, and resolves only with an allowed policy', () => {
    const items = [file('a.txt'), file('b.txt'), file('c.txt')];
    const plan = planRenames(items, ['a.txt', 'b.txt', 'c.txt', 'x 2.txt'], { numbering: { pattern: 'x {n}', start: 1 } });
    expect(plan.rows.map((r) => [r.to, r.conflict])).toEqual([['x 1.txt', null], ['x 2.txt', 'exists'], ['x 3.txt', null]]);
    expect(plan.blocked).toBe(true);
    const kept = planRenames([items[0]!, file('b.txt', 'keep-both'), items[2]!], ['a.txt', 'b.txt', 'c.txt', 'x 2.txt'],
      { numbering: { pattern: 'x {n}', start: 1 } });
    expect(kept.rows[1]).toMatchObject({ to: 'x 2 (1).txt', policy: 'keep-both', onCollision: 'fail' });
    expect(kept.blocked).toBe(false);
    const replaced = planRenames([file('b.txt', 'replace')], ['b.txt', 'x 1.txt'], { numbering: { pattern: 'x {n}', start: 1 } });
    expect(replaced.rows[0]).toMatchObject({ to: 'x 1.txt', onCollision: 'replace', action: 'rename' });
    const dup = planRenames([file('a.txt'), file('b.txt', 'replace')], ['a.txt', 'b.txt'], { numbering: { pattern: 'same', start: 1 } });
    expect(dup.rows[1]).toMatchObject({ conflict: 'batch', policy: null });
    expect(dup.blocked).toBe(true);
  });

  it('treats a change of case only as a rename of the item itself, not a collision', () => {
    const plan = planRenames([file('IMG.JPG')], ['IMG.JPG'], { case: 'lower', extension: true });
    expect(plan.rows[0]).toMatchObject({ to: 'img.jpg', action: 'rename', conflict: null });
  });
});
