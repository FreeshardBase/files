const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');

const testDbPath = path.join(__dirname, 'test_auth.db');
process.env.DATABASE_PATH = testDbPath;
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.FILES_ROOT = path.join(__dirname, 'test_auth_users');

const db = require('../db');
const bcrypt = require('bcryptjs');
const { ensureUserHome } = require('../middleware/isolation');

describe('Authentication & App Passwords (#2)', () => {
  before(async () => {
    await db.closeDb();
    if (await fs.stat(testDbPath).catch(() => false)) await fs.unlink(testDbPath);
    await db.initDb();
  });

  after(async () => {
    await db.closeDb();
    if (await fs.stat(testDbPath).catch(() => false)) await fs.unlink(testDbPath);
    try { await fs.rm(process.env.FILES_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('local registration and login flow', async () => {
    const userId = 'usr-auth-test';
    const password = 'SecretPassword123!';
    const hash = await bcrypt.hash(password, 10);

    // Register user
    const user = await db.upsertUser(userId, 'john_doe', 'john@example.com', 'local');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

    assert.equal(user.username, 'john_doe');

    // Verify password match
    const fetched = await db.get('SELECT * FROM users WHERE username = ?', ['john_doe']);
    const match = await bcrypt.compare(password, fetched.password_hash);
    assert.ok(match);
  });

  test('executes OIDC callback user provisioning & path joining cleanly', async () => {
    const userId = '317b500d-c0d1-402b-a6a2-73e0d8102a7e';
    const username = 'oidc_user_test';
    const email = 'user@gryzia.de';

    // JIT User Provisioning in SQLite DB
    const user = await db.upsertUser(userId, username, email, 'oidc');
    assert.equal(user.id, userId);

    // Auto-provision user home directory structure with path.join
    const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
    const userHomePath = path.join(rootBase, userId);
    await ensureUserHome(userHomePath);

    const docStat = await fs.stat(path.join(userHomePath, 'Documents'));
    assert.ok(docStat.isDirectory());
  });

  test('creates, lists, and deletes App-Specific Passwords (ASPs)', async () => {
    const userId = 'usr-auth-test';
    const label = 'WebDAV Desktop Client';
    const plainAsp = 'fs_asp_1234567890abcdef';
    const hash = await bcrypt.hash(plainAsp, 10);

    // Insert ASP
    const res = await db.run(
      'INSERT INTO app_passwords (user_id, label, password_hash) VALUES (?, ?, ?)',
      [userId, label, hash]
    );
    assert.ok(res.lastID > 0);

    // List ASPs
    const asps = await db.all(
      'SELECT id, label, created_at FROM app_passwords WHERE user_id = ?',
      [userId]
    );
    assert.equal(asps.length, 1);
    assert.equal(asps[0].label, label);

    // Validate ASP matching
    const aspRow = await db.get('SELECT password_hash FROM app_passwords WHERE id = ?', [res.lastID]);
    const isValid = await bcrypt.compare(plainAsp, aspRow.password_hash);
    assert.ok(isValid);

    // Delete ASP
    await db.run('DELETE FROM app_passwords WHERE id = ? AND user_id = ?', [res.lastID, userId]);
    const afterDelete = await db.all('SELECT * FROM app_passwords WHERE user_id = ?', [userId]);
    assert.equal(afterDelete.length, 0);
  });
});
