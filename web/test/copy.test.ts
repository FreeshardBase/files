import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import deDu from '../src/i18n/de-du.json';
import deSie from '../src/i18n/de-sie.json';
import en from '../src/i18n/en.json';

// #247: the copy review. Each message is rendered through vue-i18n as the app renders it, so a plural that never
// switches form, a lost quote or a straight apostrophe shows up as the member would read it.
const i18n = createI18n({ legacy: false, locale: 'de-du', messages: { 'de-du': deDu, 'de-sie': deSie, en } });
const { t } = i18n.global;
const tr = (locale: 'de-du' | 'de-sie' | 'en', key: string, named: Record<string, unknown> = {}, plural?: number) => {
  i18n.global.locale.value = locale;
  return plural === undefined ? t(key, named) : t(key, named, plural);
};
type Tree = { [k: string]: string | Tree };
const entries = (tree: Tree, p = ''): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => typeof v === 'string' ? [[p + k, v] as [string, string]] : entries(v, p + k + '.'));
const NBSP = ' ';

describe('plurals (C4)', () => {
  it('a count of one reads as one item, more as their number', () => {
    expect(tr('de-du', 'transfer.trashed', { count: 1 }, 1)).toBe('Ein Element in den Papierkorb verschoben');
    expect(tr('de-du', 'transfer.trashed', { count: 3 }, 3)).toBe('3 Elemente in den Papierkorb verschoben');
    expect(tr('en', 'transfer.trashed', { count: 1 }, 1)).toBe('One item moved to the trash');
    expect(tr('en', 'transfer.trashed', { count: 2 }, 2)).toBe('2 items moved to the trash');
    expect(tr('de-du', 'transfer.markedMove', { count: 1 }, 1)).toMatch(/^Ein Element zum Verschieben vorgemerkt\. Öffne /);
    expect(tr('de-sie', 'transfer.markedCopy', { count: 4 }, 4)).toMatch(/^4 Elemente zum Kopieren vorgemerkt\. Öffnen Sie /);
    expect(tr('en', 'transfer.markedMove', { count: 1 }, 1)).toMatch(/^One item ready to move\. /);
    expect(tr('en', 'transfer.markedCopy', { count: 2 }, 2)).toMatch(/^2 items ready to copy\. /);
    expect(tr('de-du', 'migrate.cleanup.confirmMessage', { count: 1, size: '1 KB', account: 'X' }, 1))
      .toMatch(/^Eine geprüfte Datei \(1 KB\) wird in X gelöscht und landet dort im Papierkorb\./);
    expect(tr('en', 'migrate.cleanup.confirmMessage', { count: 5, size: '1 KB', account: 'X' }, 5)).toMatch(/^5 verified files \(1 KB\) /);
    expect(tr('de-du', 'trash.confirmEmptyMessage', { count: 1 }, 1)).toMatch(/^Das Element im Papierkorb wird endgültig gelöscht\./);
    expect(tr('de-sie', 'trash.confirmEmptyMessage', { count: 7 }, 7)).toMatch(/^Alle 7 Elemente im Papierkorb werden /);
    expect(tr('de-du', 'errors.PURGE_FAILED', { count: 1 }, 1)).toMatch(/^Ein Element ließ sich nicht endgültig löschen\. Es bleibt /);
    expect(tr('en', 'errors.PURGE_FAILED', { count: 2 }, 2)).toMatch(/^2 items could not be deleted permanently\. They stay /);
  });
});

describe('punctuation and typography (C5)', () => {
  it('percent: a no-break space in German, none in English', () => {
    expect(tr('de-du', 'upload.state.uploading', { percent: 42 })).toBe(`42${NBSP}%`);
    expect(tr('de-sie', 'upload.state.uploading', { percent: 42 })).toBe(`42${NBSP}%`);
    expect(tr('en', 'upload.state.uploading', { percent: 42 })).toBe('42%');
  });
  it('English uses the typographic apostrophe and no space before an ellipsis', () => {
    for (const [k, v] of entries(en as Tree)) {
      expect(v, k).not.toContain("'");
      expect(v, k).not.toMatch(/\s…/);
    }
    expect(tr('en', 'search.searching')).toBe('Searching…');
    expect(tr('en', 'details.share')).toBe('Share…');
  });
  it('German keeps the ellipsis on its word with a no-break space', () => {
    for (const [name, tree] of [['de-du', deDu], ['de-sie', deSie]] as const) {
      for (const [k, v] of entries(tree as Tree)) expect(v, `${name} ${k}`).not.toMatch(/ …/);
    }
    expect(tr('de-du', 'search.searching')).toBe(`Suche läuft${NBSP}…`);
  });
  it('names in status lines are quoted, and shortcuts are written "Strg + C"', () => {
    expect(tr('de-du', 'upload.done', { name: 'a.txt' })).toBe('„a.txt“ hochgeladen');
    expect(tr('de-du', 'transfer.renamed', { name: 'b' })).toBe('Umbenannt in „b“');
    expect(tr('de-sie', 'link.revoked', { name: 'L' })).toBe('„L“ widerrufen');
    expect(tr('de-du', 'connections.unlinked', { account: 'A' })).toBe('„A“ getrennt');
    expect(tr('de-du', 'trash.restored', { name: 'n', folder: 'Mein Speicher › P' })).toBe('„n“ wiederhergestellt in „Mein Speicher › P“');
    expect(tr('en', 'upload.done', { name: 'a.txt' })).toBe('“a.txt” uploaded');
    expect(tr('en', 'connections.unlinked', { account: 'A' })).toBe('“A” disconnected');
    expect(tr('de-du', 'appPasswords.copyManually')).toContain('Strg + C');
    expect(tr('en', 'appPasswords.copyManually')).toContain('Ctrl + C');
  });
});

describe('wording for a family audience (C3, C6, C7)', () => {
  it('says what happened without technical terms', () => {
    expect(tr('de-du', 'settings.webdav.intro')).toContain('im Finder, im Windows-Explorer oder mit anderen Programmen.');
    expect(tr('en', 'settings.webdav.intro')).not.toMatch(/davfs2|rclone/);
    expect(tr('de-du', 'errors.VERIFY_FAILED')).toBe('Die Kopie ließ sich nicht prüfen: Am Ziel ist nicht genau das angekommen, was gesendet wurde. Das Original bleibt, wo es war.');
    expect(tr('en', 'errors.VERIFY_FAILED')).toBe('The copy could not be verified: what arrived does not match what was sent. The original stays where it was.');
    expect(tr('en', 'errors.OFFSET_MISMATCH')).toContain('out of step with the shard');
    expect(tr('de-du', 'errors.UPLOAD_LOCKED')).toBe('An diesem Upload wird gerade noch gearbeitet. Versuch es gleich noch einmal.');
    expect(tr('de-sie', 'errors.CONFIRMATION_REQUIRED')).toBe('Das müssen Sie erst bestätigen. Starten Sie es noch einmal und bestätigen Sie dann.');
    expect(tr('en', 'errors.PATH_SYMLINK')).toBe('Shortcuts are not opened, for security reasons.');
    expect(tr('de-du', 'errors.PRECONDITION_FAILED')).toContain('Lade die Seite neu und versuch es noch einmal.');
    expect(tr('de-du', 'errors.CSRF')).toBe('Das hat aus Sicherheitsgründen nicht geklappt. Lade die Seite neu und versuch es noch einmal.');
    expect(tr('en', 'errors.RANGE_NOT_SATISFIABLE')).toBe('The file could not be loaded. Try again.');
    expect(tr('de-du', 'errors.NOT_FOUND')).toBe('Dieses Element gibt es nicht oder nicht mehr.');
    for (const locale of ['de-du', 'de-sie'] as const) {
      expect(tr(locale, 'members.columns.quota')).toBe('Speicherlimit');
      expect(entries((locale === 'de-du' ? deDu : deSie) as Tree).filter(([, v]) => v.includes('Kontingent'))).toEqual([]);
    }
    expect(entries(en as Tree).filter(([, v]) => /\bquota\b/i.test(v.replace(/\{\w+\}/g, '')))).toEqual([]);
  });

  it('German grammar reads naturally', () => {
    expect(tr('de-du', 'link.expires', { date: '1. Mai' })).toBe('läuft am 1. Mai ab');
    expect(tr('de-du', 'link.expiryHint')).toBe('Leer lassen, wenn der Link nicht ablaufen soll.');
    expect(tr('de-du', 'link.passwordHint')).toBe('Leer lassen, wenn kein Passwort nötig ist.');
    expect(tr('de-du', 'trash.usage', { size: '3 MB' })).toBe('3 MB liegen im Papierkorb und zählen zu deinem Speicherplatz.');
    expect(tr('de-sie', 'trash.usage', { size: '3 MB' })).toBe('3 MB liegen im Papierkorb und zählen zu Ihrem Speicherplatz.');
    expect(tr('de-du', 'migrate.cleanup.intro', { account: 'X' })).toContain('Dateien, deren Umzug fehlgeschlagen ist oder die sich seit dem Umzug geändert haben, bleiben erhalten.');
    expect(tr('de-du', 'search.empty', { query: 'q' })).toBe('Kein Name enthält „q“.');
    expect(tr('de-sie', 'transfers.nothingToDo')).toBe('Nichts eingefügt: Alle Elemente wurden übersprungen.');
    expect(tr('de-du', 'settings.theme.system')).toBe('Wie auf dem Gerät');
    expect(tr('de-du', 'shortcuts.keys.open')).toBe('Eingabetaste');
    expect(tr('de-du', 'preview.pdfPrevious')).toBe('Vorherige Seite');
    expect(tr('de-sie', 'upload.dropHint', { folder: 'Fotos' })).toBe('Legen Sie Dateien oder Ordner hier ab, um sie in „Fotos“ hochzuladen.');
    expect(tr('de-sie', 'link.labelHint')).toBe('Nur für Sie sichtbar – z. B. für wen der Link gedacht ist');
  });

  it('English is consistent', () => {
    expect(tr('en', 'nav.migrate')).toBe(tr('en', 'migrate.title'));
    expect(tr('en', 'storage.noClouds')).toBe(tr('en', 'connections.empty'));
    expect(tr('en', 'connections.unlink')).toBe('Disconnect');
    expect(tr('en', 'errors.QUOTA_EXCEEDED')).toBe('There isn’t enough space left in your storage.');
    expect(tr('en', 'storage.usedNoQuota', { used: '1 MB' })).toBe('1 MB used · no limit');
    expect(tr('en', 'members.intro')).toMatch(/^Everyone who has signed in to “Files” at least once\./);
    expect(entries(en as Tree).filter(([k, v]) => k.startsWith('errors.') && /\bPlease\b/.test(v))).toEqual([]);
  });
});
