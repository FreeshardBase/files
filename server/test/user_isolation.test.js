const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');

const testDbPath = path.join(__dirname, 'test_isolation.db');
process.env.DATABASE_PATH = testDbPath;
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ISOLATION_TEST_ROOT = path.join(__dirname, 'test_isolation_users');
process.env.FILES_ROOT = ISOLATION_TEST_ROOT;

const db = require('../db');
const LocalProvider = require('../providers/local');
const { ensureUserHome, getUserStorageUsage } = require('../middleware/isolation');

describe('User Isolation & Quota Enforcement (#13)', () => {
  before(async () => {
    await db.closeDb();
    if (await fs.stat(testDbPath).catch(() => false)) await fs.unlink(testDbPath);
    await db.initDb();
    await fs.mkdir(ISOLATION_TEST_ROOT, { recursive: true });
  });

  after(async () => {
    await db.closeDb();
    if (await fs.stat(testDbPath).catch(() => false)) await fs.unlink(testDbPath);
    try { await fs.rm(ISOLATION_TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('auto-provisions isolated user home directories', async () => {
    const userARoot = path.join(ISOLATION_TEST_ROOT, 'user-a');
    const userBRoot = path.join(ISOLATION_TEST_ROOT, 'user-b');

    await ensureUserHome(userARoot);
    await ensureUserHome(userBRoot);

    const statA = await fs.stat(path.join(userARoot, 'Documents'));
    const statB = await fs.stat(path.join(userBRoot, 'Documents'));

    assert.ok(statA.isDirectory());
    assert.ok(statB.isDirectory());
  });

  test('prevents User A from accessing User B files via LocalProvider', async () => {
    const userARoot = path.join(ISOLATION_TEST_ROOT, 'user-a');
    const userBRoot = path.join(ISOLATION_TEST_ROOT, 'user-b');

    const providerA = new LocalProvider({ userRoot: userARoot });
    const providerB = new LocalProvider({ userRoot: userBRoot });

    // User B writes a file
    const streamB = Readable.from([Buffer.from('User B private data')]);
    await providerB.write('/Documents/secret.txt', streamB);

    // User A attempts to list or read outside root
    await assert.rejects(async () => {
      await providerA.read('../user-b/Documents/secret.txt');
    }, /path escapes user root/);
  });

  test('calculates user storage usage accurately', async () => {
    const userARoot = path.join(ISOLATION_TEST_ROOT, 'user-a');
    const providerA = new LocalProvider({ userRoot: userARoot });

    const content = '12345678901234567890'; // 20 bytes
    await providerA.write('/Documents/file20.txt', Readable.from([Buffer.from(content)]));

    const usage = await getUserStorageUsage(userARoot);
    assert.ok(usage >= 20);
  });

  test('persists quota_bytes in database for user', async () => {
    const userId = 'usr-quota-test';
    const quota10MB = 10 * 1024 * 1024;
    const user = await db.upsertUser(userId, 'quotauser', 'quota@example.com', 'oidc', quota10MB);

    assert.equal(user.quota_bytes, quota10MB);
  });
});
