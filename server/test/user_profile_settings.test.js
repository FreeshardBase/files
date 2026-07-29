// TDD: Issue #48 — User Profile & Settings Modal Enhancement (Display Name & Language)
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');

const db = require('../db');
const authRouter = require('../routes/auth');

describe('User Profile & Settings Modal Enhancement (#48)', () => {
  let app;
  let server;
  let baseUrl;
  const testUser = {
    id: 'user_profile_test_48',
    username: 'profile_test_48',
    email: 'profile48@example.com',
    displayName: 'Profile Tester'
  };

  before(async () => {
    await db.initDb();
    await db.run('DELETE FROM users WHERE id = ?', [testUser.id]);
    await db.upsertUser(testUser.id, testUser.username, testUser.email, 'local', null, testUser.displayName);

    app = express();
    app.use(express.json());

    // Simulate authenticated session
    app.use((req, res, next) => {
      req.session = {
        userId: testUser.id,
        username: testUser.username,
        displayName: testUser.displayName
      };
      next();
    });

    app.use('/api/auth', authRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM users WHERE id = ?', [testUser.id]);
  });

  function makeRequest(method, pathUrl, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathUrl, baseUrl);
      const payloadString = body ? JSON.stringify(body) : '';
      const req = http.request(url, {
        method,
        headers: body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadString)
        } : {}
      }, (res) => {
        let resBody = '';
        res.on('data', chunk => resBody += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resBody); } catch (e) {}
          resolve({ status: res.statusCode, body: json || resBody });
        });
      });
      req.on('error', reject);
      if (body) req.write(payloadString);
      req.end();
    });
  }

  test('PATCH /api/auth/users/me persists display_name to users table', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { displayName: 'Updated Display Name' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.user, 'response must include updated user object');

    // Verify persisted in DB
    const row = await db.get('SELECT display_name FROM users WHERE id = ?', [testUser.id]);
    assert.equal(row.display_name, 'Updated Display Name');
  });

  test('PATCH /api/auth/users/me persists preferredLocale "de" to users table', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { preferredLocale: 'de' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const row = await db.get('SELECT preferred_locale FROM users WHERE id = ?', [testUser.id]);
    assert.equal(row.preferred_locale, 'de');
  });

  test('PATCH /api/auth/users/me persists preferredLocale "en" to users table', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { preferredLocale: 'en' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const row = await db.get('SELECT preferred_locale FROM users WHERE id = ?', [testUser.id]);
    assert.equal(row.preferred_locale, 'en');
  });

  test('PATCH /api/auth/users/me rejects invalid preferredLocale values', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { preferredLocale: 'fr' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'must return error for unsupported locale');

    // DB must not be updated
    const row = await db.get('SELECT preferred_locale FROM users WHERE id = ?', [testUser.id]);
    assert.notEqual(row.preferred_locale, 'fr');
  });

  test('PATCH /api/auth/users/me can update displayName and preferredLocale together', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', {
      displayName: 'Combined Update',
      preferredLocale: 'de'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const row = await db.get('SELECT display_name, preferred_locale FROM users WHERE id = ?', [testUser.id]);
    assert.equal(row.display_name, 'Combined Update');
    assert.equal(row.preferred_locale, 'de');
  });

  test('GET /api/auth/me returns displayName and preferredLocale fields', async () => {
    // Set known state
    await db.run('UPDATE users SET display_name = ?, preferred_locale = ? WHERE id = ?',
      ['My Display Name', 'en', testUser.id]);

    const res = await makeRequest('GET', '/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.authenticated, true);
    assert.ok(res.body.user);
    assert.equal(res.body.user.displayName, 'My Display Name');
    assert.equal(res.body.user.preferredLocale, 'en');
  });

  test('index.html modalSettings contains inputDisplayName and selectLanguage fields', async () => {
    const indexHtml = await fs.readFile(path.join(__dirname, '../../public/index.html'), 'utf8');

    assert.ok(
      indexHtml.includes('id="inputDisplayName"'),
      'index.html must contain #inputDisplayName field in settings modal'
    );
    assert.ok(
      indexHtml.includes('id="selectLanguage"'),
      'index.html must contain #selectLanguage select in settings modal'
    );
    assert.ok(
      indexHtml.includes('value="de"') || indexHtml.includes("value='de'"),
      'index.html #selectLanguage must include a German (de) option'
    );
    assert.ok(
      indexHtml.includes('value="en"') || indexHtml.includes("value='en'"),
      'index.html #selectLanguage must include an English (en) option'
    );
  });

  test('filebrowser.js settings save handler sends displayName and preferredLocale in PATCH', async () => {
    const filebrowserJs = await fs.readFile(path.join(__dirname, '../../public/js/filebrowser.js'), 'utf8');

    assert.ok(
      filebrowserJs.includes('inputDisplayName'),
      'filebrowser.js must reference #inputDisplayName for settings save'
    );
    assert.ok(
      filebrowserJs.includes('selectLanguage'),
      'filebrowser.js must reference #selectLanguage for settings save'
    );
    assert.ok(
      filebrowserJs.includes('preferredLocale'),
      'filebrowser.js must send preferredLocale in the PATCH body'
    );
    assert.ok(
      filebrowserJs.includes('displayName'),
      'filebrowser.js must send displayName in the PATCH body'
    );
  });

  // ── Centralized Settings Management UI (#33) ──
  test('PATCH /api/auth/users/me persists preferredTheme to users table (#33)', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { preferredTheme: 'light' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const row = await db.get('SELECT preferred_theme FROM users WHERE id = ?', [testUser.id]);
    assert.equal(row.preferred_theme, 'light');
  });

  test('PATCH /api/auth/users/me rejects invalid preferredTheme values (#33)', async () => {
    const res = await makeRequest('PATCH', '/api/auth/users/me', { preferredTheme: 'invalid_theme' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'must return error for invalid theme');

    const row = await db.get('SELECT preferred_theme FROM users WHERE id = ?', [testUser.id]);
    assert.notEqual(row.preferred_theme, 'invalid_theme');
  });

  test('GET /api/auth/me returns preferredTheme field (#33)', async () => {
    await db.run('UPDATE users SET preferred_theme = ? WHERE id = ?', ['system', testUser.id]);

    const res = await makeRequest('GET', '/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.authenticated, true);
    assert.ok(res.body.user);
    assert.equal(res.body.user.preferredTheme, 'system');
  });

  test('index.html modalSettings contains selectTheme and appPasswordsSection (#33)', async () => {
    const indexHtml = await fs.readFile(path.join(__dirname, '../../public/index.html'), 'utf8');

    assert.ok(
      indexHtml.includes('id="selectTheme"'),
      'index.html must contain #selectTheme for theme tokens in settings modal'
    );
    assert.ok(
      indexHtml.includes('id="appPasswordsSection"'),
      'index.html must contain #appPasswordsSection for app passwords management'
    );
    assert.ok(
      indexHtml.includes('id="btnCreateAppPassword"'),
      'index.html must contain #btnCreateAppPassword button'
    );
  });

  test('filebrowser.js settings save handler sends preferredTheme and manages app passwords (#33)', async () => {
    const filebrowserJs = await fs.readFile(path.join(__dirname, '../../public/js/filebrowser.js'), 'utf8');

    assert.ok(
      filebrowserJs.includes('selectTheme'),
      'filebrowser.js must reference #selectTheme for theme settings save'
    );
    assert.ok(
      filebrowserJs.includes('preferredTheme'),
      'filebrowser.js must send preferredTheme in the PATCH body'
    );
    assert.ok(
      filebrowserJs.includes('/api/auth/app-passwords'),
      'filebrowser.js must reference app passwords endpoint'
    );
  });
});

