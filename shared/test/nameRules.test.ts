import { describe, expect, it } from 'vitest';
import { checkName, GRAPH_MAX_PATH, nameTaken, suggestName } from '../src/nameRules.ts';

// #342: each source's own name rules, and the suggestion the member is offered (forbidden characters → `_`).
const codes = (set: Parameters<typeof checkName>[0], name: string, dir = '/') => checkName(set, name, dir).map((i) => i.char ? `${i.code}:${i.char}` : i.code);
// The suggestion with each replaced or added character in brackets, as the dialog highlights it.
const marked = (set: Parameters<typeof suggestName>[0], name: string, dir = '/') => {
  const s = suggestName(set, name, dir);
  return [...s.name].map((c, i) => (s.replaced.includes(i) ? `[${c}]` : c)).join('');
};

describe('OneDrive and SharePoint names', () => {
  it('refuses forbidden characters and replaces each with _', () => {
    expect(codes('onedrive', 'Bericht: Q3.pdf')).toEqual(['char::']);
    expect(marked('onedrive', 'Bericht: Q3.pdf')).toBe('Bericht[_] Q3.pdf');
    expect(codes('sharepoint', 'a"*<>?|b')).toEqual(['char:"', 'char:*', 'char:<', 'char:>', 'char:?', 'char:|']);
    expect(suggestName('sharepoint', 'a"*<>?|b').name).toBe('a______b');
  });

  it('refuses leading and trailing spaces and a trailing dot, and trims them', () => {
    expect(codes('onedrive', ' a')).toEqual(['leadingSpace']);
    expect(codes('onedrive', 'a ')).toEqual(['trailingSpace']);
    expect(codes('onedrive', 'a.')).toEqual(['trailingDot']);
    expect(suggestName('onedrive', '  notes. .').name).toBe('notes');
    expect(suggestName('onedrive', '...').name).toBe('_');
  });

  it('refuses reserved names, with an extension too, and appends _', () => {
    for (const n of ['CON', 'con.txt', 'PRN', 'AUX.tar.gz', 'NUL', 'COM0', 'com9.log', 'LPT1', 'LPT9.doc', '.lock', 'Desktop.ini']) {
      expect(codes('onedrive', n), n).toEqual(['reserved']);
    }
    expect(marked('onedrive', 'CON')).toBe('CON[_]');
    expect(marked('onedrive', 'con.txt')).toBe('con[_].txt');
    expect(marked('onedrive', '.lock')).toBe('.lock[_]');
    expect(marked('onedrive', 'desktop.ini')).toBe('desktop.ini[_]');
    expect(codes('onedrive', 'CONTACTS.txt')).toEqual([]);
    expect(codes('onedrive', 'COM10')).toEqual([]);
  });

  it('refuses names starting with ~$ and _vti_ anywhere', () => {
    expect(codes('onedrive', '~$Bericht.docx')).toEqual(['tildeDollar']);
    expect(marked('onedrive', '~$Bericht.docx')).toBe('[_]$Bericht.docx');
    expect(codes('onedrive', 'a~$b')).toEqual([]);
    expect(codes('onedrive', 'x_vti_y')).toEqual(['vti']);
    expect(marked('onedrive', 'x_VTI_y')).toBe('x_VTI[-]y');
  });

  it('limits the whole path to 400 characters and shortens the name in the middle, keeping the extension', () => {
    const dir = `/${'d'.repeat(300)}`;
    const name = `${'a'.repeat(50)}${'b'.repeat(50)}.pdf`;
    expect(codes('onedrive', name, dir)).toEqual(['pathLength']);
    expect(codes('onedrive', name)).toEqual([]);
    const s = suggestName('onedrive', name, dir);
    expect(`${dir}/${s.name}`).toHaveLength(GRAPH_MAX_PATH);
    expect(s.name.startsWith('aaaa')).toBe(true);
    expect(s.name.endsWith('bbbb.pdf')).toBe(true);
    expect(checkName('onedrive', s.name, dir)).toEqual([]);
  });

  it('accepts a valid name as it is', () => {
    expect(checkName('onedrive', 'Bericht Q3.pdf', '/')).toEqual([]);
    expect(suggestName('onedrive', 'Bericht Q3.pdf', '/')).toEqual({ name: 'Bericht Q3.pdf', replaced: [] });
  });
});

describe('Dropbox names', () => {
  it('refuses trailing spaces and periods and control characters, but allows a colon', () => {
    expect(codes('dropbox', 'a. ')).toEqual(['trailingSpace']);
    expect(codes('dropbox', 'a.')).toEqual(['trailingDot']);
    expect(codes('dropbox', 'a\u0001b')).toEqual(['control']);
    expect(marked('dropbox', 'a\u0001b')).toBe('a[_]b');
    expect(suggestName('dropbox', 'notes . ').name).toBe('notes');
    expect(codes('dropbox', 'Bericht: Q3.pdf')).toEqual([]);
  });

  it('compares names ignoring case, so an existing a.txt blocks A.txt', () => {
    expect(nameTaken('dropbox', 'A.txt', ['a.txt'])).toBe(true);
    expect(nameTaken('onedrive', 'A.txt', ['a.txt'])).toBe(true);
    expect(nameTaken('universal', 'A.txt', ['a.txt'])).toBe(false);
    expect(nameTaken('universal', 'a.txt', ['a.txt'])).toBe(true);
  });
});

describe('Google Drive, pCloud and the home', () => {
  it('have the universal rules only', () => {
    for (const n of ['Bericht: Q3.pdf', 'CON', 'a.', ' a ', '~$x', '_vti_']) expect(checkName('universal', n, '/'), n).toEqual([]);
    expect(checkName('universal', 'x'.repeat(200), `/${'d'.repeat(300)}`)).toEqual([]);
  });
});
