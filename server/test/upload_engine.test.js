const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const filesRouter = require('../routes/files');
const db = require('../db');
const LocalProvider = require('../providers/local');

const TEST_ROOT = path.resolve(__dirname, 'test_upload_engine_user_home');

describe('Issue #77: Upload Engine — Folder Upload (webkitdirectory), URL Import & Multi-Source Dropdown', () => {
  let app;
  let server;
  let baseUrl;

  before(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    const userHome = path.join(TEST_ROOT, 'upload_user');
    const lp = new LocalProvider({ userRoot: userHome });
    await lp.ensureUserHome();
    await db.initDb();
    await db.upsertUser('upload_user', 'Upload User', 'upload@test.com');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = 'upload_user';
      req.userRoot = userHome;
      req.session = { user: { id: 'upload_user' } };
      next();
    });

    // Mock remote server route for URL import test
    app.get('/mock-download/sample.txt', (req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.send('Mock downloaded content for URL import');
    });

    app.use('/api/files/local', filesRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('POST /api/files/local/url-import rejects missing or invalid URL with 400', async () => {
    const res = await fetch(`${baseUrl}/api/files/local/url-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('POST /api/files/local/url-import successfully imports file from valid URL', async () => {
    const targetUrl = `${baseUrl}/mock-download/sample.txt`;
    const res = await fetch(`${baseUrl}/api/files/local/url-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, filename: 'url_imported.txt', path: '/' })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);

    const filePath = path.join(TEST_ROOT, 'upload_user', 'url_imported.txt');
    const content = await fs.readFile(filePath, 'utf8');
    assert.equal(content, 'Mock downloaded content for URL import');
  });

  test('POST /api/files/local/upload preserves relative directory paths for folder uploads', async () => {
    const boundary = '----WebKitFormBoundaryUploadEngineTest';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="path"',
      '',
      '/',
      `--${boundary}`,
      'Content-Disposition: form-data; name="relativePath"',
      '',
      'nested_dir/sub_folder/nested_file.txt',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="nested_file.txt"',
      'Content-Type: text/plain',
      '',
      'Folder upload preserved relative directory content',
      `--${boundary}--`
    ].join('\r\n');

    const res = await fetch(`${baseUrl}/api/files/local/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    assert.equal(res.status, 201);
    const filePath = path.join(TEST_ROOT, 'upload_user', 'nested_dir', 'sub_folder', 'nested_file.txt');
    const content = await fs.readFile(filePath, 'utf8');
    assert.equal(content, 'Folder upload preserved relative directory content');
  });
});
