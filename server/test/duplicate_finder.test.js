const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const filesRouter = require('../routes/files');
const { scanDuplicates, deduplicateFile } = require('../utils/duplicate_finder');

describe('Intelligent Duplicate File Finder & Storage Cleanup Wizard (#76)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-dup';
  let userBId = 'test-user-dup-b';
  let userHome;
  let userBHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_dup_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_dup.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'dupuser', 'dupuser@freeshard.local');
    await db.upsertUser(userBId, 'dupuserb', 'dupuserb@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    userBHome = path.join(dataDir, 'users', userBId);
    await fs.mkdir(path.join(userHome, 'FolderA'), { recursive: true });
    await fs.mkdir(path.join(userHome, 'FolderB'), { recursive: true });
    await fs.mkdir(path.join(userBHome, 'FolderA'), { recursive: true });

    // Populate test files
    const contentOriginal = 'Hello Freeshard duplicate content 12345!';
    const contentUnique = 'Unique content file';
    await fs.writeFile(path.join(userHome, 'file1.txt'), contentOriginal);
    await fs.writeFile(path.join(userHome, 'FolderA', 'file1_copy.txt'), contentOriginal);
    await fs.writeFile(path.join(userHome, 'FolderB', 'file1_copy2.txt'), contentOriginal);
    await fs.writeFile(path.join(userHome, 'unique.txt'), contentUnique);

    await fs.writeFile(path.join(userBHome, 'file1.txt'), contentOriginal);

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

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

  test('Utility: scanDuplicates finds duplicate SHA-256 hashes', async () => {
    const dups = await scanDuplicates(userHome);
    assert.strictEqual(dups.length, 1, 'Should find 1 group of duplicates');
    assert.strictEqual(dups[0].files.length, 3, 'Group should have 3 files');
    assert.ok(dups[0].hash, 'Group should have a SHA-256 hash');
  });

  test('API Endpoint: GET /api/files/duplicates computes file hashes and returns duplicate groups', async () => {
    const res = await fetch(`${serverUrl}/api/files/duplicates`, {
      headers: { 'x-test-user': userId }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.duplicates));
    assert.strictEqual(body.duplicates.length, 1);
    assert.strictEqual(body.duplicates[0].files.length, 3);
  });

  test('API Endpoint: POST /api/files/deduplicate deletes a duplicate copy', async () => {
    const res = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': userId
      },
      body: JSON.stringify({
        action: 'delete',
        keepPath: '/file1.txt',
        targetPath: '/FolderB/file1_copy2.txt'
      })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.action, 'delete');
    assert.ok(body.freed_bytes > 0);

    // Verify file deleted on disk
    await assert.rejects(async () => {
      await fs.stat(path.join(userHome, 'FolderB', 'file1_copy2.txt'));
    });
  });

  test('API Endpoint: POST /api/files/deduplicate hardlinks a duplicate copy', async () => {
    const res = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': userId
      },
      body: JSON.stringify({
        action: 'hardlink',
        keepPath: '/file1.txt',
        targetPath: '/FolderA/file1_copy.txt'
      })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.action, 'hardlink');

    // Verify hardlink by checking inode numbers match
    const statKeep = await fs.stat(path.join(userHome, 'file1.txt'));
    const statTarget = await fs.stat(path.join(userHome, 'FolderA', 'file1_copy.txt'));
    assert.strictEqual(statKeep.ino, statTarget.ino, 'Inodes should match for hardlink');
  });

  test('API Endpoint: POST /api/files/deduplicate input validation and path traversal protection', async () => {
    // Missing required fields
    const res1 = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ action: 'delete' })
    });
    assert.strictEqual(res1.status, 400);

    // Invalid action
    const res2 = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ action: 'invalid', keepPath: '/file1.txt', targetPath: '/unique.txt' })
    });
    assert.strictEqual(res2.status, 400);

    // Path traversal targetPath
    const res3 = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ action: 'delete', keepPath: '/file1.txt', targetPath: '../../test_dup.db' })
    });
    assert.strictEqual(res3.status, 403);
  });

  test('API Endpoint: User isolation prevents operating on another user files', async () => {
    // User B attempting to target User A's file relative path in User B's root (doesn't exist in B)
    const res = await fetch(`${serverUrl}/api/files/deduplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userBId },
      body: JSON.stringify({ action: 'delete', keepPath: '/file1.txt', targetPath: '/FolderA/file1_copy.txt' })
    });
    assert.strictEqual(res.status, 404);
  });
});
