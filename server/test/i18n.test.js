const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { translate, resolveLocale, getTranslations } = require('../utils/i18n');

describe('Internationalization (i18n) (#25)', () => {
  test('resolves locale based on query parameter first', () => {
    const req = { query: { lang: 'de' }, headers: { 'accept-language': 'en' } };
    assert.equal(resolveLocale(req), 'de');
  });

  test('resolves locale based on session preference if no query parameter', () => {
    const req = { query: {}, session: { preferredLocale: 'de' }, headers: { 'accept-language': 'en' } };
    assert.equal(resolveLocale(req), 'de');
  });

  test('resolves locale based on Accept-Language header if no session preference', () => {
    const req = { query: {}, headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' } };
    assert.equal(resolveLocale(req), 'de');
  });

  test('defaults to English when no locale matches', () => {
    const req = { query: {}, headers: {} };
    assert.equal(resolveLocale(req), 'en');
  });

  test('translates keys accurately for English and German', () => {
    assert.equal(translate('en', 'app.title'), 'FreeShard Files');
    assert.equal(translate('de', 'app.title'), 'FreeShard Dateiverwaltung');
    assert.equal(translate('de', 'files.my_files'), 'Meine Dateien');
  });

  test('returns full dictionary structure for given locale', () => {
    const deDict = getTranslations('de');
    assert.equal(deDict.app.logout, 'Abmelden');
    assert.equal(deDict.files.upload, 'Hochladen');
  });
});
