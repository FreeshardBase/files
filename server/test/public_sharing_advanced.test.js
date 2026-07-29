const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

describe('Advanced Public Link Management (#53)', () => {
  const user = { id: 'user_adv_share', username: 'adv_share_user', displayName: 'Advanced Share User' };
  const filePath = '/Documents/presentation.pdf';

  before(async () => {
    await db.initDb();
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [user.id]);
    await db.upsertUser(user.id, user.username, 'adv@example.com', 'local', null, user.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [user.id]);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  });

  test('creates public share with custom label and datetime expiration', async () => {
    const expiresAt = '2026-12-31T23:59:00';
    const label = 'Client Presentation Link';

    const share = await db.createPublicShare(user.id, 'tok_adv_1', filePath, 0, null, expiresAt, 5, label);

    assert.ok(share.id);
    assert.equal(share.token, 'tok_adv_1');
    assert.equal(share.label, label);
    assert.equal(share.expires_at, expiresAt);
    assert.equal(share.max_downloads, 5);
  });

  test('updates public share label, datetime expiration, and removes password', async () => {
    const share = await db.createPublicShare(user.id, 'tok_adv_2', filePath, 0, 'initial_hash', '2026-08-01T10:00:00', 10, 'Draft');

    const updated = await db.updatePublicShare(share.id, user.id, {
      label: 'Final Approved Link',
      expiresAt: '2026-09-01T18:30:00',
      maxDownloads: 25,
      clearPassword: true
    });

    assert.equal(updated.label, 'Final Approved Link');
    assert.equal(updated.expires_at, '2026-09-01T18:30:00');
    assert.equal(updated.max_downloads, 25);
    assert.equal(updated.password_hash, null);
  });
});
