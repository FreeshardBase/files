const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
