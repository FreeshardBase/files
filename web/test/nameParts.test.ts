import { describe, expect, it } from 'vitest';
import { nameParts } from '../src/format.ts';

// #237: a gallery tile cuts a long name in the middle; the tail keeps the extension and the end of the name.
describe('nameParts', () => {
  it('keeps the extension and the four characters before it in the tail', () => {
    expect(nameParts('Sonnenuntergang am Strand mit Familie.png')).toEqual(['Sonnenuntergang am Strand mit Fam', 'ilie.png']);
    expect(nameParts('Urlaub 02.png')).toEqual(['Urlau', 'b 02.png']);
  });
  it('rejoins to the whole name', () => {
    for (const n of ['a.txt', 'Bericht', '.bashrc', 'archive.tar.gz', 'x', 'Ordner mit.Punkt im Namen']) expect(nameParts(n).join('')).toBe(n);
  });
  it('keeps the last four characters without an extension, after a leading dot or with an extension over eight characters', () => {
    expect(nameParts('Steuerunterlagen')).toEqual(['Steuerunterl', 'agen']);
    expect(nameParts('.bashrc')).toEqual(['.ba', 'shrc']);
    expect(nameParts('Bericht.endgueltigfertig')).toEqual(['Bericht.endgueltigfe', 'rtig']);
  });
  it('puts a short name whole into the tail', () => {
    expect(nameParts('a.txt')).toEqual(['', 'a.txt']);
  });
});
