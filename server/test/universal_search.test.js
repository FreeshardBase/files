const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const searchRouter = require('../routes/search');

function httpRequest(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const reqHeaders = { ...headers };
      let payload = null;

      if (body && typeof body === 'object' && !headers['Content-Type']) {
        payload = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      } else if (typeof body === 'string') {
        payload = body;
        if (!reqHeaders['Content-Length']) {
          reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: reqHeaders
      }, (res) => {
        let resData = '';
        res.on('data', chunk => resData += chunk);
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = JSON.parse(resData); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || resData });
        });
      });

      req.on('error', err => {
        server.close();
        reject(err);
      });

      if (payload) req.write(payload);
      req.end();
    });
  });
}

function createTestApp(userId = 'test-user-universal-search') {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_secret',
    resave: false,
    saveUninitialized: true
  }));

  app.use((req, res, next) => {
    if (userId) {
      req.userId = userId;
      req.session.userId = userId;
      req.session.user = { id: userId, username: 'universal_user' };
    }
    next();
  });

  app.use('/api/search', searchRouter);
  return app;
}

test('Freeshard Ecosystem Universal Search & Cross-App Deep Links (#100)', async (t) => {
  const userId = 'test-user-universal-search';
  const otherUserId = 'other-user-universal-search';

  await db.initDb();
  await db.upsertUser(userId, 'universal_user', 'universal@test.local');
  await db.upsertUser(otherUserId, 'other_user', 'other@test.local');

  // Clear relevant tables for test isolation
  await db.run('DELETE FROM files_fts WHERE user_id IN (?, ?)', [userId, otherUserId]);
  await db.run('DELETE FROM public_shares WHERE user_id IN (?, ?)', [userId, otherUserId]);
  await db.run('DELETE FROM file_shares WHERE owner_user_id IN (?, ?) OR sharee_user_id IN (?, ?)', [userId, otherUserId, userId, otherUserId]);
  await db.run('DELETE FROM file_tags WHERE user_id IN (?, ?)', [userId, otherUserId]);
  await db.run('DELETE FROM ecosystem_ingest_log WHERE user_id IN (?, ?)', [userId, otherUserId]);

  const app = createTestApp(userId);

  await t.test('DB Helper operations for searchUniversal', async () => {
    // Index file
    await db.indexFileInFts(userId, '/documents/project_alpha.pdf', 'project_alpha.pdf', 'Alpha project financial forecast report');
    
    // Create public share
    await db.createPublicShare(userId, 'alpha-token-123', '/documents/project_alpha.pdf', 0, null, null, null, 'Alpha Project Presentation');

    // Create tag
    await db.assignTag(userId, '/documents/project_alpha.pdf', 'AlphaTag', '#FF0000');

    // Create ecosystem log
    await db.createEcosystemIngestLog({
      userId,
      filePath: '/documents/project_alpha.pdf',
      fileName: 'project_alpha.pdf',
      target: 'paperless',
      status: 'success',
      remoteId: 'paperless-doc-42',
      details: 'Ingested into Paperless-ngx'
    });

    const searchRes = await db.searchUniversal(userId, 'Alpha');
    assert.ok(searchRes.files.length >= 1, 'Should find matching file');
    assert.ok(searchRes.shares.length >= 1, 'Should find matching public share');
    assert.ok(searchRes.tags.length >= 1, 'Should find matching tag');
    assert.ok(searchRes.ecosystem.length >= 1, 'Should find matching ecosystem ingest log');

    // Verify deep links structure
    const paperlessResult = searchRes.ecosystem.find(e => e.target === 'paperless');
    assert.ok(paperlessResult.deepLink.includes('/documents/paperless-doc-42'), 'Should contain Paperless deep link');

    const shareResult = searchRes.shares[0];
    assert.ok(shareResult.deepLink.includes('/s/alpha-token-123'), 'Should contain public share deep link');
  });

  await t.test('API Endpoint GET /api/search/universal — validation and results', async () => {
    const resNoQ = await httpRequest(app, 'GET', '/api/search/universal');
    assert.equal(resNoQ.status, 400, 'Should return 400 when query parameter q is missing');

    const res = await httpRequest(app, 'GET', '/api/search/universal?q=Alpha');
    assert.equal(res.status, 200, 'Should return 200 for valid search');
    assert.equal(res.body.query, 'Alpha');
    assert.ok(Array.isArray(res.body.results.files), 'files should be an array');
    assert.ok(Array.isArray(res.body.results.shares), 'shares should be an array');
    assert.ok(Array.isArray(res.body.results.tags), 'tags should be an array');
    assert.ok(Array.isArray(res.body.results.ecosystem), 'ecosystem should be an array');
    assert.ok(Array.isArray(res.body.deepLinks), 'deepLinks should be an aggregated array');

    assert.ok(res.body.deepLinks.some(dl => dl.type === 'paperless' && dl.url.includes('paperless-doc-42')));
    assert.ok(res.body.deepLinks.some(dl => dl.type === 'public_share' && dl.url.includes('alpha-token-123')));
  });

  await t.test('API Endpoint GET /api/search/universal — user isolation', async () => {
    // Index item for other user
    await db.indexFileInFts(otherUserId, '/secret/classified_bravo.txt', 'classified_bravo.txt', 'Bravo secret information');
    await db.createPublicShare(otherUserId, 'bravo-token-999', '/secret/classified_bravo.txt', 0, null, null, null, 'Bravo Share');

    const resUserA = await httpRequest(app, 'GET', '/api/search/universal?q=Bravo');
    assert.equal(resUserA.status, 200);
    assert.equal(resUserA.body.results.files.length, 0, 'User A should not see User B files');
    assert.equal(resUserA.body.results.shares.length, 0, 'User A should not see User B shares');

    const appUserB = createTestApp(otherUserId);
    const resUserB = await httpRequest(appUserB, 'GET', '/api/search/universal?q=Bravo');
    assert.equal(resUserB.status, 200);
    assert.equal(resUserB.body.results.files.length, 1, 'User B should see their own file');
    assert.equal(resUserB.body.results.shares.length, 1, 'User B should see their own share');
  });
});
