const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Set test environment variables BEFORE db module load
const testDbPath = path.join(__dirname, 'test_files.db');
process.env.DATABASE_PATH = testDbPath;
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const db = require('../db');

describe('SQLite Schema & Encryption Integration (#3)', () => {
  before(async () => {
    await db.closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    await db.initDb();
  });

  after(async () => {
    await db.closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    const walFile = testDbPath + '-wal';
    const shmFile = testDbPath + '-shm';
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  });

  test('initializes all tables and WAL mode', async () => {
    const journalMode = await db.get('PRAGMA journal_mode;');
    assert.equal(journalMode.journal_mode.toLowerCase(), 'wal');

    const busyTimeout = await db.get('PRAGMA busy_timeout;');
    assert.equal(busyTimeout.timeout, 5000);
  });

  test('upsertUser creates new user and updates existing user', async () => {
    const userId = 'usr-12345';
    const user1 = await db.upsertUser(userId, 'testuser', 'test@example.com', 'oidc');

    assert.equal(user1.id, userId);
    assert.equal(user1.username, 'testuser');
    assert.equal(user1.email, 'test@example.com');

    // Update user
    const user2 = await db.upsertUser(userId, 'testuser_updated', 'new@example.com', 'oidc');
    assert.equal(user2.id, userId);
    assert.equal(user2.username, 'testuser_updated');
    assert.equal(user2.email, 'new@example.com');
  });

  test('addProviderConnection encrypts credentials and getProviderConnections decrypts them', async () => {
    const userId = 'usr-12345';
    const rawCredentials = {
      client_id: 'gdrive-client-id',
      client_secret: 'super-secret-gdrive-key',
      refresh_token: '1//0g-refresh-token'
    };

    const connectionId = await db.addProviderConnection(
      userId,
      'googledrive',
      'My Google Drive',
      rawCredentials,
      'twoway'
    );

    assert.ok(connectionId > 0);

    // Verify row in DB contains ciphertext, NOT raw credentials
    const rawRow = await db.get('SELECT * FROM provider_connections WHERE id = ?', [connectionId]);
    assert.ok(rawRow.credentials_encrypted);
    assert.ok(!rawRow.credentials_encrypted.includes('super-secret-gdrive-key'));

    // Retrieve via helper and verify decrypted credentials match original
    const connections = await db.getProviderConnections(userId);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].provider_type, 'googledrive');
    assert.deepEqual(connections[0].credentials, rawCredentials);
  });
});
