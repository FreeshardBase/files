const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const legalHoldRouter = require('../routes/legal_hold');
const filesRouter = require('../routes/files');
const trashRouter = require('../routes/trash');

// Helper to make HTTP requests to test server
function httpRequest(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const reqHeaders = { ...headers };
      let payload = null;

      if (body && typeof body === 'object' && !headers['Content-Type']) {
        payload = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      } else if (typeof body === 'string') {
        payload = body;
        if (!reqHeaders['Content-Length']) {
          reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
      }

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: reqHeaders
      }, (res) => {
        let resData = '';
        res.on('data', chunk => resData += chunk);
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = JSON.parse(resData); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || resData });
        });
      });

      req.on('error', err => {
        server.close();
        reject(err);
      });

      if (payload) req.write(payload);
      req.end();
    });
  });
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_secret',
    resave: false,
    saveUninitialized: true
  }));

  // Auth mock middleware
  app.use((req, res, next) => {
    req.userId = 'test-user-legal-hold';
    req.userRoot = path.join(__dirname, '..', '..', 'data', 'users', 'test-user-legal-hold');
    req.session.userId = 'test-user-legal-hold';
    req.session.user = { id: 'test-user-legal-hold', username: 'legalhold_user' };
    next();
  });

  app.use('/api/legal-holds', legalHoldRouter);
  app.use('/api/files/local', filesRouter);
  app.use('/api/trash', trashRouter);
  return app;
}

test('Automated Compliance Retention & Legal Hold Policies (#99)', async (t) => {
  const userId = 'test-user-legal-hold';
  const dataDir = path.join(__dirname, '..', '..', 'data', 'users', userId);
  await fs.mkdir(dataDir, { recursive: true });

  await db.initDb();
  await db.upsertUser(userId, 'legalhold_user', 'legalhold@test.local');

  // Clean up any existing legal holds for test user
  await db.run('DELETE FROM legal_holds WHERE user_id = ?', [userId]);

  const app = createTestApp();

  await t.test('DB Helper operations for legal_holds', async () => {
    const hold = await db.createLegalHold(userId, {
      file_path: '/contracts/confidential.pdf',
      policy_name: 'FINRA_7_YEAR',
      reason: 'Pending audit',
      lock_until: new Date(Date.now() + 86400000).toISOString()
    });

    assert.ok(hold.id, 'Should generate an ID for legal hold');
    assert.equal(hold.user_id, userId);
    assert.equal(hold.file_path, '/contracts/confidential.pdf');
    assert.equal(hold.policy_name, 'FINRA_7_YEAR');
    assert.equal(hold.status, 'active');

    const holds = await db.getLegalHoldsByUser(userId);
    assert.ok(holds.length >= 1);

    const fetched = await db.getLegalHoldById(hold.id, userId);
    assert.equal(fetched.id, hold.id);

    const activeCheck = await db.checkActiveLegalHold(userId, '/contracts/confidential.pdf');
    assert.ok(activeCheck, 'Should report active legal hold on file');

    const notHeldCheck = await db.checkActiveLegalHold(userId, '/other/unrestricted.txt');
    assert.equal(notHeldCheck, null, 'Should not report legal hold on unrestricted file');
  });

  await t.test('API Endpoints for Legal Hold Management', async () => {
    const createRes = await httpRequest(app, 'POST', '/api/legal-holds', {}, {
      file_path: '/finance/q3_report.xlsx',
      policy_name: 'SEC_COMPLIANCE',
      reason: 'Litigation hold',
      lock_until: '2099-12-31T23:59:59.000Z'
    });

    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.success, true);
    assert.ok(createRes.body.hold.id);

    const holdId = createRes.body.hold.id;

    const listRes = await httpRequest(app, 'GET', '/api/legal-holds');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.holds));
    assert.ok(listRes.body.holds.some(h => h.id === holdId));

    const getRes = await httpRequest(app, 'GET', `/api/legal-holds/${holdId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.hold.policy_name, 'SEC_COMPLIANCE');

    const releaseRes = await httpRequest(app, 'POST', `/api/legal-holds/${holdId}/release`);
    assert.equal(releaseRes.status, 200);
    assert.equal(releaseRes.body.released, true);

    const checkAfterRelease = await db.checkActiveLegalHold(userId, '/finance/q3_report.xlsx');
    assert.equal(checkAfterRelease, null, 'Legal hold should no longer be active after release');
  });

  await t.test('Enforce legal hold blocking on delete and overwrite', async () => {
    const filePathOnDisk = path.join(dataDir, 'protected_doc.pdf');
    await fs.writeFile(filePathOnDisk, 'Important legal document content');

    // Create legal hold on /protected_doc.pdf
    const hold = await db.createLegalHold(userId, {
      file_path: '/protected_doc.pdf',
      policy_name: 'LEGAL_RETAIN',
      reason: 'Audit requirement'
    });

    // Attempt soft delete via DELETE /api/files/local
    const deleteRes = await httpRequest(app, 'DELETE', '/api/files/local?path=/protected_doc.pdf');
    assert.equal(deleteRes.status, 403, 'Should block delete on active legal hold file with 403');
    assert.ok(deleteRes.body.error.includes('legal hold'));

    // Attempt permanent delete via DELETE /api/files/local
    const permDeleteRes = await httpRequest(app, 'DELETE', '/api/files/local?path=/protected_doc.pdf&permanent=true');
    assert.equal(permDeleteRes.status, 403, 'Should block permanent delete on active legal hold file with 403');

    // Release legal hold
    await db.releaseLegalHold(hold.id, userId);

    // Attempt delete after release -> should succeed
    const deleteSuccessRes = await httpRequest(app, 'DELETE', '/api/files/local?path=/protected_doc.pdf&permanent=true');
    assert.equal(deleteSuccessRes.status, 200, 'Should allow delete after legal hold is released');

    // Clean up disk file if left
    await fs.rm(filePathOnDisk, { force: true });
  });

  await t.test('Expired legal hold does not block file operations', async () => {
    const filePathOnDisk = path.join(dataDir, 'expired_doc.txt');
    await fs.writeFile(filePathOnDisk, 'Expired retention content');

    // Create legal hold with past lock_until date
    await db.createLegalHold(userId, {
      file_path: '/expired_doc.txt',
      policy_name: 'SHORT_RETENTION',
      lock_until: '2020-01-01T00:00:00.000Z'
    });

    const activeCheck = await db.checkActiveLegalHold(userId, '/expired_doc.txt');
    assert.equal(activeCheck, null, 'Expired legal hold should not be active');

    const deleteRes = await httpRequest(app, 'DELETE', '/api/files/local?path=/expired_doc.txt&permanent=true');
    assert.equal(deleteRes.status, 200, 'Should allow deletion when hold is expired');

    await fs.rm(filePathOnDisk, { force: true });
  });
});
