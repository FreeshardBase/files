const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const commentsRouter = require('../routes/comments');

describe('Collaborative File Comments & Annotation System (#79)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-comment-1';
  const userBId = 'user-comment-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_comments_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_comments.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'commentuser1', 'comment1@freeshard.local');
    await db.upsertUser(userBId, 'commentuser2', 'comment2@freeshard.local');

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

    app.use('/api/comments', commentsRouter);

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

  test('DB Helpers: createFileComment, getFileComments, resolveFileComment, deleteFileComment', async () => {
    const created = await db.createFileComment(userId, '/docs/proposal.pdf', 'Please review section 2');
    assert.ok(created);
    assert.equal(created.user_id, userId);
    assert.equal(created.file_path, '/docs/proposal.pdf');
    assert.equal(created.comment, 'Please review section 2');
    assert.equal(created.resolved, 0);
    assert.ok(created.created_at);

    const fileComments = await db.getFileComments(userId, '/docs/proposal.pdf');
    assert.equal(fileComments.length, 1);
    assert.equal(fileComments[0].comment, 'Please review section 2');

    const resolved = await db.resolveFileComment(created.id, userId, 1);
    assert.ok(resolved);
    assert.equal(resolved.resolved, 1);

    const deleted = await db.deleteFileComment(created.id, userId);
    assert.equal(deleted, true);

    const afterDelete = await db.getFileComments(userId, '/docs/proposal.pdf');
    assert.equal(afterDelete.length, 0);
  });

  test('API Endpoint: POST /api/comments/create attaches comment to file', async () => {
    const res = await fetch(`${serverUrl}/api/comments/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/design/mockup.png',
        comment: 'Change header color to blue'
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.comment);
    assert.equal(data.comment.file_path, '/design/mockup.png');
    assert.equal(data.comment.comment, 'Change header color to blue');
    assert.equal(data.comment.resolved, 0);
  });

  test('API Endpoint: POST /api/comments/create validates required fields', async () => {
    const res = await fetch(`${serverUrl}/api/comments/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ filePath: '/design/mockup.png' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: GET /api/comments lists comments and supports path filtering', async () => {
    await fetch(`${serverUrl}/api/comments/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/src/index.js',
        comment: 'Add unit tests here'
      })
    });

    const resAll = await fetch(`${serverUrl}/api/comments`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resAll.status, 200);
    const dataAll = await resAll.json();
    assert.equal(dataAll.success, true);
    assert.ok(Array.isArray(dataAll.comments));
    assert.ok(dataAll.comments.length >= 2);

    const resFiltered = await fetch(`${serverUrl}/api/comments?path=${encodeURIComponent('/src/index.js')}`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resFiltered.status, 200);
    const dataFiltered = await resFiltered.json();
    assert.equal(dataFiltered.success, true);
    assert.equal(dataFiltered.comments.length, 1);
    assert.equal(dataFiltered.comments[0].comment, 'Add unit tests here');
  });

  test('API Endpoint: POST /api/comments/resolve updates resolved status', async () => {
    const createRes = await fetch(`${serverUrl}/api/comments/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/notes.txt',
        comment: 'Fix typo on line 5'
      })
    });
    const { comment } = await createRes.json();

    const resolveRes = await fetch(`${serverUrl}/api/comments/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        id: comment.id,
        resolved: true
      })
    });

    assert.equal(resolveRes.status, 200);
    const resolveData = await resolveRes.json();
    assert.equal(resolveData.success, true);
    assert.equal(resolveData.comment.resolved, 1);
  });

  test('User isolation: User B cannot access User A comments', async () => {
    const resB = await fetch(`${serverUrl}/api/comments?path=${encodeURIComponent('/notes.txt')}`, {
      headers: { 'x-test-user': userBId }
    });
    assert.equal(resB.status, 200);
    const dataB = await resB.json();
    assert.equal(dataB.comments.length, 0);
  });
});
