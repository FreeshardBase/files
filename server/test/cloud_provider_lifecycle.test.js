const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { run, get, all, initDb } = require('../db');

describe('Cloud Storage Lifecycle & Share Reconciliation Wizard (#58)', () => {
  const userId = 'test_user_lifecycle';
  let connectionId;

  before(async () => {
    await initDb();
    await run("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)", [userId, 'lifecycle_user', 'lifecycle@test.com']);
    await run("INSERT OR IGNORE INTO users (id, username, email) VALUES ('sharee_user', 'sharee', 'sharee@test.com')");
  });

  test('creates a test cloud provider connection and associated share links', async () => {
    const res = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'gdrive', 'Google Drive Work', 'enc_data', 'iv', 'tag']
    );
    connectionId = res.lastID;

    // Create an internal share and a public share link bound to this provider connection
    await run(
      "INSERT INTO file_shares (owner_user_id, sharee_user_id, provider_type, provider_connection_id, file_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
      [userId, 'sharee_user', 'gdrive', connectionId, '/Documents/Report.pdf']
    );

    await run(
      "INSERT INTO public_shares (user_id, token, label, provider_type, provider_connection_id, file_path, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [userId, 'token_lifecycle_123', 'Work Link', 'gdrive', connectionId, '/Photos/Vacation.jpg']
    );

    const conn = await get("SELECT * FROM provider_connections WHERE id = ?", [connectionId]);
    assert.equal(conn.enabled, 1);
  });

  test('soft disconnects provider and suspends associated share links', async () => {
    await run('UPDATE provider_connections SET enabled = 0 WHERE id = ? AND user_id = ?', [connectionId, userId]);
    await run("UPDATE file_shares SET status = 'suspended' WHERE provider_connection_id = ? AND owner_user_id = ?", [connectionId, userId]);
    await run("UPDATE public_shares SET status = 'suspended' WHERE provider_connection_id = ? AND user_id = ?", [connectionId, userId]);

    const conn = await get("SELECT enabled FROM provider_connections WHERE id = ?", [connectionId]);
    assert.equal(conn.enabled, 0);

    const intShare = await get("SELECT status FROM file_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(intShare.status, 'suspended');

    const pubShare = await get("SELECT status FROM public_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(pubShare.status, 'suspended');
  });

  test('re-enables provider and identifies suspended shares requiring reconciliation', async () => {
    await run('UPDATE provider_connections SET enabled = 1 WHERE id = ? AND user_id = ?', [connectionId, userId]);

    const internalRes = await get("SELECT count(*) as count FROM file_shares WHERE provider_connection_id = ? AND status = 'suspended'", [connectionId]);
    const publicRes = await get("SELECT count(*) as count FROM public_shares WHERE provider_connection_id = ? AND status = 'suspended'", [connectionId]);

    const suspendedCount = (internalRes?.count || 0) + (publicRes?.count || 0);
    assert.equal(suspendedCount, 2);
  });

  test('retrieves suspended shares for reconciliation wizard', async () => {
    const internalShares = await all(
      `SELECT fs.id, fs.file_path, u.username as sharee_username
       FROM file_shares fs
       JOIN users u ON fs.sharee_user_id = u.id
       WHERE fs.provider_connection_id = ? AND fs.owner_user_id = ? AND fs.status = 'suspended'`,
      [connectionId, userId]
    );

    const publicShares = await all(
      `SELECT id, token, label, file_path
       FROM public_shares
       WHERE provider_connection_id = ? AND user_id = ? AND status = 'suspended'`,
      [connectionId, userId]
    );

    assert.equal(internalShares.length, 1);
    assert.equal(internalShares[0].file_path, '/Documents/Report.pdf');
    assert.equal(publicShares.length, 1);
    assert.equal(publicShares[0].token, 'token_lifecycle_123');
  });

  test('reconciles and restores all suspended share links', async () => {
    await run("UPDATE file_shares SET status = 'active' WHERE provider_connection_id = ? AND owner_user_id = ?", [connectionId, userId]);
    await run("UPDATE public_shares SET status = 'active' WHERE provider_connection_id = ? AND user_id = ?", [connectionId, userId]);

    const intShare = await get("SELECT status FROM file_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(intShare.status, 'active');

    const pubShare = await get("SELECT status FROM public_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(pubShare.status, 'active');
  });

  test('discards suspended share links upon user request', async () => {
    // Suspend again
    await run("UPDATE file_shares SET status = 'suspended' WHERE provider_connection_id = ?", [connectionId]);
    await run("UPDATE public_shares SET status = 'suspended' WHERE provider_connection_id = ?", [connectionId]);

    // Discard action
    await run("DELETE FROM file_shares WHERE provider_connection_id = ? AND owner_user_id = ? AND status = 'suspended'", [connectionId, userId]);
    await run("DELETE FROM public_shares WHERE provider_connection_id = ? AND user_id = ? AND status = 'suspended'", [connectionId, userId]);

    const intShares = await all("SELECT * FROM file_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(intShares.length, 0);

    const pubShares = await all("SELECT * FROM public_shares WHERE provider_connection_id = ?", [connectionId]);
    assert.equal(pubShares.length, 0);
  });

  test('permanently deletes provider connection', async () => {
    await run('DELETE FROM provider_connections WHERE id = ? AND user_id = ?', [connectionId, userId]);

    const conn = await get("SELECT * FROM provider_connections WHERE id = ?", [connectionId]);
    assert.equal(conn, undefined);
  });
});
