const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const filesRouter = require('../routes/files');
const providersRouter = require('../routes/providers');
const db = require('../db');

const LocalProvider = require('../providers/local');

const TEST_ROOT = path.resolve(__dirname, 'test_files_routes_user_home');

describe('Files & Provider API Route Integration Tests (#4, #7, #50, #56, Regression Protection)', () => {
  let app;
  let server;
  let baseUrl;

  before(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    const lp = new LocalProvider({ userRoot: TEST_ROOT });
    await lp.ensureUserHome();
    await db.initDb();
    await db.upsertUser('test_route_user', 'Route User', 'route@test.com');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = 'test_route_user';
      req.userRoot = TEST_ROOT;
      req.session = { user: { id: 'test_route_user' } };
      next();
    });

    app.use('/api/files/local', filesRouter);
    app.use('/api/providers', providersRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
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

  test('GET /api/files/local/list executes getLocalProvider without ReferenceError', async () => {
    const res = await makeRequest('GET', '/api/files/local/list?path=/');
    assert.equal(res.status, 200);
    assert.equal(res.body.path, '/');
    assert.ok(Array.isArray(res.body.items));
  });

  test('POST /api/files/local/mkdir creates folder cleanly', async () => {
    const res = await makeRequest('POST', '/api/files/local/mkdir', { path: '/RouteTestFolder' });
    if (res.status !== 201) console.error('mkdir Error Body:', res.body);
    assert.equal(res.status, 201);
    assert.equal(res.body.path, '/RouteTestFolder');
  });

  test('POST /api/files/local/move renames folder cleanly', async () => {
    const res = await makeRequest('POST', '/api/files/local/move', {
      src: '/RouteTestFolder',
      dst: '/RouteTestFolderRenamed'
    });
    if (res.status !== 200) console.error('move Error Body:', res.body);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  test('GET /api/files/local/read returns 404 for non-existent file without reference errors', async () => {
    const res = await makeRequest('GET', '/api/files/local/read?path=/nonexistent.txt');
    assert.equal(res.status, 404);
  });
});
