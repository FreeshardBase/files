const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const filesRouter = require('../routes/files');
const { saveFileVersion, rollbackFileVersion } = require('../utils/file_versioning');

describe('File Versioning, Revision History & Rollback System (#78)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userRoot;
  let userBRoot;
  const userId = 'user-ver-1';
  const userBId = 'user-ver-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_versioning_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_versioning.db');
    await fs.mkdir(dataDir, { recursive: true });

    userRoot = path.join(dataDir, userId);
    userBRoot = path.join(dataDir, userBId);
    await fs.mkdir(userRoot, { recursive: true });
    await fs.mkdir(userBRoot, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'veruser1', 'ver1@freeshard.local');
    await db.upsertUser(userBId, 'veruser2', 'ver2@freeshard.local');

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const authHeader = req.headers['x-test-user'];
      const activeUser = authHeader || userId;
      req.userId = activeUser;
      req.userRoot = activeUser === userBId ? userBRoot : userRoot;
      req.session = { userId: activeUser, user: { id: activeUser } };
      next();
    });

    app.use('/api/files', filesRouter);

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
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('DB & Utility Helpers: saveFileVersion and getFileVersions', async () => {
    const docPath = '/doc.txt';
    const fullDocPath = path.join(userRoot, 'doc.txt');
    await fs.writeFile(fullDocPath, 'Version 1 content', 'utf8');

    const v1 = await saveFileVersion(userRoot, userId, docPath, { author: userId, comment: 'Initial version' });
    assert.ok(v1);
    assert.equal(v1.user_id, userId);
    assert.equal(v1.file_path, docPath);
    assert.equal(v1.version_number, 1);
    assert.equal(v1.comment, 'Initial version');

    // Modify file and create version 2
    await fs.writeFile(fullDocPath, 'Version 2 content updated', 'utf8');
    const v2 = await saveFileVersion(userRoot, userId, docPath, { author: userId, comment: 'Updated header' });
    assert.equal(v2.version_number, 2);

    const versions = await db.getFileVersions(userId, docPath);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version_number, 2);
    assert.equal(versions[1].version_number, 1);
  });

  test('API Endpoint: POST /api/files/versions/create creates version snapshot', async () => {
    const filePath = '/notes.md';
    await fs.writeFile(path.join(userRoot, 'notes.md'), '# Title v1', 'utf8');

    const res = await fetch(`${serverUrl}/api/files/versions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ filePath, comment: 'First draft' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.version);
    assert.equal(data.version.file_path, filePath);
    assert.equal(data.version.version_number, 1);
  });

  test('API Endpoint: GET /api/files/versions lists versions for user', async () => {
    const res = await fetch(`${serverUrl}/api/files/versions?path=/notes.md`, {
      headers: { 'x-test-user': userId }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.versions));
    assert.equal(data.versions.length, 1);
    assert.equal(data.versions[0].file_path, '/notes.md');
  });

  test('API Endpoint: POST /api/files/versions/rollback rolls back file to target version', async () => {
    const filePath = '/code.js';
    const diskPath = path.join(userRoot, 'code.js');

    // Create v1
    await fs.writeFile(diskPath, 'console.log("v1")', 'utf8');
    const v1 = await saveFileVersion(userRoot, userId, filePath, { comment: 'v1 snapshot' });

    // Modify file to v2
    await fs.writeFile(diskPath, 'console.log("v2 - broken")', 'utf8');

    // Rollback to v1
    const res = await fetch(`${serverUrl}/api/files/versions/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ filePath, versionId: v1.id })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.version.version_number, 1);

    // Verify content on disk reverted to v1
    const restoredContent = await fs.readFile(diskPath, 'utf8');
    assert.equal(restoredContent, 'console.log("v1")');
  });

  test('User Isolation & Error Handling', async () => {
    // User B attempting to rollback User A file version should fail
    const versionsA = await db.getFileVersions(userId, '/code.js');
    const targetVerId = versionsA[0].id;

    const resB = await fetch(`${serverUrl}/api/files/versions/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userBId },
      body: JSON.stringify({ filePath: '/code.js', versionId: targetVerId })
    });

    assert.equal(resB.status, 404);

    // Rollback non-existent version ID should return 404
    const res404 = await fetch(`${serverUrl}/api/files/versions/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ filePath: '/code.js', versionId: 999999 })
    });
    assert.equal(res404.status, 404);
  });
});
