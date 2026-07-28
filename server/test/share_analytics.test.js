const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const sharingRouter = require('../routes/sharing');
const publicShareRouter = require('../routes/public_share');

describe('Public Share Analytics & Access Dashboard (#81)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-analytics-1';
  const userBId = 'user-analytics-2';
  let createdShareToken;
  let createdShareId;

  before(async () => {
    dataDir = path.join(__dirname, 'data_analytics_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_analytics.db');
    await fs.mkdir(dataDir, { recursive: true });

    // Provision test file
    const userRoot = path.join(dataDir, 'users', userId);
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(path.join(userRoot, 'report.pdf'), 'PDF content analytics test');

    await db.initDb();
    await db.upsertUser(userId, 'analyticsuser1', 'analytics1@freeshard.local');
    await db.upsertUser(userBId, 'analyticsuser2', 'analytics2@freeshard.local');

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
      next();
    });

    app.use('/api/shares', sharingRouter);
    app.use('/s', publicShareRouter);

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

  test('Create public share link for testing', async () => {
    const res = await fetch(`${serverUrl}/api/shares/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        file_path: '/report.pdf',
        label: 'Q3 Report'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.share.token);
    createdShareToken = data.share.token;
    createdShareId = data.share.id;
  });

  test('Public Share View logs access event in share_analytics', async () => {
    const res = await fetch(`${serverUrl}/s/${createdShareToken}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TestBrowser/1.0',
        'Referer': 'https://google.com'
      }
    });
    assert.equal(res.status, 200);

    const analyticsData = await db.getShareAnalytics(createdShareId, userId);
    assert.ok(analyticsData);
    assert.equal(analyticsData.analytics.total_views, 1);
    assert.equal(analyticsData.analytics.total_downloads, 0);
    assert.equal(analyticsData.events.length, 1);
    assert.equal(analyticsData.events[0].event_type, 'view');
    assert.equal(analyticsData.events[0].user_agent, 'TestBrowser/1.0');
    assert.equal(analyticsData.events[0].referrer, 'https://google.com');
  });

  test('Public Share Download logs download access event', async () => {
    const res = await fetch(`${serverUrl}/s/${createdShareToken}/download`, {
      headers: {
        'User-Agent': 'Curl/7.68.0',
        'Referer': 'https://freeshard.org'
      }
    });
    assert.equal(res.status, 200);

    const analyticsData = await db.getShareAnalytics(createdShareId, userId);
    assert.ok(analyticsData);
    assert.equal(analyticsData.analytics.total_views, 1);
    assert.equal(analyticsData.analytics.total_downloads, 1);
    assert.equal(analyticsData.analytics.unique_visitors, 1);
    assert.equal(analyticsData.events.length, 2);
    assert.equal(analyticsData.events[0].event_type, 'download');
  });

  test('API Endpoint: GET /api/shares/:id/analytics returns metrics and event log', async () => {
    const res = await fetch(`${serverUrl}/api/shares/${createdShareId}/analytics`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.share_id, createdShareId);
    assert.equal(data.token, createdShareToken);
    assert.equal(data.analytics.total_views, 1);
    assert.equal(data.analytics.total_downloads, 1);
    assert.ok(Array.isArray(data.analytics.user_agents));
    assert.ok(Array.isArray(data.analytics.referrers));
    assert.ok(Array.isArray(data.events));
  });

  test('API Endpoint: GET /api/shares/:id/analytics returns 404 for unauthorized user or invalid share ID', async () => {
    const resForbidden = await fetch(`${serverUrl}/api/shares/${createdShareId}/analytics`, {
      headers: { 'x-test-user': userBId }
    });
    assert.equal(resForbidden.status, 404);

    const resNotFound = await fetch(`${serverUrl}/api/shares/99999/analytics`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resNotFound.status, 404);
  });
});
