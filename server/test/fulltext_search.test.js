const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const filesRouter = require('../routes/files');

describe('Full-Text Search Indexing with SQLite FTS5 (#74)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-fts';
  let userBId = 'test-user-fts-b';
  let userHome;
  let userBHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_fts_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_fts.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'ftsuser', 'ftsuser@freeshard.local');
    await db.upsertUser(userBId, 'ftsuserb', 'ftsuserb@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    userBHome = path.join(dataDir, 'users', userBId);
    await fs.mkdir(path.join(userHome, 'Documents'), { recursive: true });
    await fs.mkdir(path.join(userBHome, 'Documents'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Mock authentication middleware using custom headers
    app.use((req, res, next) => {
      const activeUser = req.headers['x-test-user'] || userId;
      req.session = { user: { id: activeUser, username: activeUser } };
      req.userId = activeUser;
      req.userRoot = activeUser === userBId ? userBHome : userHome;
      next();
    });

    app.use('/api/files/local', filesRouter);
    app.use('/api/files', filesRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('DB Helpers: indexFileInFts and searchFulltext returns ranked results', async () => {
    await db.indexFileInFts(userId, '/Documents/notes.txt', 'notes.txt', 'The quick brown fox jumps over the lazy dog');
    await db.indexFileInFts(userId, '/Documents/summary.md', 'summary.md', 'Quick report on dog behavior and brown foxes in the forest');
    await db.indexFileInFts(userId, '/Pictures/fox.png', 'fox.png', '');

    const brownResults = await db.searchFulltext(userId, 'brown');
    assert.strictEqual(brownResults.length, 2);
    assert.ok(brownResults[0].snippet.includes('brown'));
    assert.ok(brownResults[0].rank !== undefined);

    const foxResults = await db.searchFulltext(userId, 'fox');
    assert.strictEqual(foxResults.length, 3);
  });

  test('DB Helpers: updateFtsPathOnMove and deleteFileFromFts update search index', async () => {
    await db.indexFileInFts(userId, '/Documents/to_move.txt', 'to_move.txt', 'unique content moving soon');
    
    let initialSearch = await db.searchFulltext(userId, 'moving');
    assert.strictEqual(initialSearch.length, 1);
    assert.strictEqual(initialSearch[0].path, '/Documents/to_move.txt');

    await db.updateFtsPathOnMove(userId, '/Documents/to_move.txt', '/Documents/moved_successfully.txt');
    let movedSearch = await db.searchFulltext(userId, 'moving');
    assert.strictEqual(movedSearch.length, 1);
    assert.strictEqual(movedSearch[0].path, '/Documents/moved_successfully.txt');

    await db.deleteFileFromFts(userId, '/Documents/moved_successfully.txt');
    let deletedSearch = await db.searchFulltext(userId, 'moving');
    assert.strictEqual(deletedSearch.length, 0);
  });

  test('DB Helpers: reindexUserFiles scans user root on disk', async () => {
    await fs.writeFile(path.join(userHome, 'Documents', 'contract.txt'), 'Freeshard contract agreement details 2026');
    await fs.writeFile(path.join(userHome, 'Documents', 'data.json'), '{"project": "Freeshard", "status": "active"}');

    const count = await db.reindexUserFiles(userId, userHome);
    assert.ok(count >= 2);

    const contractSearch = await db.searchFulltext(userId, 'agreement');
    assert.strictEqual(contractSearch.length, 1);
    assert.strictEqual(contractSearch[0].path, '/Documents/contract.txt');
  });

  test('API Endpoint: GET /api/files/search/fulltext validates query and returns ranked results', async () => {
    await db.indexFileInFts(userId, '/Documents/api_test.txt', 'api_test.txt', 'Antigravity framework fulltext search verification');

    // Missing q parameter
    const resNoQ = await fetch(`${serverUrl}/api/files/search/fulltext`);
    assert.strictEqual(resNoQ.status, 400);

    // Valid search query
    const res = await fetch(`${serverUrl}/api/files/search/fulltext?q=Antigravity`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.query, 'Antigravity');
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length >= 1);
    assert.strictEqual(body.results[0].path, '/Documents/api_test.txt');
  });

  test('API Endpoint: GET /api/files/search/fulltext enforces user isolation', async () => {
    await db.indexFileInFts(userId, '/Documents/secret_a.txt', 'secret_a.txt', 'Secret key for User A');
    await db.indexFileInFts(userBId, '/Documents/secret_b.txt', 'secret_b.txt', 'Secret key for User B');

    // User A query
    const resA = await fetch(`${serverUrl}/api/files/search/fulltext?q=Secret`, {
      headers: { 'x-test-user': userId }
    });
    const bodyA = await resA.json();
    const pathsA = bodyA.results.map(r => r.path);
    assert.ok(pathsA.includes('/Documents/secret_a.txt'));
    assert.ok(!pathsA.includes('/Documents/secret_b.txt'));

    // User B query
    const resB = await fetch(`${serverUrl}/api/files/search/fulltext?q=Secret`, {
      headers: { 'x-test-user': userBId }
    });
    const bodyB = await resB.json();
    const pathsB = bodyB.results.map(r => r.path);
    assert.ok(pathsB.includes('/Documents/secret_b.txt'));
    assert.ok(!pathsB.includes('/Documents/secret_a.txt'));
  });

  test('API Endpoint: POST /api/files/search/reindex triggers full-text reindexing', async () => {
    await fs.writeFile(path.join(userHome, 'Documents', 'reindex_test.txt'), 'Dynamic content reindexed via API');

    const res = await fetch(`${serverUrl}/api/files/search/reindex`, {
      method: 'POST'
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(body.indexed_count > 0);

    const searchRes = await fetch(`${serverUrl}/api/files/search/fulltext?q=Dynamic`);
    const searchBody = await searchRes.json();
    assert.ok(searchBody.results.some(r => r.path === '/Documents/reindex_test.txt'));
  });
});
