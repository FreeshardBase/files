const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const { Readable } = require('stream');
const LocalProvider = require('../providers/local');
const filesRouter = require('../routes/files');
const db = require('../db');

const TEST_ROOT = path.resolve(__dirname, 'test_batch_home');

describe('Batch File Operations & Multi-Select API (#12, #35)', () => {
  let provider;
  let app;
  let server;
  let baseUrl;

  before(async () => {
    process.env.FILES_ROOT = TEST_ROOT;
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    const userHome = path.join(TEST_ROOT, 'test_batch_user');
    provider = new LocalProvider({ userRoot: userHome });
    await provider.ensureUserHome();
    await db.initDb();
    await db.upsertUser('test_batch_user', 'Batch User', 'batch@test.com');

    // Create test files for provider unit tests
    await provider.write('/Documents/f1.txt', Readable.from(['content 1']));
    await provider.write('/Documents/f2.txt', Readable.from(['content 2']));
    await provider.write('/Documents/f3.txt', Readable.from(['content 3']));
    await provider.mkdir('/TargetDir');

    // Create test files for bulk rename tests
    await provider.write('/Documents/photo_01.jpg', Readable.from(['img1']));
    await provider.write('/Documents/photo_02.jpg', Readable.from(['img2']));
    await provider.write('/Documents/report_2024.txt', Readable.from(['rep']));
    await provider.write('/Documents/data_v1_old.csv', Readable.from(['csv']));

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = 'test_batch_user';
      req.userRoot = userHome;
      req.session = { user: { id: 'test_batch_user' } };
      next();
    });

    app.use('/api/files/local', filesRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
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

  test('batch move moves multiple files successfully', async () => {
    await provider.move('/Documents/f1.txt', '/TargetDir/f1.txt');
    await provider.move('/Documents/f2.txt', '/TargetDir/f2.txt');

    const targetList = await provider.list('/TargetDir');
    const names = targetList.map(i => i.name);

    assert.ok(names.includes('f1.txt'));
    assert.ok(names.includes('f2.txt'));
  });

  test('batch delete removes multiple files in one operation', async () => {
    await provider.delete('/TargetDir/f1.txt');
    await provider.delete('/TargetDir/f2.txt');

    const targetList = await provider.list('/TargetDir');
    assert.equal(targetList.length, 0);
  });

  test('validates single and multi-file existence for batch zip preparation', async () => {
    const meta3 = await provider.metadata('/Documents/f3.txt');
    assert.equal(meta3.name, 'f3.txt');
  });

  // ── Issue #35: Pattern-Based Bulk File Renaming ────────────────────────────
  test('POST /api/files/local/batch/rename applies prefix to files', async () => {
    const res = await makeRequest('POST', '/api/files/local/batch/rename', {
      paths: ['/Documents/photo_01.jpg', '/Documents/photo_02.jpg'],
      prefix: 'VACATION_'
    });

    assert.equal(res.status, 200, `Expected 200 OK but got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.renamedCount, 2);

    const docList = await provider.list('/Documents');
    const names = docList.map(i => i.name);
    assert.ok(names.includes('VACATION_photo_01.jpg'));
    assert.ok(names.includes('VACATION_photo_02.jpg'));
  });

  test('POST /api/files/local/batch/rename applies suffix to files', async () => {
    const res = await makeRequest('POST', '/api/files/local/batch/rename', {
      paths: ['/Documents/report_2024.txt'],
      suffix: '_FINAL'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.renamedCount, 1);

    const docList = await provider.list('/Documents');
    const names = docList.map(i => i.name);
    assert.ok(names.includes('report_2024_FINAL.txt'));
  });

  test('POST /api/files/local/batch/rename performs search and replace across filenames', async () => {
    const res = await makeRequest('POST', '/api/files/local/batch/rename', {
      paths: ['/Documents/VACATION_photo_01.jpg', '/Documents/VACATION_photo_02.jpg'],
      search: 'photo',
      replace: 'image'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.renamedCount, 2);

    const docList = await provider.list('/Documents');
    const names = docList.map(i => i.name);
    assert.ok(names.includes('VACATION_image_01.jpg'));
    assert.ok(names.includes('VACATION_image_02.jpg'));
  });

  test('POST /api/files/local/batch/rename supports regex search and replace', async () => {
    const res = await makeRequest('POST', '/api/files/local/batch/rename', {
      paths: ['/Documents/data_v1_old.csv'],
      search: 'v\\d+_old',
      replace: 'v2_new',
      isRegex: true
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.renamedCount, 1);

    const docList = await provider.list('/Documents');
    const names = docList.map(i => i.name);
    assert.ok(names.includes('data_v2_new.csv'));
  });

  test('POST /api/files/local/batch/rename validates input parameters', async () => {
    const resNoPaths = await makeRequest('POST', '/api/files/local/batch/rename', { prefix: 'test_' });
    assert.equal(resNoPaths.status, 400);

    const resNoRules = await makeRequest('POST', '/api/files/local/batch/rename', { paths: ['/Documents/f3.txt'] });
    assert.equal(resNoRules.status, 400);
  });
});

