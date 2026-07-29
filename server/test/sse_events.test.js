const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const eventsRouter = require('../routes/events');
const filesRouter = require('../routes/files');
const sharingRouter = require('../routes/sharing');
const { emitSSEEvent, getClientsCount, removeAllClients } = require('../utils/sse_events');

async function setupApp() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_sse_secret',
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

  app.use('/api/events', eventsRouter);
  app.use('/api/files/local', filesRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/shares', sharingRouter);
  return app;
}

test('SSE Events: GET /api/events/stream connects and receives initial event', async (t) => {
  removeAllClients();
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/events/stream`, {
      headers: { 'x-test-user': 'user_sse_1' },
      signal: controller.signal
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('connection'), 'keep-alive');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);

    assert.ok(text.includes('event: connected'));
    assert.ok(text.includes('user_sse_1'));

    controller.abort();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    removeAllClients();
    server.close();
    await db.closeDb();
  }
});

test('SSE Events: Direct emitSSEEvent broadcasts event to active client', async (t) => {
  removeAllClients();
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/events/stream`, {
      headers: { 'x-test-user': 'user_sse_2' },
      signal: controller.signal
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Read initial connected message
    await reader.read();

    // Emit event
    emitSSEEvent('user_sse_2', 'file_uploaded', { path: '/Documents/test.txt', filename: 'test.txt' });

    const { value } = await reader.read();
    const text = decoder.decode(value);

    assert.ok(text.includes('event: file_uploaded'));
    assert.ok(text.includes('/Documents/test.txt'));

    controller.abort();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    removeAllClients();
    server.close();
    await db.closeDb();
  }
});

test('SSE Events: File operations (move, delete, share) emit real-time events', async (t) => {
  removeAllClients();
  await db.initDb();
  await db.upsertUser('user_sse_3', 'user_sse_3', 'user_sse_3@example.com');

  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/events/stream`, {
      headers: { 'x-test-user': 'user_sse_3' },
      signal: controller.signal
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Consume connected event
    await reader.read();

    // 1. Create a test directory
    const resMkdir = await fetch(`http://localhost:${port}/api/files/local/mkdir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_sse_3'
      },
      body: JSON.stringify({ path: '/TestDir' })
    });
    assert.equal(resMkdir.status, 201);

    // 2. Move/Rename file API call
    const resMove = await fetch(`http://localhost:${port}/api/files/local/move`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_sse_3'
      },
      body: JSON.stringify({ src: '/TestDir', dst: '/TestDir_Renamed' })
    });
    assert.equal(resMove.status, 200);

    const chunkMove = await reader.read();
    const textMove = decoder.decode(chunkMove.value);
    assert.ok(textMove.includes('event: file_renamed'));
    assert.ok(textMove.includes('/TestDir_Renamed'));

    // 3. Public share file API call
    const resShare = await fetch(`http://localhost:${port}/api/shares/public`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': 'user_sse_3'
      },
      body: JSON.stringify({ file_path: '/TestDir_Renamed', label: 'Shared Folder' })
    });
    assert.equal(resShare.status, 201);

    const chunkShare = await reader.read();
    const textShare = decoder.decode(chunkShare.value);
    assert.ok(textShare.includes('event: file_shared'));
    assert.ok(textShare.includes('/TestDir_Renamed'));

    // 4. Delete file API call
    const resDelete = await fetch(`http://localhost:${port}/api/files/local?path=/TestDir_Renamed&permanent=true`, {
      method: 'DELETE',
      headers: {
        'x-test-user': 'user_sse_3'
      }
    });
    assert.equal(resDelete.status, 200);

    const chunkDelete = await reader.read();
    const textDelete = decoder.decode(chunkDelete.value);
    assert.ok(textDelete.includes('event: file_deleted'));
    assert.ok(textDelete.includes('/TestDir_Renamed'));

    controller.abort();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    removeAllClients();
    server.close();
    await db.closeDb();
  }
});
