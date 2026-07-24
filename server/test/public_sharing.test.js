const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const bcrypt = require('bcryptjs');
const db = require('../db');

describe('Public Link Sharing (#15, #45 Invariant)', () => {
  const user = { id: 'user_public_owner_1', username: 'charlie', displayName: 'Charlie' };

  before(async () => {
    await db.initDb();
    await db.upsertUser(user.id, user.username, 'charlie@example.com', 'local', null, user.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM public_shares');
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  });

  test('creates a public share link with token and options', async () => {
    const token = 'token_test_123456';
    const share = await db.createPublicShare(user.id, token, '/Documents/PublicDoc.pdf', 0, null, null, 5);

    assert.ok(share.id);
    assert.equal(share.token, token);
    assert.equal(share.max_downloads, 5);
    assert.equal(share.download_count, 0);

    const fetched = await db.getPublicShareByToken(token);
    assert.equal(fetched.file_path, '/Documents/PublicDoc.pdf');
    assert.equal(fetched.owner_username, 'charlie');
  });

  test('verifies password-protected public share link', async () => {
    const token = 'token_pwd_789';
    const plainPwd = 'SecretPassword123';
    const hashed = await bcrypt.hash(plainPwd, 10);

    await db.createPublicShare(user.id, token, '/Pictures/PrivatePhoto.jpg', 0, hashed, null, null);

    const share = await db.getPublicShareByToken(token);
    assert.ok(share.password_hash);

    const validMatch = await bcrypt.compare(plainPwd, share.password_hash);
    const invalidMatch = await bcrypt.compare('WrongPassword', share.password_hash);

    assert.equal(validMatch, true);
    assert.equal(invalidMatch, false);
  });

  test('increments download count correctly', async () => {
    const token = 'token_counter_abc';
    const share = await db.createPublicShare(user.id, token, '/Documents/CountTest.txt', 0, null, null, 2);

    await db.incrementPublicShareDownloads(share.id);
    const updated = await db.getPublicShareByToken(token);

    assert.equal(updated.download_count, 1);
  });

  test('preserves public share links on file/folder move (path cascading invariant #15, #45)', async () => {
    const token = 'token_move_xyz';
    const share = await db.createPublicShare(user.id, token, '/Documents/OldFile.txt', 0, null, null, null);

    // Move /Documents/OldFile.txt -> /Documents/NewFile.txt
    await db.updateSharePathsOnMove(user.id, '/Documents/OldFile.txt', '/Documents/NewFile.txt');

    const updated = await db.getPublicShareByToken(token);
    assert.equal(updated.file_path, '/Documents/NewFile.txt');
  });

  test('revokes a public share link', async () => {
    const token = 'token_delete_999';
    const share = await db.createPublicShare(user.id, token, '/Temp/delete_me.txt', 0, null, null, null);

    const deleted = await db.deletePublicShare(share.id, user.id);
    assert.equal(deleted, true);

    const fetched = await db.getPublicShareByToken(token);
    assert.equal(fetched, undefined);
  });
});
