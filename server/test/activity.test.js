const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const db = require('../db');

describe('Activity Log & Audit Trail (#22)', () => {
  const user = { id: 'user_activity_1', username: 'act_user', displayName: 'Activity User' };

  before(async () => {
    await db.initDb();
    await db.upsertUser(user.id, user.username, 'act@example.com', 'local', null, user.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM activity_log WHERE user_id = ?', [user.id]);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  });

  test('logs file upload activity', async () => {
    const log = await db.logActivity(user.id, 'upload', '/Documents/report.pdf', 'report.pdf', 0);
    assert.ok(log.id);
    assert.equal(log.action, 'upload');
    assert.equal(log.file_path, '/Documents/report.pdf');
    assert.equal(log.file_name, 'report.pdf');
  });

  test('logs file move activity with details', async () => {
    const details = JSON.stringify({ dst: '/Archive/report.pdf' });
    const log = await db.logActivity(user.id, 'move', '/Documents/report.pdf', 'report.pdf', 0, details);
    assert.ok(log.id);
    assert.equal(log.action, 'move');
    assert.equal(log.details, details);
  });

  test('retrieves activity logs for user with limit pagination', async () => {
    await db.logActivity(user.id, 'mkdir', '/Photos', 'Photos', 1);
    await db.logActivity(user.id, 'share_internal', '/Photos', 'Photos', 1, JSON.stringify({ sharee: 'bob' }));

    const logs = await db.getActivityLogByUser(user.id, 10, 0);
    assert.ok(logs.length >= 4);
    assert.equal(logs[0].action, 'share_internal');
    assert.equal(logs[1].action, 'mkdir');
  });
});

describe('Role-Based Security & Audit Logs (#44)', () => {
  const adminUser = { id: 'user_admin_44', username: 'admin_44', displayName: 'Admin User 44' };
  const targetUser = { id: 'user_target_44', username: 'target_44', displayName: 'Target User 44' };
  let app;
  let server;
  let baseUrl;
  let currentAuthUserId = adminUser.id;

  before(async () => {
    await db.initDb();
    await db.run('DELETE FROM users WHERE id IN (?, ?)', [adminUser.id, targetUser.id]);
    await db.run('DELETE FROM admin_audit_log WHERE admin_id = ? OR target_user_id = ?', [adminUser.id, targetUser.id]);
    await db.run('DELETE FROM file_access_logs WHERE user_id IN (?, ?)', [adminUser.id, targetUser.id]);

    await db.upsertUser(adminUser.id, adminUser.username, 'admin44@example.com', 'local', null, adminUser.displayName, null, 'admin');
    await db.upsertUser(targetUser.id, targetUser.username, 'target44@example.com', 'local', null, targetUser.displayName, null, 'user');

    const adminRouter = require('../routes/admin');
    const activityRouter = require('../routes/activity');

    app = express();
    app.use(express.json());

    // Mock authentication middleware using currentAuthUserId
    app.use((req, res, next) => {
      req.userId = currentAuthUserId;
      next();
    });

    app.use('/api/admin', adminRouter);
    app.use('/api/activity', activityRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await db.run('DELETE FROM file_access_logs WHERE user_id IN (?, ?)', [adminUser.id, targetUser.id]);
    await db.run('DELETE FROM admin_audit_log WHERE admin_id = ? OR target_user_id = ?', [adminUser.id, targetUser.id]);
    await db.run('DELETE FROM users WHERE id IN (?, ?)', [adminUser.id, targetUser.id]);
  });

  test('updates and retrieves user role', async () => {
    const defaultRole = await db.getUserRole(targetUser.id);
    assert.equal(defaultRole, 'user');

    const updated = await db.updateUserRole(targetUser.id, 'viewer');
    assert.equal(updated.role, 'viewer');

    const newRole = await db.getUserRole(targetUser.id);
    assert.equal(newRole, 'viewer');

    const userInfo = await db.getUserById(targetUser.id);
    assert.equal(userInfo.role, 'viewer');

    await assert.rejects(
      async () => db.updateUserRole(targetUser.id, 'invalid_role'),
      /Invalid role/
    );
  });

  test('logs administrative action audit trail', async () => {
    const details = JSON.stringify({ reason: 'Security Audit' });
    const log = await db.logAdminAction(adminUser.id, 'user_disable', targetUser.id, details, '127.0.0.1');
    assert.ok(log.id);
    assert.equal(log.admin_id, adminUser.id);
    assert.equal(log.action, 'user_disable');
    assert.equal(log.target_user_id, targetUser.id);
    assert.equal(log.details, details);
    assert.equal(log.ip_address, '127.0.0.1');

    const logs = await db.getAdminAuditLogs(10, 0);
    assert.ok(logs.length > 0);
    const found = logs.find(l => l.id === log.id);
    assert.ok(found);
    assert.equal(found.action, 'user_disable');
  });

  test('logs role-based file access logs and retrieves them', async () => {
    const log1 = await db.logFileAccess(targetUser.id, 'viewer', 'read', '/Documents/report.pdf', 'granted', 'File read by viewer');
    const log2 = await db.logFileAccess(targetUser.id, 'viewer', 'delete', '/Documents/report.pdf', 'denied', 'Viewer role write restriction');

    assert.ok(log1.id);
    assert.equal(log1.status, 'granted');
    assert.ok(log2.id);
    assert.equal(log2.status, 'denied');

    const logs = await db.getFileAccessLogs({ userId: targetUser.id, status: 'denied' });
    assert.ok(logs.length > 0);
    assert.equal(logs[0].status, 'denied');
    assert.equal(logs[0].action, 'delete');
  });

  test('GET /api/admin/audit-logs requires admin role', async () => {
    currentAuthUserId = targetUser.id; // targetUser is 'viewer' / 'user'
    await db.updateUserRole(targetUser.id, 'user');

    const resForbidden = await fetch(`${baseUrl}/api/admin/audit-logs`);
    assert.equal(resForbidden.status, 403);

    currentAuthUserId = adminUser.id; // adminUser is 'admin'
    const resOk = await fetch(`${baseUrl}/api/admin/audit-logs`);
    assert.equal(resOk.status, 200);
    const body = await resOk.json();
    assert.ok(Array.isArray(body.logs));
  });

  test('PATCH /api/admin/users/:id/role updates user role and records audit log', async () => {
    currentAuthUserId = adminUser.id;
    const res = await fetch(`${baseUrl}/api/admin/users/${targetUser.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.role, 'admin');

    const adminLogs = await db.getAdminAuditLogs(10, 0);
    const roleChangeLog = adminLogs.find(l => l.admin_id === adminUser.id && l.action === 'role_change');
    assert.ok(roleChangeLog);
    assert.equal(roleChangeLog.target_user_id, targetUser.id);
  });

  test('GET /api/activity/file-access retrieves role-based access logs', async () => {
    currentAuthUserId = adminUser.id;
    await db.logFileAccess(adminUser.id, 'admin', 'read', '/Admin/secret.txt', 'granted', 'Admin read');

    const res = await fetch(`${baseUrl}/api/activity/file-access?userId=${adminUser.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.logs));
    assert.ok(body.logs.length > 0);
  });

  test('GET /api/admin/users retrieves users list for admin', async () => {
    currentAuthUserId = adminUser.id;
    const res = await fetch(`${baseUrl}/api/admin/users`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.users));
    const foundAdmin = body.users.find(u => u.id === adminUser.id);
    assert.ok(foundAdmin);
    assert.equal(foundAdmin.role, 'admin');
  });

  test('enforceFileAccessRole blocks mutating HTTP requests for viewer role', async () => {
    const { enforceFileAccessRole } = require('../middleware/auth');
    await db.updateUserRole(targetUser.id, 'viewer');

    let req = { userId: targetUser.id, method: 'DELETE', path: '/Files/important.doc' };
    let statusCode = 0;
    let jsonBody = null;
    let res = {
      status(code) { statusCode = code; return this; },
      json(data) { jsonBody = data; return this; }
    };
    let nextCalled = false;

    await enforceFileAccessRole(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
    assert.ok(jsonBody.error.includes('viewer'));

    const accessLogs = await db.getFileAccessLogs({ userId: targetUser.id, status: 'denied' });
    assert.ok(accessLogs.length > 0);
  });
});


