const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const presenceRouter = require('../routes/presence');

async function setupApp() {
  await db.initDb();
  await db.run('DELETE FROM user_presence;');

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_presence_secret',
    resave: false,
    saveUninitialized: true
  }));

  // Mock auth middleware
  app.use((req, res, next) => {
    const authHeader = req.headers['x-test-user'];
    if (authHeader) {
      req.session = req.session || {};
      req.session.userId = authHeader;
      req.session.user = { id: authHeader, username: authHeader };
      req.userId = authHeader;
    }
    next();
  });

  app.use('/api/presence', presenceRouter);
  return app;
}

test('Presence Tracking: Unauthenticated access returns 401', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const resPost = await fetch(`http://localhost:${port}/api/presence/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: '/docs' })
    });
    assert.equal(resPost.status, 401);

    const resGet = await fetch(`http://localhost:${port}/api/presence/folder?path=/docs`);
    assert.equal(resGet.status, 401);
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Presence Tracking: DB helpers recordPresenceHeartbeat & getActiveFolderPresence', async (t) => {
  await db.initDb();
  await db.run('DELETE FROM user_presence;');
  const userId1 = 'user_presence_db_1';
  const userId2 = 'user_presence_db_2';

  await db.upsertUser(userId1, 'alice_db', 'alice_db@example.com');
  await db.upsertUser(userId2, 'bob_db', 'bob_db@example.com');

  // Record presence for user 1
  await db.recordPresenceHeartbeat(userId1, { username: 'alice_db', folder_path: '/projects', file_name: 'plan.txt', action: 'viewing' });
  let active = await db.getActiveFolderPresence('/projects');
  assert.equal(active.length, 1);
  assert.equal(active[0].user_id, userId1);
  assert.equal(active[0].username, 'alice_db');
  assert.equal(active[0].action, 'viewing');

  // Record presence for user 2 in same folder
  await db.recordPresenceHeartbeat(userId2, { username: 'bob_db', folder_path: '/projects', file_name: 'plan.txt', action: 'editing' });
  active = await db.getActiveFolderPresence('/projects');
  assert.equal(active.length, 2);

  // Update user 1 action to editing
  await db.recordPresenceHeartbeat(userId1, { username: 'alice_db', folder_path: '/projects', file_name: 'plan.txt', action: 'editing' });
  active = await db.getActiveFolderPresence('/projects');
  assert.equal(active.length, 2);
  const aliceRecord = active.find(r => r.user_id === userId1);
  assert.equal(aliceRecord.action, 'editing');

  // Remove presence for user 1
  await db.removeUserPresence(userId1, '/projects');
  active = await db.getActiveFolderPresence('/projects');
  assert.equal(active.length, 1);
  assert.equal(active[0].user_id, userId2);

  await db.closeDb();
});

test('Presence Tracking: Heartbeat POST and Folder GET endpoints', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Send heartbeat for User A
    const resA = await fetch(`http://localhost:${port}/api/presence/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_api_a'
      },
      body: JSON.stringify({ folder_path: '/shared', file_name: 'data.json', action: 'viewing' })
    });
    assert.equal(resA.status, 200);
    const dataA = await resA.json();
    assert.equal(dataA.success, true);
    assert.ok(Array.isArray(dataA.presence));
    assert.equal(dataA.presence.length, 1);
    assert.equal(dataA.presence[0].user_id, 'user_api_a');

    // Send heartbeat for User B
    const resB = await fetch(`http://localhost:${port}/api/presence/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_api_b'
      },
      body: JSON.stringify({ folder_path: '/shared', file_name: 'data.json', action: 'editing' })
    });
    assert.equal(resB.status, 200);
    const dataB = await resB.json();
    assert.equal(dataB.success, true);
    assert.equal(dataB.presence.length, 2);

    // Get presence for /shared
    const resGet = await fetch(`http://localhost:${port}/api/presence/folder?path=/shared`, {
      headers: { 'x-test-user': 'user_api_a' }
    });
    assert.equal(resGet.status, 200);
    const dataGet = await resGet.json();
    assert.equal(dataGet.success, true);
    assert.equal(dataGet.presence.length, 2);

    // Get presence for isolated folder /other
    const resOther = await fetch(`http://localhost:${port}/api/presence/folder?path=/other`, {
      headers: { 'x-test-user': 'user_api_a' }
    });
    assert.equal(resOther.status, 200);
    const dataOther = await resOther.json();
    assert.equal(dataOther.success, true);
    assert.equal(dataOther.presence.length, 0);

    // Leave presence endpoint
    const resLeave = await fetch(`http://localhost:${port}/api/presence/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_api_a'
      },
      body: JSON.stringify({ folder_path: '/shared' })
    });
    assert.equal(resLeave.status, 200);

    // Verify User A left /shared
    const resCheck = await fetch(`http://localhost:${port}/api/presence/folder?path=/shared`, {
      headers: { 'x-test-user': 'user_api_b' }
    });
    const dataCheck = await resCheck.json();
    assert.equal(dataCheck.presence.length, 1);
    assert.equal(dataCheck.presence[0].user_id, 'user_api_b');
  } finally {
    server.close();
    await db.closeDb();
  }
});
