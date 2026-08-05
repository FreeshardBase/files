process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const providerRoutes = require('../routes/providers');

describe('Issue #74: Provider Authentication Flows Audit & UI Mapping (OAuth vs Credentials)', () => {
  let app;
  let server;
  let baseUrl;

  beforeEach(async () => {
    await db.initDb();
    await db.run("INSERT OR IGNORE INTO users (id, username, email) VALUES (1, 'testuser', 'testuser@example.com')");

    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true
    }));

    // Mock authentication middleware
    app.use((req, res, next) => {
      req.userId = 1;
      req.session.userId = 1;
      req.session.user = { id: 1, username: 'testuser' };
      next();
    });

    app.use('/api/providers', providerRoutes);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('GET /api/providers/supported-flows returns classified OAuth 2.0 and Credential-based providers', async () => {
    const res = await fetch(`${baseUrl}/api/providers/supported-flows`);
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.oauth_providers));
    assert.ok(Array.isArray(data.credential_providers));

    // Verify OAuth 2.0 1-click providers
    const gdrive = data.oauth_providers.find(p => p.type === 'gdrive');
    assert.ok(gdrive);
    assert.strictEqual(gdrive.flow, 'oauth2');
    assert.strictEqual(gdrive.auth_url, '/api/providers/gdrive/auth');

    const dropbox = data.oauth_providers.find(p => p.type === 'dropbox');
    assert.ok(dropbox);
    assert.strictEqual(dropbox.flow, 'oauth2');
    assert.strictEqual(dropbox.auth_url, '/api/providers/dropbox/auth');

    // Verify Credential-based form providers
    const s3 = data.credential_providers.find(p => p.type === 's3');
    assert.ok(s3);
    assert.strictEqual(s3.flow, 'credentials');
    assert.deepStrictEqual(s3.fields, ['name', 'endpoint', 'bucket', 'accessKey', 'secretKey']);

    const moveit = data.credential_providers.find(p => p.type === 'moveit');
    assert.ok(moveit);
    assert.strictEqual(moveit.flow, 'credentials');
    assert.deepStrictEqual(moveit.fields, ['name', 'host', 'username', 'password']);
  });

  test('POST /api/providers/s3 creates a credential-based S3 provider connection', async () => {
    const res = await fetch(`${baseUrl}/api/providers/s3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Test MinIO Bucket',
        endpoint: 'http://localhost:9000',
        bucket: 'test-bucket',
        accessKey: 'minioadmin',
        secretKey: 'minioadmin'
      })
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.connectionId);
  });

  test('POST /api/providers/moveit creates a credential-based MOVEit provider connection', async () => {
    const res = await fetch(`${baseUrl}/api/providers/moveit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Test MOVEit Server',
        host: 'moveit.example.com',
        username: 'moveit_user',
        password: 'secure_password'
      })
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.connectionId);
  });
});
