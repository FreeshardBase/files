/**
 * Tests for Issue #62 — Freeshard Ecosystem Integration (Paperless-ngx & Immich)
 *
 * Tests cover:
 *  1. DB helpers: createEcosystemIngestLog, getEcosystemIngestLogs
 *  2. POST /api/ecosystem/ingest/paperless — happy path, 400 on missing path
 *  3. POST /api/ecosystem/ingest/immich   — happy path, 400 on missing path
 *  4. Route rejects unauthenticated requests
 *  5. Context menu markup present in index.html
 *  6. Paperless endpoint: PAPERLESS_URL not configured returns 503
 *  7. Immich endpoint: IMMICH_URL not configured returns 503
 *  8. GET /api/ecosystem/ingest/logs — returns per-user ingest history
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');

const db = require('../db');

describe('Freeshard Ecosystem Integration (#62)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'test-user-ecosystem';

  before(async () => {
    dataDir = path.join(__dirname, 'data_ecosystem_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_ecosystem.db');
    await fs.mkdir(dataDir, { recursive: true });

    // Create a dummy local file for the user
    const userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });
    await fs.writeFile(path.join(userHome, 'invoice.pdf'), '%PDF-1.4 fake content');
    await fs.writeFile(path.join(userHome, 'photo.jpg'), Buffer.alloc(512));

    await db.initDb();
    await db.upsertUser(userId, 'ecosystemuser', 'ecosystem@freeshard.local');

    // Require router AFTER db is initialised
    const ecosystemRouter = require('../routes/ecosystem');

    app = express();
    app.use(express.json());
    app.use(session({ secret: 'test_secret', resave: false, saveUninitialized: true }));

    // Mock auth
    app.use((req, res, next) => {
      if (req.headers['x-skip-auth'] === 'true') return next(); // unauthenticated scenario
      req.session.userId = userId;
      next();
    });

    // Inject userRoot (mimics isolation middleware)
    app.use((req, res, next) => {
      if (req.session.userId) {
        req.userId = req.session.userId;
        req.userRoot = path.join(dataDir, 'users', req.session.userId);
      }
      next();
    });

    app.use('/api/ecosystem', ecosystemRouter);

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── 1. DB Helpers ─────────────────────────────────────────────────────────

  test('DB: createEcosystemIngestLog and getEcosystemIngestLogs round-trip', async () => {
    const entry = await db.createEcosystemIngestLog({
      userId,
      filePath: '/invoice.pdf',
      fileName: 'invoice.pdf',
      target: 'paperless',
      status: 'success',
      remoteId: 'pl-doc-42',
      details: null
    });

    assert.ok(entry.id);
    assert.equal(entry.user_id, userId);
    assert.equal(entry.target, 'paperless');
    assert.equal(entry.status, 'success');
    assert.equal(entry.remote_id, 'pl-doc-42');

    const logs = await db.getEcosystemIngestLogs(userId);
    assert.ok(Array.isArray(logs));
    assert.ok(logs.length >= 1);
    assert.equal(logs[0].file_path, '/invoice.pdf');
  });

  // ── 2. POST paperless — happy path ────────────────────────────────────────

  test('POST /api/ecosystem/ingest/paperless — happy path (mocked HTTP)', async () => {
    // Configure Paperless with a mock URL pointing to our test server
    // We spin up a tiny mock paperless endpoint on the same server
    const origUrl = process.env.PAPERLESS_URL;
    const origToken = process.env.PAPERLESS_API_TOKEN;

    // Use an echo route on our test server as Paperless mock
    app.post('/mock-paperless/api/documents/post_document/', (req, res) => {
      // Paperless returns { id: <number> } on success
      res.json({ id: 99 });
    });

    process.env.PAPERLESS_URL = serverUrl + '/mock-paperless';
    process.env.PAPERLESS_API_TOKEN = 'test-token-pl';

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/paperless`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/invoice.pdf' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.target, 'paperless');
    assert.ok(body.remoteId !== undefined);

    // Restore
    if (origUrl) process.env.PAPERLESS_URL = origUrl;
    else delete process.env.PAPERLESS_URL;
    if (origToken) process.env.PAPERLESS_API_TOKEN = origToken;
    else delete process.env.PAPERLESS_API_TOKEN;
  });

  // ── 3. POST immich — happy path ───────────────────────────────────────────

  test('POST /api/ecosystem/ingest/immich — happy path (mocked HTTP)', async () => {
    const origUrl = process.env.IMMICH_URL;
    const origKey = process.env.IMMICH_API_KEY;

    // Mock Immich asset upload endpoint
    app.post('/mock-immich/api/assets', (req, res) => {
      res.json({ id: 'immich-asset-uuid-123', status: 'created' });
    });

    process.env.IMMICH_URL = serverUrl + '/mock-immich';
    process.env.IMMICH_API_KEY = 'test-api-key-immich';

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/immich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/photo.jpg' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.target, 'immich');
    assert.ok(body.remoteId !== undefined);

    if (origUrl) process.env.IMMICH_URL = origUrl;
    else delete process.env.IMMICH_URL;
    if (origKey) process.env.IMMICH_API_KEY = origKey;
    else delete process.env.IMMICH_API_KEY;
  });

  // ── 4. 400 on missing filePath ─────────────────────────────────────────────

  test('POST /api/ecosystem/ingest/paperless — 400 if filePath missing', async () => {
    process.env.PAPERLESS_URL = 'http://paperless.local';
    process.env.PAPERLESS_API_TOKEN = 'tok';

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/paperless`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);

    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_API_TOKEN;
  });

  test('POST /api/ecosystem/ingest/immich — 400 if filePath missing', async () => {
    process.env.IMMICH_URL = 'http://immich.local';
    process.env.IMMICH_API_KEY = 'key';

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/immich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);

    delete process.env.IMMICH_URL;
    delete process.env.IMMICH_API_KEY;
  });

  // ── 5. 503 when service URL not configured ─────────────────────────────────

  test('POST /api/ecosystem/ingest/paperless — 503 if PAPERLESS_URL not configured', async () => {
    const prev = process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_URL;

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/paperless`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/invoice.pdf' })
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error);

    if (prev) process.env.PAPERLESS_URL = prev;
  });

  test('POST /api/ecosystem/ingest/immich — 503 if IMMICH_URL not configured', async () => {
    const prev = process.env.IMMICH_URL;
    delete process.env.IMMICH_URL;

    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/immich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: '/photo.jpg' })
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error);

    if (prev) process.env.IMMICH_URL = prev;
  });

  // ── 6. GET /api/ecosystem/ingest/logs ─────────────────────────────────────

  test('GET /api/ecosystem/ingest/logs — returns ingest history for user', async () => {
    const res = await fetch(`${serverUrl}/api/ecosystem/ingest/logs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.logs));
    // At least the record created in test 1 should be present
    assert.ok(body.logs.length >= 1);
    assert.equal(body.logs[0].user_id, userId);
  });

  // ── 7. 401 without session ─────────────────────────────────────────────────

  test('Routes return 401 for unauthenticated requests', async () => {
    // Use a separate app without the auth mock
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use(session({ secret: 'bare', resave: false, saveUninitialized: false }));
    // No mock auth → session.userId will be undefined
    const ecosystemRouter = require('../routes/ecosystem');
    bareApp.use('/api/ecosystem', ecosystemRouter);

    const bareServer = await new Promise(resolve => {
      const s = bareApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const bareUrl = `http://127.0.0.1:${bareServer.address().port}`;

    try {
      const res = await fetch(`${bareUrl}/api/ecosystem/ingest/paperless`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: '/invoice.pdf' })
      });
      assert.equal(res.status, 401);
    } finally {
      await new Promise(resolve => bareServer.close(resolve));
    }
  });

  // ── 8. index.html context menu markup ─────────────────────────────────────

  test('index.html context menu contains Paperless-ngx and Immich ingest items', () => {
    const html = fss.readFileSync(
      path.join(__dirname, '../../public/index.html'),
      'utf8'
    );
    assert.ok(
      html.includes('ctxIngestPaperless'),
      'index.html must have ctxIngestPaperless context menu item'
    );
    assert.ok(
      html.includes('ctxIngestImmich'),
      'index.html must have ctxIngestImmich context menu item'
    );
    assert.ok(
      html.includes('Paperless-ngx'),
      'index.html must mention Paperless-ngx'
    );
    assert.ok(
      html.includes('Immich'),
      'index.html must mention Immich'
    );
  });

  // ── 9. filebrowser.js ecosystem handler stubs ─────────────────────────────

  test('filebrowser.js contains ecosystem ingest handler functions', () => {
    const js = fss.readFileSync(
      path.join(__dirname, '../../public/js/filebrowser.js'),
      'utf8'
    );
    assert.ok(
      js.includes('ingestPaperless') || js.includes('ingest/paperless'),
      'filebrowser.js must include Paperless ingest logic'
    );
    assert.ok(
      js.includes('ingestImmich') || js.includes('ingest/immich'),
      'filebrowser.js must include Immich ingest logic'
    );
  });
});
