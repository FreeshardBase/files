const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

test.describe('Click Navigation Mode Preference (#68)', () => {
  test.beforeEach(async () => {
    process.env.DATABASE_PATH = ':memory:';
    await db.initDb();
  });

  test.afterEach(async () => {
    await db.closeDb();
  });

  test('migrates users table and defaults preferred_click_mode to double', async () => {
    const user = await db.getUserById('default-user');
    assert.ok(user, 'Default user should exist');
    assert.equal(user.preferred_click_mode || 'double', 'double');
  });

  test('updates preferred_click_mode to single and retrieves updated preference', async () => {
    await db.updateUserClickMode('default-user', 'single');
    const user = await db.getUserById('default-user');
    assert.equal(user.preferred_click_mode, 'single');
  });

  test('rejects invalid preferred_click_mode values', async () => {
    await assert.rejects(
      async () => {
        await db.updateUserClickMode('default-user', 'triple');
      },
      /Invalid click mode/
    );
  });
});
