const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const db = require('../db');

describe('Trash & Soft-Delete System (#18)', () => {
  const user = { id: 'user_trash_1', username: 'trash_user', displayName: 'Trash User' };

  before(async () => {
    await db.initDb();
    await db.upsertUser(user.id, user.username, 'trash@example.com', 'local', null, user.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM trash_items WHERE user_id = ?', [user.id]);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  });

  test('creates a trash item with 30-day default expiration', async () => {
    const trashId = 'trash_uuid_101';
    const item = await db.createTrashItem(trashId, user.id, '/Documents/Report.docx', 'Report.docx', 0, 45000, 30);

    assert.ok(item.id);
    assert.equal(item.original_name, 'Report.docx');
    assert.equal(item.size_bytes, 45000);
    assert.ok(item.expires_at);

    const items = await db.getTrashItemsByUser(user.id);
    assert.ok(items.length >= 1);
    const match = items.find(i => i.id === trashId);
    assert.ok(match);
  });

  test('retrieves single trash item by ID', async () => {
    const trashId = 'trash_uuid_102';
    await db.createTrashItem(trashId, user.id, '/Pictures/Photo.png', 'Photo.png', 0, 120000, 30);

    const item = await db.getTrashItemById(trashId, user.id);
    assert.ok(item);
    assert.equal(item.original_name, 'Photo.png');
  });

  test('deletes single trash item permanently', async () => {
    const trashId = 'trash_uuid_103';
    await db.createTrashItem(trashId, user.id, '/Temp/file.tmp', 'file.tmp', 0, 500, 30);

    const deleted = await db.deleteTrashItem(trashId, user.id);
    assert.equal(deleted, true);

    const item = await db.getTrashItemById(trashId, user.id);
    assert.equal(item, undefined);
  });

  test('empties all trash items for user', async () => {
    await db.createTrashItem('t_item_1', user.id, '/f1.txt', 'f1.txt', 0, 10, 30);
    await db.createTrashItem('t_item_2', user.id, '/f2.txt', 'f2.txt', 0, 20, 30);

    const emptied = await db.emptyTrash(user.id);
    assert.ok(emptied.length >= 2);

    const remaining = await db.getTrashItemsByUser(user.id);
    assert.equal(remaining.length, 0);
  });

  test('cleans up expired trash items automatically', async () => {
    // Insert an item with expiration in the past
    await db.run(`
      INSERT INTO trash_items (id, user_id, original_path, original_name, is_directory, size_bytes, expires_at)
      VALUES ('expired_item_999', ?, '/old.txt', 'old.txt', 0, 100, datetime('now', '-1 day'))
    `, [user.id]);

    const expired = await db.cleanupExpiredTrashItems();
    assert.ok(expired.length >= 1);
    const match = expired.find(i => i.id === 'expired_item_999');
    assert.ok(match);

    const remaining = await db.getTrashItemById('expired_item_999', user.id);
    assert.equal(remaining, undefined);
  });
});
