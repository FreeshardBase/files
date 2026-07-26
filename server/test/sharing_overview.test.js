const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

describe('File Details & Sharing Overview (#52)', () => {
  const owner = { id: 'user_details_owner', username: 'details_owner', displayName: 'Owner User' };
  const sharee = { id: 'user_details_sharee', username: 'details_sharee', displayName: 'Sharee User' };
  const filePath = '/Documents/secret_plan.pdf';

  before(async () => {
    await db.initDb();
    await db.run('DELETE FROM file_shares WHERE owner_user_id = ?', [owner.id]);
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [owner.id]);
    await db.upsertUser(owner.id, owner.username, 'owner@example.com', 'local', null, owner.displayName);
    await db.upsertUser(sharee.id, sharee.username, 'sharee@example.com', 'local', null, sharee.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM file_shares WHERE owner_user_id = ?', [owner.id]);
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [owner.id]);
    await db.run('DELETE FROM users WHERE id IN (?, ?)', [owner.id, sharee.id]);
  });

  test('retrieves active internal and public shares for specific file path', async () => {
    // 1. Create internal share
    await db.createFileShare(owner.id, sharee.id, filePath, 'local', 0, 1);

    // 2. Create public share link
    await db.createPublicShare(owner.id, 'tok_details_123', filePath, 0, null, '2026-12-31', 10);

    // 3. Query DB helpers
    const internalShares = await db.getFileSharesByPath(owner.id, filePath);
    const publicShares = await db.getPublicSharesByPath(owner.id, filePath);

    assert.equal(internalShares.length, 1);
    assert.equal(internalShares[0].sharee_username, sharee.username);
    assert.equal(internalShares[0].read_write, 1);

    assert.equal(publicShares.length, 1);
    assert.equal(publicShares[0].token, 'tok_details_123');
    assert.equal(publicShares[0].max_downloads, 10);
  });
});
