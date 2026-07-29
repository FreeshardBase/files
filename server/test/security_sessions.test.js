const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const securityRouter = require('../routes/security');

async function setupApp() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_security_secret',
    resave: false,
    saveUninitialized: true
  }));

  // Auth middleware mock
  app.use((req, res, next) => {
    const authHeader = req.headers['x-test-user'];
    if (authHeader) {
      req.session = req.session || {};
      req.session.userId = authHeader;
      req.session.user = { id: authHeader, username: authHeader };
    }
    next();
  });

  app.use('/api/security', securityRouter);
  return app;
}

test('Session & Device Security: Unauthenticated access returns 401', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const resGet = await fetch(`http://localhost:${port}/api/security/sessions`);
    assert.equal(resGet.status, 401);

    const resDel = await fetch(`http://localhost:${port}/api/security/sessions/sess_123`, {
      method: 'DELETE'
    });
    assert.equal(resDel.status, 401);
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Session & Device Security: DB helper CRUD operations', async (t) => {
  await db.initDb();
  const userId = 'user_sec_db_test';
  await db.upsertUser(userId, 'sec_user', 'sec@example.com');

  try {
    const sess1 = await db.createSecuritySession({
      id: 'sess_db_1',
      userId,
      deviceType: 'Desktop',
      ipAddress: '192.168.1.10',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)'
    });

    assert.equal(sess1.id, 'sess_db_1');
    assert.equal(sess1.user_id, userId);
    assert.equal(sess1.device_type, 'Desktop');
    assert.equal(sess1.ip_address, '192.168.1.10');

    const list = await db.getSecuritySessionsByUser(userId);
    assert.equal(list.length, 1);

    const retrieved = await db.getSecuritySessionById(userId, 'sess_db_1');
    assert.ok(retrieved);
    assert.equal(retrieved.id, 'sess_db_1');

    const deleted = await db.deleteSecuritySession(userId, 'sess_db_1');
    assert.equal(deleted, true);

    const listAfter = await db.getSecuritySessionsByUser(userId);
    assert.equal(listAfter.length, 0);
  } finally {
    await db.closeDb();
  }
});

test('Session & Device Security: GET /api/security/sessions returns active user sessions', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_sec_api_1';

  try {
    await db.upsertUser(userId, 'sec_api_user_1');
    await db.createSecuritySession({
      id: 'sess_api_1',
      userId,
      deviceType: 'Mobile',
      ipAddress: '10.0.0.5',
      userAgent: 'iPhone iOS 17'
    });
    await db.createSecuritySession({
      id: 'sess_api_2',
      userId,
      deviceType: 'Desktop',
      ipAddress: '127.0.0.1',
      userAgent: 'Firefox Linux'
    });

    const res = await fetch(`http://localhost:${port}/api/security/sessions`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 2);

    const sessIds = body.sessions.map(s => s.id);
    assert.ok(sessIds.includes('sess_api_1'));
    assert.ok(sessIds.includes('sess_api_2'));
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Session & Device Security: DELETE /api/security/sessions/:id revokes session instantly', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_sec_revoke';

  try {
    await db.upsertUser(userId, 'sec_revoke_user');
    await db.createSecuritySession({
      id: 'sess_to_revoke',
      userId,
      deviceType: 'Tablet',
      ipAddress: '172.16.0.2',
      userAgent: 'iPad Safari'
    });

    // Revoke existing session
    const resDel = await fetch(`http://localhost:${port}/api/security/sessions/sess_to_revoke`, {
      method: 'DELETE',
      headers: { 'x-test-user': userId }
    });
    assert.equal(resDel.status, 200);

    const bodyDel = await resDel.json();
    assert.equal(bodyDel.success, true);
    assert.equal(bodyDel.revokedSessionId, 'sess_to_revoke');

    // Verify session list is empty now
    const resGet = await fetch(`http://localhost:${port}/api/security/sessions`, {
      headers: { 'x-test-user': userId }
    });
    const bodyGet = await resGet.json();
    assert.equal(bodyGet.sessions.length, 0);
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Session & Device Security: Revoking non-existent or other user session returns 404', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const user1 = 'user_sec_other_1';
  const user2 = 'user_sec_other_2';

  try {
    await db.upsertUser(user1, 'sec_user1');
    await db.upsertUser(user2, 'sec_user2');

    await db.createSecuritySession({
      id: 'sess_user2_private',
      userId: user2,
      deviceType: 'Desktop',
      ipAddress: '10.0.0.99',
      userAgent: 'Chrome Windows'
    });

    // Non-existent session ID
    const res404 = await fetch(`http://localhost:${port}/api/security/sessions/non_existent_sess`, {
      method: 'DELETE',
      headers: { 'x-test-user': user1 }
    });
    assert.equal(res404.status, 404);

    // User1 attempting to revoke User2's session
    const resOther = await fetch(`http://localhost:${port}/api/security/sessions/sess_user2_private`, {
      method: 'DELETE',
      headers: { 'x-test-user': user1 }
    });
    assert.equal(resOther.status, 404);

    // Verify User2's session is untouched
    const listUser2 = await db.getSecuritySessionsByUser(user2);
    assert.equal(listUser2.length, 1);
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Session & Device Security: Device type detection helper', async (t) => {
  const securityUtils = require('../utils/security_sessions');
  assert.equal(securityUtils.parseDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'), 'Mobile');
  assert.equal(securityUtils.parseDeviceType('Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)'), 'Tablet');
  assert.equal(securityUtils.parseDeviceType('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'), 'Desktop');
  assert.equal(securityUtils.parseDeviceType(''), 'Unknown');
});
