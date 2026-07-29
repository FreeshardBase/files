const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');

const db = require('../db');
const webhooksRouter = require('../routes/webhooks');
const sharingRouter = require('../routes/sharing');
const filesRouter = require('../routes/files');
const { dispatchWebhookEvent } = require('../utils/webhook_dispatcher');

describe('Webhook Event Dispatcher for Real-Time File Change Notifications (#72)', () => {
  let app;
  let server;
  let serverUrl;
  let mockWebhookServer;
  let mockWebhookUrl;
  let receivedEvents = [];
  let dataDir;
  let userId = 'test-user-webhook';

  before(async () => {
    dataDir = path.join(__dirname, 'data_webhook_dispatcher_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_webhooks.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'webhookuser', 'webhook@freeshard.local');

    const userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });

    // 1. Setup Mock Webhook Receiver HTTP Server
    mockWebhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const json = JSON.parse(body);
          receivedEvents.push({
            headers: req.headers,
            payload: json
          });
        } catch (e) {
          receivedEvents.push({ headers: req.headers, raw: body });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });

    await new Promise((resolve) => mockWebhookServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockWebhookServer.address().port;
    mockWebhookUrl = `http://127.0.0.1:${mockPort}/webhook-target`;

    // 2. Setup Express App under test
    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test_webhook_secret',
      resave: false,
      saveUninitialized: true
    }));

    app.use((req, res, next) => {
      if (req.session) {
        req.session.userId = userId;
      }
      req.userId = userId;
      req.userRoot = userHome;
      next();
    });

    app.use('/api/webhooks', webhooksRouter);
    app.use('/api/shares', sharingRouter);
    app.use('/api/files/local', filesRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const appPort = server.address().port;
    serverUrl = `http://127.0.0.1:${appPort}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockWebhookServer) await new Promise((resolve) => mockWebhookServer.close(resolve));
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    receivedEvents = [];
  });

  test('DB Helpers: create, update, list, delete webhook settings in SQLite', async () => {
    const webhook = await db.createWebhook({
      userId,
      url: mockWebhookUrl,
      secret: 'supersecretkey',
      events: ['file_created', 'file_deleted', 'share_revoked']
    });

    assert.ok(webhook);
    assert.equal(webhook.url, mockWebhookUrl);
    assert.equal(webhook.secret, 'supersecretkey');

    const list = await db.getWebhooksByUser(userId);
    assert.ok(list.length >= 1);

    const updated = await db.updateWebhook(webhook.id, userId, {
      secret: 'newsecret',
      enabled: 0
    });
    assert.equal(updated.secret, 'newsecret');
    assert.equal(updated.enabled, 0);

    const deleted = await db.deleteWebhook(webhook.id, userId);
    assert.equal(deleted, true);
  });

  test('Webhook Dispatcher: dispatches JSON payload with secret header to receiver', async () => {
    const webhook = await db.createWebhook({
      userId,
      url: mockWebhookUrl,
      secret: 'sig_secret_123',
      events: ['file_created', 'file_deleted', 'share_revoked']
    });

    const results = await dispatchWebhookEvent(userId, 'file_created', { path: '/Documents/test.txt' });
    assert.ok(results.length >= 1);
    assert.equal(results[0].success, true);

    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].headers['x-webhook-secret'], 'sig_secret_123');
    assert.equal(receivedEvents[0].payload.event, 'file_created');
    assert.equal(receivedEvents[0].payload.user_id, userId);
    assert.equal(receivedEvents[0].payload.data.path, '/Documents/test.txt');

    await db.deleteWebhook(webhook.id, userId);
  });

  test('Webhook Dispatcher: filters unsubscribed events', async () => {
    const webhook = await db.createWebhook({
      userId,
      url: mockWebhookUrl,
      secret: null,
      events: ['share_revoked']
    });

    const results = await dispatchWebhookEvent(userId, 'file_created', { path: '/Documents/test.txt' });
    assert.equal(results[0].skipped, true);
    assert.equal(receivedEvents.length, 0);

    await db.deleteWebhook(webhook.id, userId);
  });

  test('API Endpoint: CRUD /api/webhooks and POST /api/webhooks/test', async () => {
    // 1. Create webhook via API
    const createRes = await fetch(`${serverUrl}/api/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: mockWebhookUrl,
        secret: 'api_secret',
        events: ['file_created', 'file_deleted', 'share_revoked']
      })
    });
    const createData = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.equal(createData.success, true);
    assert.ok(createData.webhook.id);

    const webhookId = createData.webhook.id;

    // 2. List webhooks
    const listRes = await fetch(`${serverUrl}/api/webhooks`);
    const listData = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.ok(listData.webhooks.some(w => w.id === webhookId));

    // 3. Test trigger endpoint
    const testRes = await fetch(`${serverUrl}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'file_created', data: { ping: true } })
    });
    const testData = await testRes.json();
    assert.equal(testRes.status, 200);
    assert.equal(testData.success, true);
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].payload.data.ping, true);

    // 4. Delete webhook
    const delRes = await fetch(`${serverUrl}/api/webhooks/${webhookId}`, {
      method: 'DELETE'
    });
    const delData = await delRes.json();
    assert.equal(delRes.status, 200);
    assert.equal(delData.success, true);
  });

  test('Event Triggers: file_created on mkdir and share_revoked on share deletion', async () => {
    const webhook = await db.createWebhook({
      userId,
      url: mockWebhookUrl,
      secret: null,
      events: ['file_created', 'share_revoked']
    });

    // 1. Trigger mkdir -> file_created
    const mkdirRes = await fetch(`${serverUrl}/api/files/local/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/NewFolder' })
    });
    assert.equal(mkdirRes.status, 201);
    assert.ok(receivedEvents.some(e => e.payload.event === 'file_created' && e.payload.data.path === '/NewFolder'));

    // 2. Trigger share creation & deletion -> share_revoked
    const pubRes = await fetch(`${serverUrl}/api/shares/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: '/NewFolder', is_directory: 1 })
    });
    const pubData = await pubRes.json();
    assert.equal(pubRes.status, 201);

    const shareId = pubData.share.id;
    const delShareRes = await fetch(`${serverUrl}/api/shares/public/${shareId}`, {
      method: 'DELETE'
    });
    assert.equal(delShareRes.status, 200);
    assert.ok(receivedEvents.some(e => e.payload.event === 'share_revoked' && String(e.payload.data.share_id) === String(shareId)));

    await db.deleteWebhook(webhook.id, userId);
  });

  test('Issue #37: Automation Rules DB CRUD & API endpoints', async () => {
    // 1. Create automation rule via DB helper
    const rule1 = await db.createAutomationRule({
      userId,
      name: 'Auto Move Invoices',
      trigger_event: 'file_created',
      condition_type: 'keyword',
      condition_value: 'invoice',
      action_type: 'move',
      action_target: '/Invoices',
      priority: 10
    });
    assert.ok(rule1);
    assert.equal(rule1.name, 'Auto Move Invoices');
    assert.equal(rule1.action_type, 'move');
    assert.equal(rule1.action_target, '/Invoices');

    // 2. Create automation rule via API endpoint
    const apiRes = await fetch(`${serverUrl}/api/webhooks/automation-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Auto Tag PDFs',
        trigger_event: 'file_created',
        condition_type: 'extension',
        condition_value: 'pdf',
        action_type: 'tag',
        action_target: 'important-pdf',
        priority: 5
      })
    });
    const apiData = await apiRes.json();
    assert.equal(apiRes.status, 201);
    assert.equal(apiData.success, true);
    assert.ok(apiData.rule.id);

    // 3. List rules via API endpoint
    const listRes = await fetch(`${serverUrl}/api/webhooks/automation-rules`);
    const listData = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.ok(listData.rules.length >= 2);

    // Clean up
    await db.deleteAutomationRule(userId, rule1.id);
    await db.deleteAutomationRule(userId, apiData.rule.id);
  });

  test('Issue #37: Event-driven rule engine auto-moves and auto-tags files on file_created trigger', async () => {
    const userFilesDir = path.join(dataDir, 'users', userId, 'files');
    await fs.mkdir(userFilesDir, { recursive: true });

    // Create rules
    const moveRule = await db.createAutomationRule({
      userId,
      name: 'Auto-Move Receipts',
      trigger_event: 'file_created',
      condition_type: 'keyword',
      condition_value: 'receipt',
      action_type: 'move',
      action_target: '/Finance/Receipts',
      priority: 10
    });

    const tagRule = await db.createAutomationRule({
      userId,
      name: 'Auto-Tag Reports',
      trigger_event: 'file_created',
      condition_type: 'extension',
      condition_value: 'pdf',
      action_type: 'tag',
      action_target: 'automated-report',
      priority: 5
    });

    // Create physical files to test
    const receiptPath = '/march_receipt.txt';
    const absReceipt = path.join(userFilesDir, 'march_receipt.txt');
    await fs.writeFile(absReceipt, 'receipt content 123');

    const reportPath = '/annual_report.pdf';
    const absReport = path.join(userFilesDir, 'annual_report.pdf');
    await fs.writeFile(absReport, 'pdf report data');

    // Trigger dispatchWebhookEvent for file_created
    const dispatchResults = await dispatchWebhookEvent(userId, 'file_created', { path: receiptPath, userRoot: userFilesDir });
    assert.ok(dispatchResults);

    // Check that march_receipt.txt was moved to /Finance/Receipts/march_receipt.txt
    const movedFileDisk = path.join(userFilesDir, 'Finance', 'Receipts', 'march_receipt.txt');
    const movedExists = await fs.stat(movedFileDisk).then(() => true).catch(() => false);
    assert.equal(movedExists, true, 'File should be auto-moved to /Finance/Receipts/march_receipt.txt');

    // Trigger dispatchWebhookEvent for reportPath
    await dispatchWebhookEvent(userId, 'file_created', { path: reportPath, userRoot: userFilesDir });
    const tags = await db.getTagsByUser(userId, reportPath);
    assert.ok(tags.some(t => t.tag_name === 'automated-report'), 'File should be auto-tagged');

    // Clean up rules
    await db.deleteAutomationRule(userId, moveRule.id);
    await db.deleteAutomationRule(userId, tagRule.id);
  });

  test('Issue #40: DB Helpers for Personal Access Tokens (PATs)', async () => {
    // 1. Create PAT
    const pat = await db.createPersonalAccessToken({
      userId,
      name: 'CI/CD Deployment Token',
      expiresAt: null
    });
    assert.ok(pat);
    assert.equal(pat.name, 'CI/CD Deployment Token');
    assert.ok(pat.token.startsWith('fs_pat_'));

    // 2. List PATs
    const pats = await db.getPersonalAccessTokensByUser(userId);
    assert.ok(pats.length >= 1);
    assert.ok(pats.some(p => p.id === pat.id));

    // 3. Validate PAT by token
    const fetched = await db.getPersonalAccessTokenByToken(pat.token);
    assert.ok(fetched);
    assert.equal(fetched.user_id, userId);

    // 4. Delete PAT
    const deleted = await db.deletePersonalAccessToken(userId, pat.id);
    assert.equal(deleted, true);

    const check = await db.getPersonalAccessTokenByToken(pat.token);
    assert.equal(check, null);
  });

  test('Issue #40: API Endpoints for PAT Management & Authorization header authentication', async () => {
    // 1. Create PAT via API
    const createRes = await fetch(`${serverUrl}/api/webhooks/pats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Backup Script Token' })
    });
    const createData = await createRes.json();
    assert.equal(createRes.status, 201);
    assert.equal(createData.success, true);
    assert.ok(createData.pat.token);

    const tokenVal = createData.pat.token;
    const patId = createData.pat.id;

    // 2. List PATs via API
    const listRes = await fetch(`${serverUrl}/api/webhooks/pats`, {
      headers: { 'Authorization': `Bearer ${tokenVal}` }
    });
    const listData = await listRes.json();
    assert.equal(listRes.status, 200);
    assert.ok(listData.pats.some(p => p.id === patId));

    // 3. Authenticate request using PAT in Bearer header without active session
    const webhooksRes = await fetch(`${serverUrl}/api/webhooks`, {
      headers: { 'Authorization': `Bearer ${tokenVal}` }
    });
    assert.equal(webhooksRes.status, 200);

    // 4. Delete PAT via API
    const delRes = await fetch(`${serverUrl}/api/webhooks/pats/${patId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${tokenVal}` }
    });
    const delData = await delRes.json();
    assert.equal(delRes.status, 200);
    assert.equal(delData.success, true);
  });
});



