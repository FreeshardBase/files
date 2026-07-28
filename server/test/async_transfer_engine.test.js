const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');

const db = require('../db');
const transfersRouter = require('../routes/transfers');
const LocalProvider = require('../providers/local');

describe('Server-Side Asynchronous Background Transfer Engine (#64)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-async-transfer';

  before(async () => {
    // Setup isolated test data directory
    dataDir = path.join(__dirname, 'data_async_transfer_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_transfers.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'transferuser', 'transfer@freeshard.local');

    // Create user home directory structure
    const userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });

    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test_secret',
      resave: false,
      saveUninitialized: true
    }));

    // Mock authentication middleware helper
    app.use((req, res, next) => {
      req.session.userId = userId;
      next();
    });

    app.use('/api/transfers', transfersRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
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

  test('DB Helpers: create, retrieve, update progress, and cancel transfer job', async () => {
    const transferId = `tr-test-${Date.now()}`;
    const newTransfer = await db.createTransfer({
      id: transferId,
      userId,
      srcProviderType: 'local',
      srcProviderConnectionId: null,
      srcPath: '/Documents/large_file.iso',
      dstProviderType: 'local',
      dstProviderConnectionId: null,
      dstPath: '/Pictures/large_file.iso',
      operation: 'copy',
      isDirectory: 0,
      totalBytes: 1048576,
      totalFiles: 1
    });

    assert.equal(newTransfer.id, transferId);
    assert.equal(newTransfer.user_id, userId);
    assert.equal(newTransfer.status, 'queued');
    assert.equal(newTransfer.total_bytes, 1048576);

    // Retrieve transfer
    const fetched = await db.getTransferById(transferId, userId);
    assert.equal(fetched.src_path, '/Documents/large_file.iso');

    // Update progress
    await db.updateTransferProgress(transferId, {
      status: 'in_progress',
      transferredBytes: 524288,
      completedFiles: 0,
      currentFile: 'large_file.iso',
      startedAt: new Date().toISOString()
    });

    const updated = await db.getTransferById(transferId, userId);
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.transferred_bytes, 524288);

    // Cancel transfer
    const cancelRes = await db.cancelTransfer(transferId, userId);
    assert.equal(cancelRes, true);

    const cancelled = await db.getTransferById(transferId, userId);
    assert.equal(cancelled.status, 'cancelled');
    assert.notEqual(cancelled.finished_at, null);
  });

  test('POST /api/transfers - Enqueue async transfer job', async () => {
    const userHome = path.join(dataDir, 'users', userId);
    await fs.writeFile(path.join(userHome, 'source_async.txt'), 'Async background transfer test payload');

    const res = await fetch(`${serverUrl}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcProviderType: 'local',
        srcPath: '/source_async.txt',
        dstProviderType: 'local',
        dstPath: '/dest_async.txt',
        operation: 'copy'
      })
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.transfer);
    assert.ok(body.transfer.id);
    assert.equal(body.transfer.src_path, '/source_async.txt');
    assert.equal(body.transfer.dst_path, '/dest_async.txt');

    // Wait briefly for background engine to execute transfer
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify target file was created
    const destExists = await fs.stat(path.join(userHome, 'dest_async.txt')).catch(() => null);
    assert.ok(destExists);

    // Verify transfer status updated to completed
    const finalState = await db.getTransferById(body.transfer.id, userId);
    assert.equal(finalState.status, 'completed');
  });

  test('GET /api/transfers and GET /api/transfers/:id', async () => {
    const listRes = await fetch(`${serverUrl}/api/transfers`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(Array.isArray(listBody.transfers));
    assert.ok(listBody.transfers.length > 0);

    const firstId = listBody.transfers[0].id;
    const detailRes = await fetch(`${serverUrl}/api/transfers/${firstId}`);
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.transfer.id, firstId);
  });

  test('POST /api/transfers/:id/cancel - Cancel active transfer job', async () => {
    // Create a queued transfer directly in DB
    const trId = `tr-cancel-${Date.now()}`;
    await db.createTransfer({
      id: trId,
      userId,
      srcProviderType: 'local',
      srcProviderConnectionId: null,
      srcPath: '/dummy.txt',
      dstProviderType: 'local',
      dstProviderConnectionId: null,
      dstPath: '/dummy_copy.txt',
      operation: 'copy',
      isDirectory: 0,
      totalBytes: 10000,
      totalFiles: 1
    });

    const cancelRes = await fetch(`${serverUrl}/api/transfers/${trId}/cancel`, {
      method: 'POST'
    });

    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.success, true);
    assert.equal(cancelBody.transfer.status, 'cancelled');
  });

  test('GET /api/transfers/events - SSE endpoint connects and streams header', async () => {
    const res = await fetch(`${serverUrl}/api/transfers/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache');

    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    assert.equal(done, false);
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes('connected') || text.includes(': keepalive') || text.includes('event:'));
    reader.cancel();
  });
});
