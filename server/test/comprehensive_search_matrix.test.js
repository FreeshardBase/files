const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const searchRouter = require('../routes/search');

describe('Comprehensive Search Functionality Matrix Test Suite (#100)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userA = 'user_search_matrix_a';
  const userB = 'user_search_matrix_b';

  before(async () => {
    dataDir = path.join(__dirname, 'data_search_matrix_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_search_matrix.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userA, 'usera', 'usera@freeshard.test');
    await db.upsertUser(userB, 'userb', 'userb@freeshard.test');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const activeUser = req.headers['x-test-user'] || userA;
      req.userId = activeUser;
      req.session = { userId: activeUser, user: { id: activeUser, username: activeUser } };
      next();
    });
    app.use('/api/search', searchRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Validation: Missing, empty, null, or whitespace queries return HTTP 400', async () => {
    // Missing query parameter
    const res1 = await fetch(`${serverUrl}/api/search/universal`);
    assert.strictEqual(res1.status, 400);
    const body1 = await res1.json();
    assert.ok(body1.error);

    // Empty query parameter
    const res2 = await fetch(`${serverUrl}/api/search/universal?q=`);
    assert.strictEqual(res2.status, 400);

    // Whitespace only query parameter
    const res3 = await fetch(`${serverUrl}/api/search/universal?q=%20%20%20`);
    assert.strictEqual(res3.status, 400);
  });

  test('Empty result handling: Returns HTTP 200 with empty arrays when no match exists', async () => {
    const res = await fetch(`${serverUrl}/api/search/universal?q=nonexistent_query_xyz_999`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.query, 'nonexistent_query_xyz_999');
    assert.deepStrictEqual(body.results.files, []);
    assert.deepStrictEqual(body.results.shares, []);
    assert.deepStrictEqual(body.results.tags, []);
    assert.deepStrictEqual(body.results.ecosystem, []);
    assert.deepStrictEqual(body.deepLinks, []);
  });

  test('Special characters & SQL injection attempts safety', async () => {
    // Seed a file for testing safe matching
    await db.indexFileInFts(userA, '/docs/sql_injection.txt', 'sql_injection.txt', 'contains literal text string');

    const injectionPayloads = [
      "' OR 1=1 --",
      "'; DROP TABLE users; --",
      "%' AND 1=1 AND '%'='",
      "%",
      "_",
      "*",
      "?",
      "\\",
      "\""
    ];

    for (const payload of injectionPayloads) {
      const res = await fetch(`${serverUrl}/api/search/universal?q=${encodeURIComponent(payload)}`);
      assert.strictEqual(res.status, 200, `Payload "${payload}" should be handled safely and return HTTP 200`);
      const body = await res.json();
      assert.ok(Array.isArray(body.results.files), `Files should be an array for payload "${payload}"`);
      assert.ok(Array.isArray(body.results.shares));
      assert.ok(Array.isArray(body.results.tags));
      assert.ok(Array.isArray(body.results.ecosystem));
    }
  });

  test('UTF-8 Accents and International Characters (Münster, ñ, Umlauts)', async () => {
    await db.indexFileInFts(userA, '/docs/Münster_Report.pdf', 'Münster_Report.pdf', 'Financial report for Münster headquarters');
    await db.indexFileInFts(userA, '/docs/español_noticia.txt', 'español_noticia.txt', 'Noticias en español para la comunidad');

    // Query for Münster
    const resMunster = await fetch(`${serverUrl}/api/search/universal?q=${encodeURIComponent('Münster')}`);
    assert.strictEqual(resMunster.status, 200);
    const bodyMunster = await resMunster.json();
    assert.ok(bodyMunster.results.files.some(f => f.filename.includes('Münster')));

    // Query for español
    const resEspanol = await fetch(`${serverUrl}/api/search/universal?q=${encodeURIComponent('español')}`);
    assert.strictEqual(resEspanol.status, 200);
    const bodyEspanol = await resEspanol.json();
    assert.ok(bodyEspanol.results.files.some(f => f.filename.includes('español')));
  });

  test('Exact vs. Partial Substring Matching & Case-Insensitivity', async () => {
    await db.indexFileInFts(userA, '/code/SuperWidgetImplementation.js', 'SuperWidgetImplementation.js', 'Class SuperWidget extends BaseComponent');

    // Partial substring (lowercase)
    const resPartial = await fetch(`${serverUrl}/api/search/universal?q=widget`);
    assert.strictEqual(resPartial.status, 200);
    const bodyPartial = await resPartial.json();
    assert.ok(bodyPartial.results.files.some(f => f.filename === 'SuperWidgetImplementation.js'));

    // Exact string (mixed case)
    const resExact = await fetch(`${serverUrl}/api/search/universal?q=SuperWidget`);
    assert.strictEqual(resExact.status, 200);
    const bodyExact = await resExact.json();
    assert.ok(bodyExact.results.files.some(f => f.filename === 'SuperWidgetImplementation.js'));
  });

  test('Multi-Entity Search Results & Deep Links Validation (files, shares, tags, ecosystem)', async () => {
    const multiTerm = 'EcosystemMatrixTest';

    // 1. File
    await db.indexFileInFts(userA, `/files/${multiTerm}_doc.pdf`, `${multiTerm}_doc.pdf`, `Content for ${multiTerm}`);
    
    // 2. Public Share
    await db.createPublicShare(userA, 'matrix-share-token-123', `/files/${multiTerm}_doc.pdf`, 0, null, null, null, `${multiTerm} Public Share`);

    // 3. File Tag
    await db.assignTag(userA, `/files/${multiTerm}_doc.pdf`, `${multiTerm}_Tag`, '#00FF00');

    // 4. Ecosystem Ingest Log
    await db.createEcosystemIngestLog({
      userId: userA,
      filePath: `/files/${multiTerm}_doc.pdf`,
      fileName: `${multiTerm}_doc.pdf`,
      target: 'paperless',
      status: 'success',
      remoteId: 'eco-id-777',
      details: `${multiTerm} ingest log`
    });

    const res = await fetch(`${serverUrl}/api/search/universal?q=${multiTerm}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.ok(body.results.files.length >= 1, 'Should return matching file');
    assert.ok(body.results.shares.length >= 1, 'Should return matching public share');
    assert.ok(body.results.tags.length >= 1, 'Should return matching tag');
    assert.ok(body.results.ecosystem.length >= 1, 'Should return matching ecosystem log');

    // Verify deep links aggregations
    assert.ok(body.deepLinks.some(d => d.type === 'file' && d.url.includes(encodeURIComponent(`/files/${multiTerm}_doc.pdf`))));
    assert.ok(body.deepLinks.some(d => d.url.includes('/s/matrix-share-token-123')));
    assert.ok(body.deepLinks.some(d => d.type === 'tag' && d.url.includes(encodeURIComponent(`${multiTerm}_Tag`))));
    assert.ok(body.deepLinks.some(d => d.type === 'paperless' && d.url.includes('eco-id-777')));
  });

  test('Multi-User Data Isolation: User A results MUST NOT leak into User B queries', async () => {
    const userATerm = 'UserA_Exclusive_Private_File';
    const userBTerm = 'UserB_Exclusive_Private_File';

    await db.indexFileInFts(userA, `/private/${userATerm}.txt`, `${userATerm}.txt`, 'Top secret data for User A');
    await db.indexFileInFts(userB, `/private/${userBTerm}.txt`, `${userBTerm}.txt`, 'Top secret data for User B');

    // User A query for User A term -> should find 1
    const resA1 = await fetch(`${serverUrl}/api/search/universal?q=${userATerm}`, { headers: { 'x-test-user': userA } });
    const bodyA1 = await resA1.json();
    assert.strictEqual(bodyA1.results.files.length, 1);

    // User A query for User B term -> should find 0
    const resA2 = await fetch(`${serverUrl}/api/search/universal?q=${userBTerm}`, { headers: { 'x-test-user': userA } });
    const bodyA2 = await resA2.json();
    assert.strictEqual(bodyA2.results.files.length, 0, 'User A query must not leak User B items');

    // User B query for User B term -> should find 1
    const resB1 = await fetch(`${serverUrl}/api/search/universal?q=${userBTerm}`, { headers: { 'x-test-user': userB } });
    const bodyB1 = await resB1.json();
    assert.strictEqual(resB1.status, 200);
    assert.strictEqual(bodyB1.results.files.length, 1);

    // User B query for User A term -> should find 0
    const resB2 = await fetch(`${serverUrl}/api/search/universal?q=${userATerm}`, { headers: { 'x-test-user': userB } });
    const bodyB2 = await resB2.json();
    assert.strictEqual(bodyB2.results.files.length, 0, 'User B query must not leak User A items');
  });
});
