const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const settingsRouter = require('../routes/settings');
const { bandwidthThrottler, TokenBucket } = require('../middleware/bandwidth');

describe('Cloud Storage Bandwidth Throttling & Speed Limit Manager (#86)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-bw-1';
  const userBId = 'user-bw-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_bandwidth_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_bandwidth.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'bwuser1', 'bw1@freeshard.local');
    await db.upsertUser(userBId, 'bwuser2', 'bw2@freeshard.local');

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
      next();
    });

    // Mount settings router & bandwidth middleware
    app.use('/api/settings', settingsRouter);
    app.use('/api/test-download', bandwidthThrottler, (req, res) => {
      const chunk = 'x'.repeat(1024 * 10); // 10 KB
      res.setHeader('Content-Type', 'text/plain');
      res.write(chunk);
      res.end();
    });

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

  test('TokenBucket: accurately regulates token consumption and rate', async () => {
    const bucket = new TokenBucket(100, 100); // 100 tokens per sec
    assert.equal(bucket.capacity, 100);
    const start = Date.now();
    await bucket.consume(150); // requires waiting for tokens
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 300, `Expected elapsed time >= 300ms, got ${elapsed}ms`);
  });

  test('DB Helpers: getBandwidthSettings and setBandwidthSettings', async () => {
    const initial = await db.getBandwidthSettings(userId);
    assert.equal(initial.upload_limit_kbps, 0);
    assert.equal(initial.download_limit_kbps, 0);

    const updated = await db.setBandwidthSettings(userId, { upload_limit_kbps: 1024, download_limit_kbps: 2048 });
    assert.equal(updated.upload_limit_kbps, 1024);
    assert.equal(updated.download_limit_kbps, 2048);

    const retrieved = await db.getBandwidthSettings(userId);
    assert.equal(retrieved.upload_limit_kbps, 1024);
    assert.equal(retrieved.download_limit_kbps, 2048);
  });

  test('API Endpoint: GET /api/settings/bandwidth returns current user limits', async () => {
    const res = await fetch(`${serverUrl}/api/settings/bandwidth`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.settings.upload_limit_kbps, 1024);
    assert.equal(data.settings.download_limit_kbps, 2048);
  });

  test('API Endpoint: POST /api/settings/bandwidth updates bandwidth limits', async () => {
    const res = await fetch(`${serverUrl}/api/settings/bandwidth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ upload_limit_kbps: 512, download_limit_kbps: 1024 })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.settings.upload_limit_kbps, 512);
    assert.equal(data.settings.download_limit_kbps, 1024);
  });

  test('API Endpoint: POST /api/settings/bandwidth validates negative values', async () => {
    const res = await fetch(`${serverUrl}/api/settings/bandwidth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ upload_limit_kbps: -10, download_limit_kbps: 100 })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: Unauthenticated requests return 401', async () => {
    const res = await fetch(`${serverUrl}/api/settings/bandwidth`, {
      headers: { 'x-test-user': 'none' }
    });
    assert.equal(res.status, 401);
  });

  test('User Isolation: User B settings are independent of User A settings', async () => {
    const resB = await fetch(`${serverUrl}/api/settings/bandwidth`, {
      headers: { 'x-test-user': userBId }
    });
    const dataB = await resB.json();
    assert.equal(dataB.settings.upload_limit_kbps, 0);
    assert.equal(dataB.settings.download_limit_kbps, 0);
  });

  test('Bandwidth Throttling Middleware: throttles response download speed when limit is set', async () => {
    // Set 20 KB/s limit for User B
    await db.setBandwidthSettings(userBId, { upload_limit_kbps: 0, download_limit_kbps: 20 });

    const start = Date.now();
    const res = await fetch(`${serverUrl}/api/test-download`, {
      headers: { 'x-test-user': userBId }
    });
    const text = await res.text();
    const duration = Date.now() - start;

    assert.equal(res.status, 200);
    assert.equal(text.length, 1024 * 10);
    // 10KB at 20KB/s takes ~500ms
    assert.ok(duration >= 200, `Expected throttled download duration >= 200ms, got ${duration}ms`);
  });
});
