const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const archiveRouter = require('../routes/archive');

describe('Automated Archive Extraction & Compression Manager (#88)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userRoot;
  const userId = 'user-archive-1';

  before(async () => {
    dataDir = path.join(__dirname, 'data_archive_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_archive.db');
    userRoot = path.join(process.env.FILES_ROOT, userId);
    await fs.mkdir(userRoot, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'archiveuser', 'archive@freeshard.local');

    // Create sample test files in userRoot
    await fs.writeFile(path.join(userRoot, 'doc1.txt'), 'Hello world doc 1', 'utf8');
    await fs.mkdir(path.join(userRoot, 'subfolder'), { recursive: true });
    await fs.writeFile(path.join(userRoot, 'subfolder', 'doc2.txt'), 'Hello world doc 2 inside subfolder', 'utf8');

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const authHeader = req.headers['x-test-user'];
      if (authHeader === 'none') {
        req.session = {};
        return next();
      }
      const activeUser = authHeader || userId;
      req.session = { userId: activeUser, user: { id: activeUser } };
      req.userId = activeUser;
      req.userRoot = path.join(dataDir, 'users', activeUser);
      next();
    });

    app.use('/api/archive', archiveRouter);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('POST /api/archive/compress creates a ZIP archive', async () => {
    const res = await fetch(`${serverUrl}/api/archive/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: ['doc1.txt', 'subfolder/doc2.txt'],
        outputPath: 'archive_test.zip',
        format: 'zip'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.archivePath);

    const exists = await fs.stat(path.join(userRoot, 'archive_test.zip')).then(() => true).catch(() => false);
    assert.equal(exists, true);
  });

  test('POST /api/archive/compress creates a TAR.GZ archive', async () => {
    const res = await fetch(`${serverUrl}/api/archive/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: ['doc1.txt'],
        outputPath: 'archive_test.tar.gz',
        format: 'tar.gz'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const exists = await fs.stat(path.join(userRoot, 'archive_test.tar.gz')).then(() => true).catch(() => false);
    assert.equal(exists, true);
  });

  test('POST /api/archive/compress creates a password-protected ZIP archive', async () => {
    const res = await fetch(`${serverUrl}/api/archive/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: ['doc1.txt'],
        outputPath: 'protected.zip',
        password: 'SecretPassword123'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const exists = await fs.stat(path.join(userRoot, 'protected.zip')).then(() => true).catch(() => false);
    assert.equal(exists, true);
  });

  test('POST /api/archive/compress returns 400 if missing files or output path', async () => {
    const res = await fetch(`${serverUrl}/api/archive/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [],
        outputPath: 'empty.zip'
      })
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/archive/extract extracts ZIP archive contents', async () => {
    const res = await fetch(`${serverUrl}/api/archive/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivePath: 'archive_test.zip',
        targetDir: 'extracted_zip'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const file1Content = await fs.readFile(path.join(userRoot, 'extracted_zip', 'doc1.txt'), 'utf8');
    assert.equal(file1Content, 'Hello world doc 1');
    const file2Content = await fs.readFile(path.join(userRoot, 'extracted_zip', 'subfolder', 'doc2.txt'), 'utf8');
    assert.equal(file2Content, 'Hello world doc 2 inside subfolder');
  });

  test('POST /api/archive/extract extracts TAR.GZ archive contents', async () => {
    const res = await fetch(`${serverUrl}/api/archive/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivePath: 'archive_test.tar.gz',
        targetDir: 'extracted_targz'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const content = await fs.readFile(path.join(userRoot, 'extracted_targz', 'doc1.txt'), 'utf8');
    assert.equal(content, 'Hello world doc 1');
  });

  test('POST /api/archive/extract fails without password on protected archive', async () => {
    const res = await fetch(`${serverUrl}/api/archive/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivePath: 'protected.zip',
        targetDir: 'extracted_nopass'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.toLowerCase().includes('password'));
  });

  test('POST /api/archive/extract extracts password-protected archive with correct password', async () => {
    const res = await fetch(`${serverUrl}/api/archive/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivePath: 'protected.zip',
        targetDir: 'extracted_withpass',
        password: 'SecretPassword123'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const content = await fs.readFile(path.join(userRoot, 'extracted_withpass', 'doc1.txt'), 'utf8');
    assert.equal(content, 'Hello world doc 1');
  });

  test('POST /api/archive/extract blocks path traversal target directory', async () => {
    const res = await fetch(`${serverUrl}/api/archive/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archivePath: 'archive_test.zip',
        targetDir: '../../outside'
      })
    });
    assert.equal(res.status, 403);
  });

  test('Unauthenticated request returns 401', async () => {
    const res = await fetch(`${serverUrl}/api/archive/compress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'none'
      },
      body: JSON.stringify({
        files: ['doc1.txt'],
        outputPath: 'fail.zip'
      })
    });
    assert.equal(res.status, 401);
  });
});
