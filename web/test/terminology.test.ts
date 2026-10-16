import { describe, expect, it } from 'vitest';
import deDu from '../src/i18n/de-du.json';
import deSie from '../src/i18n/de-sie.json';
import en from '../src/i18n/en.json';

// #246: the wording the UI shows. Sharing with members is "Freigabe"/"freigeben"; "teilen" is left to the OS share
// sheet (shareTarget.*) and the visitor's public-link page (link.page.*). The German app name is „Dateien“, quoted.
type Tree = { [k: string]: string | Tree };
const entries = (t: Tree, p = ''): [string, string][] =>
  Object.entries(t).flatMap(([k, v]) => typeof v === 'string' ? [[p + k, v] as [string, string]] : entries(v, p + k + '.'));
const at = (t: unknown, key: string): string => key.split('.').reduce<unknown>((n, k) => (n as Tree)[k], t) as string;
const german = [['de-du', deDu], ['de-sie', deSie]] as const;

describe('German terminology (#246)', () => {
  it('sharing with members is "freigeben" in both address forms', () => {
    for (const [, t] of german) {
      expect(at(t, 'actions.share')).toBe('Freigeben');
      expect(at(t, 'share.submit')).toBe('Freigeben');
      expect(at(t, 'share.title')).toBe('„{name}“ freigeben');
      expect(at(t, 'details.share')).toBe('Freigeben …');
      expect(at(t, 'nav.shared')).toBe('Für mich freigegeben');
      expect(at(t, 'shared.title')).toBe('Für mich freigegeben');
      expect(at(t, 'share.shared')).toBe('Für {name} freigegeben: {access}');
      expect(at(t, 'shared.columns.owner')).toBe('Freigegeben von');
      expect(at(t, 'shared.columns.shared')).toBe('Freigegeben am');
      expect(at(t, 'errors.SHARE_ORPHANED')).toBe('Diese Freigabe gibt es nicht mehr: Die Person, die sie erstellt hat, hat das Element gelöscht.');
      expect(at(t, 'connections.unlinkMessage')).toMatch(/^Freigaben und öffentliche Links aus diesem Konto /);
    }
    expect(at(deDu, 'shared.empty')).toBe('Für dich wurde noch nichts freigegeben.');
    expect(at(deSie, 'shared.empty')).toBe('Für Sie wurde noch nichts freigegeben.');
  });

  it('"teilen" appears only for the OS share sheet and the public-link page', () => {
    for (const [name, t] of german) {
      const offenders = entries(t as Tree)
        .filter(([k, v]) => /teil(en|t|te)\b|Geteilt/i.test(v) && !k.startsWith('shareTarget.') && !k.startsWith('link.page.'));
      expect(offenders, name).toEqual([]);
    }
  });

  it('the app is „Dateien“, quoted, and never "Files"', () => {
    for (const [name, t] of german) {
      expect(at(t, 'app.name')).toBe('Dateien');
      for (const [k, v] of entries(t as Tree)) expect(v, `${name} ${k}`).not.toMatch(/\bFiles\b/);
      expect(at(t, 'members.intro')).toMatch(/^Alle, die sich schon einmal bei „Dateien“ angemeldet haben\. /);
      expect(at(t, 'signedOut.text')).toContain('von „Dateien“ abgemeldet');
    }
    expect(at(deDu, 'shareTarget.missing')).toBe('Hier gibt es nichts zu speichern. Entweder wurden die Dateien schon gespeichert, oder das Teilen ist nicht bei „Dateien“ angekommen: Öffne „Dateien“ einmal und teile dann noch einmal.');
    expect(at(deSie, 'shareTarget.missing')).toBe('Hier gibt es nichts zu speichern. Entweder wurden die Dateien schon gespeichert, oder das Teilen ist nicht bei „Dateien“ angekommen: Öffnen Sie „Dateien“ einmal und teilen Sie dann noch einmal.');
    expect(at(deDu, 'shareTarget.intro')).toBe('Wähle den Ordner in „Mein Speicher“ für die geteilte Datei. | Wähle den Ordner in „Mein Speicher“ für die {count} geteilten Dateien.');
    expect(at(deSie, 'shareTarget.intro')).toBe('Wählen Sie den Ordner in „Mein Speicher“ für die geteilte Datei. | Wählen Sie den Ordner in „Mein Speicher“ für die {count} geteilten Dateien.');
  });

  it('items are "Elemente"; "Eintrag" is kept for list rows in the shortcuts', () => {
    for (const [name, t] of german) {
      const offenders = entries(t as Tree).filter(([k, v]) => /Eintr(a|ä)g/.test(v) && !k.startsWith('shortcuts.'));
      expect(offenders, name).toEqual([]);
      expect(at(t, 'errors.FILE_EXISTS')).toBe('Hier gibt es schon ein Element mit diesem Namen.');
      expect(at(t, 'errors.AMBIGUOUS_NAME')).toMatch(/heißen mehrere Elemente „\{name\}“\./);
      expect(at(t, 'collision.applyAll')).toBe('Für alle weiteren Elemente übernehmen ({count})');
    }
  });

  it('a place is a "Ort", storage without a limit is "unbegrenzt", and the other single-word fixes', () => {
    for (const [, t] of german) {
      expect(at(t, 'errors.NOT_SUPPORTED')).toBe('Dieser Ort bietet das nicht an.');
      expect(at(t, 'storage.usedNoQuota')).toBe('{used} belegt · unbegrenzt');
      expect(at(t, 'storage.cloudUsedNoLimit')).toBe('{used} belegt · unbegrenzt');
      expect(at(t, 'errors.UNSUPPORTED_MEDIA_TYPE')).toBe('Dieser Dateityp wird hier nicht angenommen.');
      expect(at(t, 'nav.recent')).toBe(at(t, 'recent.title'));
      expect(at(t, 'nav.recent')).toBe('Zuletzt geändert');
      expect(at(t, 'migrate.intro')).toContain('in einem Durchgang auf den Shard');
    }
    expect(at(deDu, 'errors.SOURCE_NOT_FOUND')).toBe('Diesen Ort gibt es nicht, oder du hast keinen Zugriff darauf.');
    expect(at(deSie, 'errors.SOURCE_NOT_FOUND')).toBe('Diesen Ort gibt es nicht, oder Sie haben keinen Zugriff darauf.');
    expect(at(deDu, 'errors.QUOTA_EXCEEDED')).toBe('Dafür reicht dein Speicherplatz nicht mehr.');
    expect(at(deSie, 'errors.QUOTA_EXCEEDED')).toBe('Dafür reicht Ihr Speicherplatz nicht mehr.');
  });
});

describe('Du/Sie consistency (#246)', () => {
  it('Deutsch (Du) never says "Bitte versuche … erneut"; it says "Versuch es … noch einmal"', () => {
    for (const [k, v] of entries(deDu as Tree)) expect(v, k).not.toMatch(/Bitte (versuche|warte)|versuche es/);
    expect(at(deDu, 'errors.CONNECT_FAILED')).toBe('Das Konto konnte nicht verbunden werden. Versuch es noch einmal.');
    expect(at(deDu, 'errors.PROVIDER_UNAVAILABLE')).toBe('Der Cloud-Anbieter ist gerade nicht erreichbar. Versuch es später noch einmal.');
    expect(at(deDu, 'errors.TOO_MANY_ATTEMPTS')).toBe('Zu viele falsche Passwörter. Warte ein paar Minuten und versuch es dann noch einmal.');
  });
  it('Deutsch (Sie) does not read the files as the formal "Sie", and asks the collision question formally', () => {
    expect(at(deSie, 'migrate.cleanup.intro')).not.toMatch(/\. Sie landen/);
    expect(at(deSie, 'migrate.cleanup.intro')).toContain('Die Dateien landen im Papierkorb des Anbieters.');
    expect(at(deSie, 'collision.title')).toBe('Name schon vergeben');
    expect(at(deSie, 'collision.message')).toBe('„{name}“ gibt es hier schon. Was möchten Sie tun?');
  });
});

describe('English terminology (#246)', () => {
  it('a place is a "place", and names are quoted', () => {
    expect(at(en, 'errors.NOT_SUPPORTED')).toBe('This place doesn\'t offer that.');
    expect(at(en, 'errors.SOURCE_NOT_FOUND')).toBe('This place doesn\'t exist or isn\'t available to you.');
    expect(at(en, 'shareTarget.intro')).toBe('Choose the folder in “My storage” for the shared file. | Choose the folder in “My storage” for the {count} shared files.');
    expect(at(en, 'shareTarget.missing')).toBe('Nothing to save here. Either the files were already saved, or the share did not reach “Files”: open “Files” once, then share again.');
    expect(at(en, 'members.intro')).toMatch(/^Everyone who has signed in to “Files” before\. /);
    expect(at(en, 'signedOut.text')).toContain('signed out of “Files” on this device');
  });
});
