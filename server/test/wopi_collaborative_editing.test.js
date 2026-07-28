const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const wopiRouter = require('../routes/wopi');

describe('Advanced Office Document Live Collaborative Editing (#85)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-wopi-1';
  const testFileName = 'sample_document.docx';
  const initialContent = 'Original document content for WOPI collaborative editing test.';
  let testFileId;

  before(async () => {
    dataDir = path.join(__dirname, 'data_wopi_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_wopi.db');
    await fs.mkdir(dataDir, { recursive: true });

    // Provision test files for user
    const userRoot = path.join(dataDir, 'users', userId);
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(path.join(userRoot, testFileName), initialContent);

    await db.initDb();
    await db.upsertUser(userId, 'wopiuser', 'wopi@freeshard.local');

    testFileId = Buffer.from(`${userId}:${testFileName}`).toString('base64url');

    app = express();
    app.use(express.json());
    app.use('/wopi', wopiRouter);
    app.use('/api/wopi', wopiRouter);

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

  test('API Endpoint: POST /api/wopi/tokens creates WOPI access token', async () => {
    const res = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        filePath: testFileName,
        canWrite: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.accessToken, 'Should return accessToken');
    assert.ok(data.fileId, 'Should return fileId');
    assert.ok(data.wopiSrc, 'Should return wopiSrc endpoint URL');
  });

  test('WOPI CheckFileInfo: GET /wopi/files/:id returns metadata with valid token', async () => {
    // Generate token first
    const tokenRes = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filePath: testFileName, canWrite: true })
    });
    const { accessToken, fileId } = await tokenRes.json();

    const res = await fetch(`${serverUrl}/wopi/files/${fileId}?access_token=${accessToken}`);
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.BaseFileName, testFileName);
    assert.equal(info.OwnerId, userId);
    assert.equal(info.UserId, userId);
    assert.equal(info.UserCanWrite, true);
    assert.equal(info.SupportsUpdate, true);
    assert.equal(info.SupportsLocks, true);
    assert.equal(info.Size, Buffer.byteLength(initialContent));
  });

  test('WOPI CheckFileInfo: GET /wopi/files/:id rejects invalid or missing token with 401', async () => {
    const resNoToken = await fetch(`${serverUrl}/wopi/files/${testFileId}`);
    assert.equal(resNoToken.status, 401);

    const resBadToken = await fetch(`${serverUrl}/wopi/files/${testFileId}?access_token=invalid_token_12345`);
    assert.equal(resBadToken.status, 401);
  });

  test('WOPI GetFile: GET /wopi/files/:id/contents retrieves raw document binary', async () => {
    const tokenRes = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filePath: testFileName, canWrite: false })
    });
    const { accessToken, fileId } = await tokenRes.json();

    const res = await fetch(`${serverUrl}/wopi/files/${fileId}/contents?access_token=${accessToken}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, initialContent);
  });

  test('WOPI PutFile: POST /wopi/files/:id/contents updates document content with write token', async () => {
    const tokenRes = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filePath: testFileName, canWrite: true })
    });
    const { accessToken, fileId } = await tokenRes.json();

    const updatedContent = 'Updated document content via WOPI PutFile endpoint!';
    const putRes = await fetch(`${serverUrl}/wopi/files/${fileId}/contents?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: updatedContent
    });

    assert.equal(putRes.status, 200);

    // Verify content updated
    const getRes = await fetch(`${serverUrl}/wopi/files/${fileId}/contents?access_token=${accessToken}`);
    const text = await getRes.text();
    assert.equal(text, updatedContent);
  });

  test('WOPI PutFile: POST /wopi/files/:id/contents rejects edit with read-only token (403)', async () => {
    const tokenRes = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filePath: testFileName, canWrite: false })
    });
    const { accessToken, fileId } = await tokenRes.json();

    const putRes = await fetch(`${serverUrl}/wopi/files/${fileId}/contents?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'Attempted forbidden edit'
    });

    assert.equal(putRes.status, 403);
  });

  test('WOPI Lock operations: LOCK, GET_LOCK, UNLOCK via POST /wopi/files/:id', async () => {
    const tokenRes = await fetch(`${serverUrl}/api/wopi/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filePath: testFileName, canWrite: true })
    });
    const { accessToken, fileId } = await tokenRes.json();

    const lockId = 'lock_session_abc123';

    // 1. Acquire Lock
    const lockRes = await fetch(`${serverUrl}/wopi/files/${fileId}?access_token=${accessToken}`, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'LOCK',
        'X-WOPI-Lock': lockId
      }
    });
    assert.equal(lockRes.status, 200);

    // 2. Get Lock
    const getLockRes = await fetch(`${serverUrl}/wopi/files/${fileId}?access_token=${accessToken}`, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'GET_LOCK'
      }
    });
    assert.equal(getLockRes.status, 200);
    assert.equal(getLockRes.headers.get('X-WOPI-Lock'), lockId);

    // 3. Unlock
    const unlockRes = await fetch(`${serverUrl}/wopi/files/${fileId}?access_token=${accessToken}`, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'UNLOCK',
        'X-WOPI-Lock': lockId
      }
    });
    assert.equal(unlockRes.status, 200);
  });
});
