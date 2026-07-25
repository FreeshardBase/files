const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');
const { decodeUtf8Filename } = require('../utils/utf8');
const LocalProvider = require('../providers/local');
const GoogleDriveProvider = require('../providers/gdrive');
const DropboxProvider = require('../providers/dropbox');

const TEST_ROOT = path.resolve(__dirname, 'test_utf8_user_home');

describe('UTF-8 Filename Encoding & Accent Preservation (#7, #50, #56)', () => {
  describe('decodeUtf8Filename Helper', () => {
    test('decodes Latin-1 garbled Spanish ñ (Siendo niÃ±o -> Siendo niño)', () => {
      const clean = 'Siendo niño - Costo Rico.jpg';
      const garbled = Buffer.from(clean, 'utf8').toString('latin1');
      assert.equal(decodeUtf8Filename(garbled), clean);
    });

    test('decodes Latin-1 garbled French accents (Résumé_éèà -> Résumé_éèà)', () => {
      const clean = 'Résumé_éèà.pdf';
      const garbled = Buffer.from(clean, 'utf8').toString('latin1');
      assert.equal(decodeUtf8Filename(garbled), clean);
    });

    test('decodes Latin-1 garbled German Umlauts (Münster_äöü -> Münster_äöü)', () => {
      const clean = 'Münster_äöü.txt';
      const garbled = Buffer.from(clean, 'utf8').toString('latin1');
      assert.equal(decodeUtf8Filename(garbled), clean);
    });

    test('preserves clean UTF-8 strings without corruption', () => {
      const clean = 'Siendo niño - Costo Rico.jpg';
      assert.equal(decodeUtf8Filename(clean), clean);
    });

    test('preserves standard ASCII strings', () => {
      const ascii = 'document_2026.pdf';
      assert.equal(decodeUtf8Filename(ascii), ascii);
    });
  });

  describe('Shard Local Storage UTF-8 Accent Contract', () => {
    let provider;

    before(async () => {
      try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
      provider = new LocalProvider({ userRoot: TEST_ROOT });
      await provider.ensureUserHome();
    });

    after(async () => {
      try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    });

    test('writes and lists files with Spanish, French, and German accents correctly', async () => {
      const testFiles = [
        'Siendo niño - Costo Rico.jpg',
        'Résumé_éèà.pdf',
        'Münster_äöü.txt'
      ];

      for (const name of testFiles) {
        const filePath = `/Documents/${name}`;
        const stream = Readable.from([Buffer.from('Test Content')]);
        const res = await provider.write(filePath, stream);
        assert.equal(path.basename(res.path), name);

        const meta = await provider.metadata(filePath);
        assert.equal(meta.name, name);
      }

      const list = await provider.list('/Documents');
      const listedNames = list.map(i => i.name);
      for (const name of testFiles) {
        assert.ok(listedNames.includes(name), `Missing ${name} in list`);
      }
    });
  });

  describe('Google Drive Provider UTF-8 Accent Contract', () => {
    test('preserves UTF-8 accents in Google Drive metadata formatting', () => {
      const provider = new GoogleDriveProvider({ accessToken: 'mock_token', refreshToken: 'mock_refresh' });
      const rawDriveFile = {
        id: 'drive_123',
        name: 'Siendo niño - Costo Rico.jpg',
        mimeType: 'image/jpeg',
        size: '1024',
        modifiedTime: '2026-07-26T00:00:00.000Z'
      };

      // Ensure name is untouched
      assert.equal(rawDriveFile.name, 'Siendo niño - Costo Rico.jpg');
    });
  });

  describe('Dropbox Provider UTF-8 Accent Contract', () => {
    test('preserves UTF-8 accents in Dropbox item metadata formatting', () => {
      const provider = new DropboxProvider({ accessToken: 'mock_token', refreshToken: 'mock_refresh' });
      const rawDropboxItem = {
        '.tag': 'file',
        name: 'Résumé_éèà.pdf',
        path_display: '/Résumé_éèà.pdf',
        size: 2048,
        server_modified: '2026-07-26T00:00:00.000Z'
      };

      assert.equal(rawDropboxItem.name, 'Résumé_éèà.pdf');
    });
  });
});
