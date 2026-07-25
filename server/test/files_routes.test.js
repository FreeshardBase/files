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
    process.env.FILES_ROOT = TEST_ROOT;
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    const userHome = path.join(TEST_ROOT, 'test_route_user');
    const lp = new LocalProvider({ userRoot: userHome });
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

  test('POST /api/files/local/move moves file hierarchically up to parent folder (Breadcrumb & Free space drop)', async () => {
    await makeRequest('POST', '/api/files/local/mkdir', { path: '/SubFolder' });
    const userHome = path.join(TEST_ROOT, 'test_route_user');
    const lp = new LocalProvider({ userRoot: userHome });
    await lp.write('/SubFolder/nested_item.txt', require('stream').Readable.from([Buffer.from('nested content')]));

    const res = await makeRequest('POST', '/api/files/local/move', {
      src: '/SubFolder/nested_item.txt',
      dst: '/nested_item.txt'
    });

    if (res.status !== 200) console.error('hierarchical move error:', res.body);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const rootList = await makeRequest('GET', '/api/files/local/list?path=/');
    const rootItemNames = rootList.body.items.map(i => i.name);
    assert.ok(rootItemNames.includes('nested_item.txt'));
  });

  test('POST /api/files/local/batch/move moves multiple selected items up to target parent folder', async () => {
    const userHome = path.join(TEST_ROOT, 'test_route_user');
    const lp = new LocalProvider({ userRoot: userHome });
    await lp.mkdir('/BatchSubFolder');
    await lp.write('/BatchSubFolder/doc1.txt', require('stream').Readable.from([Buffer.from('doc1')]));
    await lp.write('/BatchSubFolder/doc2.txt', require('stream').Readable.from([Buffer.from('doc2')]));

    const res = await makeRequest('POST', '/api/files/local/batch/move', {
      items: [
        { src: '/BatchSubFolder/doc1.txt', dst: '/doc1.txt' },
        { src: '/BatchSubFolder/doc2.txt', dst: '/doc2.txt' }
      ]
    });

    if (res.status !== 200) console.error('batch move error:', res.body);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const rootList = await makeRequest('GET', '/api/files/local/list?path=/');
    const rootItemNames = rootList.body.items.map(i => i.name);
    assert.ok(rootItemNames.includes('doc1.txt'));
    assert.ok(rootItemNames.includes('doc2.txt'));
  });
});
