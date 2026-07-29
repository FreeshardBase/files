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

const originalFilesRoot = process.env.FILES_ROOT;

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
      req.userRoot = userHome;
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
    if (originalFilesRoot !== undefined) {
      process.env.FILES_ROOT = originalFilesRoot;
    } else {
      delete process.env.FILES_ROOT;
    }
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

  test('Favorites API — Pin, list, move, and unpin files/folders (#28)', async () => {
    // 1. Pin a file and a folder
    const pinRes1 = await makeRequest('POST', '/api/files/local/favorites', {
      path: '/doc1.txt',
      item_type: 'file',
      title: 'Document 1'
    });
    assert.equal(pinRes1.status, 201);
    assert.equal(pinRes1.body.favorite.file_path, '/doc1.txt');

    const pinRes2 = await makeRequest('POST', '/api/files/local/favorites', {
      path: '/BatchSubFolder',
      item_type: 'folder',
      title: 'Batch SubFolder'
    });
    assert.equal(pinRes2.status, 201);

    // 2. GET favorites list
    const getRes = await makeRequest('GET', '/api/files/local/favorites');
    assert.equal(getRes.status, 200);
    assert.ok(Array.isArray(getRes.body.favorites));
    assert.equal(getRes.body.favorites.length, 2);
    const paths = getRes.body.favorites.map(f => f.file_path);
    assert.ok(paths.includes('/doc1.txt'));
    assert.ok(paths.includes('/BatchSubFolder'));

    // 3. Move pinned item and check that path updates in favorites
    const moveRes = await makeRequest('POST', '/api/files/local/move', {
      src: '/doc1.txt',
      dst: '/doc1_renamed.txt'
    });
    assert.equal(moveRes.status, 200);

    const getResAfterMove = await makeRequest('GET', '/api/files/local/favorites');
    const updatedPaths = getResAfterMove.body.favorites.map(f => f.file_path);
    assert.ok(updatedPaths.includes('/doc1_renamed.txt'));
    assert.ok(!updatedPaths.includes('/doc1.txt'));

    // 4. Delete favorite endpoint (unpin)
    const deleteFavRes = await makeRequest('DELETE', '/api/files/local/favorites?path=/doc1_renamed.txt');
    assert.equal(deleteFavRes.status, 200);
    assert.equal(deleteFavRes.body.success, true);

    const getResAfterUnpin = await makeRequest('GET', '/api/files/local/favorites');
    assert.equal(getResAfterUnpin.body.favorites.length, 1);
    assert.equal(getResAfterUnpin.body.favorites[0].file_path, '/BatchSubFolder');
  });

  test('Smart Folders & Saved Dynamic Search Views API (#46)', async () => {
    // 1. Create files in user home to test matching
    const userHome = path.join(TEST_ROOT, 'test_route_user');
    const lp = new LocalProvider({ userRoot: userHome });
    await lp.write('/Documents/report_2026.pdf', require('stream').Readable.from([Buffer.from('PDF Content Data')]));
    await lp.write('/Pictures/vacation_photo.png', require('stream').Readable.from([Buffer.from('PNG Data')]));
    await lp.write('/Documents/notes.txt', require('stream').Readable.from([Buffer.from('TXT Notes')]));

    // 2. Create a Smart Folder for PDF documents
    const createRes = await makeRequest('POST', '/api/files/local/smart-folders', {
      name: 'PDF Documents',
      query: 'report',
      filters: { extension: 'pdf', category: 'documents' }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.success, true);
    assert.ok(createRes.body.smartFolder.id);
    assert.equal(createRes.body.smartFolder.name, 'PDF Documents');

    const folderId = createRes.body.smartFolder.id;

    // 3. List all smart folders
    const listRes = await makeRequest('GET', '/api/files/local/smart-folders');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.smartFolders));
    assert.equal(listRes.body.smartFolders.length, 1);
    assert.equal(listRes.body.smartFolders[0].name, 'PDF Documents');

    // 4. Get smart folder details
    const getRes = await makeRequest('GET', `/api/files/local/smart-folders/${folderId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.smartFolder.name, 'PDF Documents');
    assert.equal(getRes.body.smartFolder.filters.extension, 'pdf');

    // 5. Evaluate smart folder contents dynamically
    const contentsRes = await makeRequest('GET', `/api/files/local/smart-folders/${folderId}/contents`);
    assert.equal(contentsRes.status, 200);
    assert.equal(contentsRes.body.success, true);
    assert.ok(Array.isArray(contentsRes.body.items));
    assert.equal(contentsRes.body.items.length, 1);
    assert.equal(contentsRes.body.items[0].name, 'report_2026.pdf');

    // 6. Update smart folder query/filters
    const updateRes = await makeRequest('PUT', `/api/files/local/smart-folders/${folderId}`, {
      name: 'All Images',
      query: '',
      filters: { category: 'images' }
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.smartFolder.name, 'All Images');

    // 7. Verify updated contents evaluation
    const updatedContentsRes = await makeRequest('GET', `/api/files/local/smart-folders/${folderId}/contents`);
    assert.equal(updatedContentsRes.status, 200);
    assert.equal(updatedContentsRes.body.items.length, 1);
    assert.equal(updatedContentsRes.body.items[0].name, 'vacation_photo.png');

    // 8. Delete smart folder
    const delRes = await makeRequest('DELETE', `/api/files/local/smart-folders/${folderId}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.success, true);

    const listResAfterDel = await makeRequest('GET', '/api/files/local/smart-folders');
    assert.equal(listResAfterDel.body.smartFolders.length, 0);
  });
});


