const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const db = require('../db');
const fileRequestsRouter = require('../routes/file_requests');

async function setupApp() {
  await db.initDb();
  await db.run('DELETE FROM file_requests').catch(() => {});

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_file_request_secret',
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
      req.userId = authHeader;
    }
    next();
  });

  app.use('/api/file-requests', fileRequestsRouter);
  app.use('/api/public', fileRequestsRouter);
  return app;
}

test('File Request Portal: DB Helper CRUD Operations', async (t) => {
  await db.initDb();
  await db.run('DELETE FROM file_requests').catch(() => {});
  const userId = 'user_fr_db_test';
  await db.upsertUser(userId, 'fr_user', 'fr@example.com');

  try {
    const fr = await db.createFileRequest(userId, {
      target_folder: '/DropBoxFolder',
      title: 'Submit Homework',
      description: 'Please upload your PDF reports',
      expires_at: '2099-12-31T23:59:59.000Z',
      max_uploads: 5,
      token: 'req_token_db_123'
    });

    assert.ok(fr.id);
    assert.equal(fr.token, 'req_token_db_123');
    assert.equal(fr.target_folder, '/DropBoxFolder');
    assert.equal(fr.max_uploads, 5);
    assert.equal(fr.upload_count, 0);

    const fetched = await db.getFileRequestByToken('req_token_db_123');
    assert.ok(fetched);
    assert.equal(fetched.user_id, userId);
    assert.equal(fetched.title, 'Submit Homework');

    const list = await db.getFileRequestsByUser(userId);
    assert.equal(list.length, 1);

    await db.incrementFileRequestUploads(fr.id);
    const updated = await db.getFileRequestByToken('req_token_db_123');
    assert.equal(updated.upload_count, 1);

    const deleted = await db.deleteFileRequest(userId, fr.id);
    assert.equal(deleted, true);

    const listAfter = await db.getFileRequestsByUser(userId);
    assert.equal(listAfter.length, 0);
  } finally {
    await db.run('DELETE FROM file_requests').catch(() => {});
    await db.closeDb();
  }
});

test('File Request Portal: Management API (Create, List, Revoke)', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_fr_mgmt';

  try {
    await db.upsertUser(userId, 'fr_mgmt_user');

    // Unauthenticated create fails
    const resUnauth = await fetch(`http://localhost:${port}/api/file-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_folder: '/Submissions' })
    });
    assert.equal(resUnauth.status, 401);

    // Authenticated create
    const resCreate = await fetch(`http://localhost:${port}/api/file-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': userId
      },
      body: JSON.stringify({
        target_folder: '/Submissions',
        title: 'Project Files',
        max_uploads: 10
      })
    });
    assert.equal(resCreate.status, 201);
    const bodyCreate = await resCreate.json();
    assert.equal(bodyCreate.success, true);
    assert.ok(bodyCreate.request.token);
    assert.equal(bodyCreate.request.target_folder, '/Submissions');

    const createdId = bodyCreate.request.id;

    // List user file requests
    const resList = await fetch(`http://localhost:${port}/api/file-requests`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resList.status, 200);
    const bodyList = await resList.json();
    assert.equal(bodyList.requests.length, 1);

    // Revoke file request
    const resDel = await fetch(`http://localhost:${port}/api/file-requests/${createdId}`, {
      method: 'DELETE',
      headers: { 'x-test-user': userId }
    });
    assert.equal(resDel.status, 200);

    const resListAfter = await fetch(`http://localhost:${port}/api/file-requests`, {
      headers: { 'x-test-user': userId }
    });
    const bodyListAfter = await resListAfter.json();
    assert.equal(bodyListAfter.requests.length, 0);
  } finally {
    await db.run('DELETE FROM file_requests').catch(() => {});
    server.close();
    await db.closeDb();
  }
});

test('File Request Portal: Anonymous File Upload (POST /api/public/upload/:token)', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_fr_upload_owner';

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const targetFolderOnDisk = path.join(dataDir, 'users', userId, 'UploadsFolder');

  try {
    await db.upsertUser(userId, 'fr_owner');

    // Create file request with max 2 uploads
    const fr = await db.createFileRequest(userId, {
      target_folder: '/UploadsFolder',
      title: 'Drop Files Here',
      max_uploads: 2,
      token: 'token_drop_portal_999'
    });

    // 1. Upload non-existent token -> 404
    const res404 = await fetch(`http://localhost:${port}/api/public/upload/invalid_token_xyz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.txt', content: 'Hello' })
    });
    assert.equal(res404.status, 404);

    // 2. Successful anonymous upload 1
    const resUpload1 = await fetch(`http://localhost:${port}/api/public/upload/token_drop_portal_999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'assignment1.txt', content: 'Homework content 1' })
    });
    assert.equal(resUpload1.status, 201);
    const bodyUpload1 = await resUpload1.json();
    assert.equal(bodyUpload1.success, true);

    // Verify file created on disk
    const filePathOnDisk = path.join(targetFolderOnDisk, 'assignment1.txt');
    const contentOnDisk = await fs.readFile(filePathOnDisk, 'utf8');
    assert.equal(contentOnDisk, 'Homework content 1');

    // 3. Successful upload 2 (reaches max limit of 2)
    const resUpload2 = await fetch(`http://localhost:${port}/api/public/upload/token_drop_portal_999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'assignment2.txt', content: 'Homework content 2' })
    });
    assert.equal(resUpload2.status, 201);

    // 4. Upload 3 exceeds limit -> 410 Gone
    const resUpload3 = await fetch(`http://localhost:${port}/api/public/upload/token_drop_portal_999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'assignment3.txt', content: 'Homework content 3' })
    });
    assert.equal(resUpload3.status, 410);

  } finally {
    // Cleanup created files on disk and db
    await fs.rm(targetFolderOnDisk, { recursive: true, force: true }).catch(() => {});
    await db.run('DELETE FROM file_requests').catch(() => {});
    server.close();
    await db.closeDb();
  }
});

test('File Request Portal: Expired Link (POST /api/public/upload/:token)', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_fr_expired';

  try {
    await db.upsertUser(userId, 'fr_exp_user');

    await db.createFileRequest(userId, {
      target_folder: '/Incoming',
      expires_at: '2020-01-01T00:00:00.000Z', // Expired date
      token: 'token_expired_req'
    });

    const resExp = await fetch(`http://localhost:${port}/api/public/upload/token_expired_req`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'late.txt', content: 'Too late' })
    });
    assert.equal(resExp.status, 410);

    const bodyExp = await resExp.json();
    assert.ok(bodyExp.error.includes('expired'));
  } finally {
    await db.run('DELETE FROM file_requests').catch(() => {});
    server.close();
    await db.closeDb();
  }
});
