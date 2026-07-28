const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const tagsRouter = require('../routes/tags');

describe('Custom File Tagging, Taxonomy & Color Label System (#77)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-tag-1';
  const userBId = 'user-tag-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_tags_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_tags.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'taguser1', 'tag1@freeshard.local');
    await db.upsertUser(userBId, 'taguser2', 'tag2@freeshard.local');

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

    app.use('/api/tags', tagsRouter);

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

  test('DB Helpers: assignTag, removeTag, and getTagsByUser', async () => {
    const tag = await db.assignTag(userId, '/docs/report.pdf', 'Work', '#EF4444');
    assert.ok(tag);
    assert.equal(tag.user_id, userId);
    assert.equal(tag.file_path, '/docs/report.pdf');
    assert.equal(tag.tag_name, 'Work');
    assert.equal(tag.color, '#EF4444');

    const userTags = await db.getTagsByUser(userId);
    assert.ok(Array.isArray(userTags));
    assert.ok(userTags.some(t => t.file_path === '/docs/report.pdf' && t.tag_name === 'Work'));

    const pathTags = await db.getTagsByUser(userId, '/docs/report.pdf');
    assert.equal(pathTags.length, 1);
    assert.equal(pathTags[0].tag_name, 'Work');

    const removed = await db.removeTag(userId, '/docs/report.pdf', 'Work');
    assert.equal(removed, true);

    const afterRemove = await db.getTagsByUser(userId, '/docs/report.pdf');
    assert.equal(afterRemove.length, 0);
  });

  test('API Endpoint: POST /api/tags/assign assigns tag to file path', async () => {
    const res = await fetch(`${serverUrl}/api/tags/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/photos/vacation.jpg',
        tagName: 'Personal',
        color: '#10B981'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.tag);
    assert.equal(data.tag.file_path, '/photos/vacation.jpg');
    assert.equal(data.tag.tag_name, 'Personal');
    assert.equal(data.tag.color, '#10B981');
  });

  test('API Endpoint: POST /api/tags/assign validates required parameters', async () => {
    const res = await fetch(`${serverUrl}/api/tags/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ filePath: '/invalid.txt' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: GET /api/tags lists tags and supports filtering by path', async () => {
    await fetch(`${serverUrl}/api/tags/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/code/index.js',
        tagName: 'Dev',
        color: '#3B82F6'
      })
    });

    const resAll = await fetch(`${serverUrl}/api/tags`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resAll.status, 200);
    const dataAll = await resAll.json();
    assert.equal(dataAll.success, true);
    assert.ok(Array.isArray(dataAll.tags));
    assert.ok(dataAll.tags.length >= 2);

    const resFiltered = await fetch(`${serverUrl}/api/tags?path=${encodeURIComponent('/code/index.js')}`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resFiltered.status, 200);
    const dataFiltered = await resFiltered.json();
    assert.equal(dataFiltered.success, true);
    assert.equal(dataFiltered.tags.length, 1);
    assert.equal(dataFiltered.tags[0].tag_name, 'Dev');
  });

  test('API Endpoint: DELETE /api/tags/remove deletes tag mapping', async () => {
    const res = await fetch(`${serverUrl}/api/tags/remove`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/code/index.js',
        tagName: 'Dev'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);

    const resCheck = await fetch(`${serverUrl}/api/tags?path=${encodeURIComponent('/code/index.js')}`, {
      headers: { 'x-test-user': userId }
    });
    const dataCheck = await resCheck.json();
    assert.equal(dataCheck.tags.length, 0);
  });

  test('User isolation: User B cannot see or delete User A tags', async () => {
    await fetch(`${serverUrl}/api/tags/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        filePath: '/secret/file.txt',
        tagName: 'Private',
        color: '#6B7280'
      })
    });

    const resB = await fetch(`${serverUrl}/api/tags?path=${encodeURIComponent('/secret/file.txt')}`, {
      headers: { 'x-test-user': userBId }
    });
    const dataB = await resB.json();
    assert.equal(dataB.tags.length, 0);

    const deleteB = await fetch(`${serverUrl}/api/tags/remove`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userBId },
      body: JSON.stringify({
        filePath: '/secret/file.txt',
        tagName: 'Private'
      })
    });
    assert.equal(deleteB.status, 200);

    const checkA = await fetch(`${serverUrl}/api/tags?path=${encodeURIComponent('/secret/file.txt')}`, {
      headers: { 'x-test-user': userId }
    });
    const dataA = await checkA.json();
    assert.equal(dataA.tags.length, 1);
  });
});
