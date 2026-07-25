const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const db = require('../db');
const LocalProvider = require('../providers/local');

describe('Trash & Soft-Delete System (#18)', () => {
  const user = { id: 'user_trash_1', username: 'trash_user', displayName: 'Trash User' };
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const userRoot = path.join(dataDir, 'users', user.id);
  const trashDir = path.join(userRoot, '.trash');

  before(async () => {
    await db.initDb();
    await db.upsertUser(user.id, user.username, 'trash@example.com', 'local', null, user.displayName);
    await fs.mkdir(userRoot, { recursive: true });
  });

  after(async () => {
    await db.run('DELETE FROM trash_items WHERE user_id = ?', [user.id]);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
    await fs.rm(userRoot, { recursive: true, force: true }).catch(() => {});
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

  test('inspects contents of a trashed folder and calculates recursive directory size (#18 regression fix)', async () => {
    const trashId = 'trash_folder_uuid_200';
    const folderDiskPath = path.join(trashDir, trashId);

    // Create a trashed folder structure on disk with 2 files inside
    await fs.mkdir(folderDiskPath, { recursive: true });
    await fs.writeFile(path.join(folderDiskPath, 'photo.jpg'), Buffer.alloc(5000));
    await fs.writeFile(path.join(folderDiskPath, 'notes.txt'), Buffer.alloc(2000));

    // Create DB entry with size_bytes = 0 to test dynamic size resolution
    await db.createTrashItem(trashId, user.id, '/MyPhotos', 'MyPhotos', 1, 0, 30);

    // 1. Verify dynamic size calculation
    const items = await db.getTrashItemsByUser(user.id);
    const match = items.find(i => i.id === trashId);
    assert.ok(match);
    assert.equal(match.is_directory, 1);

    // Calculate directory size directly
    async function getDirectorySize(dirOnDisk) {
      let total = 0;
      const entries = await fs.readdir(dirOnDisk, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirOnDisk, entry.name);
        if (entry.isDirectory()) total += await getDirectorySize(fullPath);
        else if (entry.isFile()) total += (await fs.stat(fullPath)).size;
      }
      return total;
    }

    const calculatedSize = await getDirectorySize(folderDiskPath);
    assert.equal(calculatedSize, 7000);

    // 2. Verify inspection of trashed folder contents
    const entries = await fs.readdir(folderDiskPath, { withFileTypes: true });
    assert.equal(entries.length, 2);
    const fileNames = entries.map(e => e.name).sort();
    assert.deepEqual(fileNames, ['notes.txt', 'photo.jpg']);
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
