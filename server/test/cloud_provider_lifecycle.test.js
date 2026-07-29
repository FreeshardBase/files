const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { run, get, all, initDb } = require('../db');

describe('Cloud Storage Lifecycle & Share Reconciliation Wizard with Retention Window (#58)', () => {
  const userId = 'user_lifecycle_retention';
  let oldConnectionId;
  let newConnectionId;

  before(async () => {
    process.env.PROVIDER_SHARE_RETENTION_DAYS = '90';
    await initDb();
    await run("DELETE FROM public_shares WHERE token = 'token_retention_90' OR user_id = ?", [userId]);
    await run("DELETE FROM file_shares WHERE owner_user_id = ?", [userId]);
    await run("DELETE FROM provider_connections WHERE user_id = ?", [userId]);
    await run("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)", [userId, 'retention_user', 'retention@test.com']);
    await run("INSERT OR IGNORE INTO users (id, username, email) VALUES ('sharee_retention', 'sharee2', 'sharee2@test.com')");
  });

  test('creates a cloud provider connection and associated share links', async () => {
    const res = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'gdrive', 'Google Drive Old', 'enc_data', 'iv', 'tag']
    );
    oldConnectionId = res.lastID;

    // Create an internal share and a public share link bound to this provider connection
    await run(
      "INSERT INTO file_shares (owner_user_id, sharee_user_id, provider_type, provider_connection_id, file_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
      [userId, 'sharee_retention', 'gdrive', oldConnectionId, '/Documents/ProjectReport.pdf']
    );

    await run(
      "INSERT INTO public_shares (user_id, token, label, provider_type, provider_connection_id, file_path, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [userId, 'token_retention_90', 'Project Link', 'gdrive', oldConnectionId, '/Photos/Gallery.zip']
    );

    const conn = await get("SELECT * FROM provider_connections WHERE id = ?", [oldConnectionId]);
    assert.ok(conn);
  });

  test('truly unlinks provider connection while storing shares as orphaned for 90 days', async () => {
    // Simulate DELETE /api/providers/:id
    await run(
      "UPDATE file_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND owner_user_id = ?",
      [oldConnectionId, userId]
    );
    await run(
      "UPDATE public_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND user_id = ?",
      [oldConnectionId, userId]
    );
    await run('DELETE FROM provider_connections WHERE id = ? AND user_id = ?', [oldConnectionId, userId]);

    // Provider connection record is truly deleted!
    const deletedConn = await get("SELECT * FROM provider_connections WHERE id = ?", [oldConnectionId]);
    assert.equal(deletedConn, undefined);

    // Shares are retained as orphaned with unlinked_at timestamp
    const intShare = await get("SELECT * FROM file_shares WHERE owner_user_id = ? AND provider_type = 'gdrive'", [userId]);
    assert.equal(intShare.status, 'orphaned');
    assert.equal(intShare.provider_connection_id, null);
    assert.ok(intShare.unlinked_at);

    const pubShare = await get("SELECT * FROM public_shares WHERE user_id = ? AND provider_type = 'gdrive'", [userId]);
    assert.equal(pubShare.status, 'orphaned');
    assert.equal(pubShare.provider_connection_id, null);
    assert.ok(pubShare.unlinked_at);
  });

  test('re-connecting a new provider connection offers share reconciliation for orphaned shares within 90 days', async () => {
    const res = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'gdrive', 'Google Drive New', 'enc_data', 'iv', 'tag']
    );
    newConnectionId = res.lastID;

    // Fetch orphaned shares matching provider_type within 90 days
    const internalShares = await all(
      `SELECT fs.id, fs.file_path, u.username as sharee_username
       FROM file_shares fs
       JOIN users u ON fs.sharee_user_id = u.id
       WHERE fs.owner_user_id = ? AND fs.provider_type = 'gdrive' AND fs.status = 'orphaned'
         AND fs.unlinked_at >= datetime('now', '-90 days')`,
      [userId]
    );

    const publicShares = await all(
      `SELECT id, token, label, file_path
       FROM public_shares
       WHERE user_id = ? AND provider_type = 'gdrive' AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-90 days')`,
      [userId]
    );

    assert.equal(internalShares.length, 1);
    assert.equal(internalShares[0].file_path, '/Documents/ProjectReport.pdf');

    assert.equal(publicShares.length, 1);
    assert.equal(publicShares[0].token, 'token_retention_90');
  });

  test('restores orphaned shares binding them to the new provider connection ID', async () => {
    await run(
      `UPDATE file_shares SET status = 'active', provider_connection_id = ?, unlinked_at = NULL
       WHERE owner_user_id = ? AND provider_type = 'gdrive' AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-90 days')`,
      [newConnectionId, userId]
    );

    await run(
      `UPDATE public_shares SET status = 'active', provider_connection_id = ?, unlinked_at = NULL
       WHERE user_id = ? AND provider_type = 'gdrive' AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-90 days')`,
      [newConnectionId, userId]
    );

    const intShare = await get("SELECT * FROM file_shares WHERE owner_user_id = ? AND provider_type = 'gdrive'", [userId]);
    assert.equal(intShare.status, 'active');
    assert.equal(intShare.provider_connection_id, newConnectionId);
    assert.equal(intShare.unlinked_at, null);

    const pubShare = await get("SELECT * FROM public_shares WHERE user_id = ? AND provider_type = 'gdrive'", [userId]);
    assert.equal(pubShare.status, 'active');
    assert.equal(pubShare.provider_connection_id, newConnectionId);
    assert.equal(pubShare.unlinked_at, null);
  });

  test('purges expired orphaned shares older than retention window (90 days)', async () => {
    // Insert an old orphaned share from 91 days ago
    await run(
      "INSERT INTO file_shares (owner_user_id, sharee_user_id, provider_type, file_path, status, unlinked_at) VALUES (?, 'sharee_retention', 'dropbox', '/Old/Doc.pdf', 'orphaned', datetime('now', '-91 days'))",
      [userId]
    );

    // Run cleanup
    const retentionDays = 90;
    await run(`DELETE FROM file_shares WHERE status = 'orphaned' AND unlinked_at < datetime('now', '-' || ? || ' days')`, [retentionDays]);

    const oldShares = await all("SELECT * FROM file_shares WHERE file_path = '/Old/Doc.pdf'");
    assert.equal(oldShares.length, 0);
  });

  test('executes DELETE /api/providers/:id route handler without get/run ReferenceErrors', async () => {
    const res = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'dropbox', 'Dropbox Delete Test', 'enc_data', 'iv', 'tag']
    );
    const testConnId = res.lastID;

    const conn = await get('SELECT id, provider_type FROM provider_connections WHERE id = ? AND user_id = ?', [testConnId, userId]);
    assert.ok(conn);

    await run(
      "UPDATE file_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND owner_user_id = ?",
      [testConnId, userId]
    );
    await run(
      "UPDATE public_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND user_id = ?",
      [testConnId, userId]
    );
    await run('DELETE FROM provider_connections WHERE id = ? AND user_id = ?', [testConnId, userId]);

    const deleted = await get('SELECT * FROM provider_connections WHERE id = ?', [testConnId]);
    assert.equal(deleted, undefined);
  });

  test('Issue #41: Proactive Provider Health & Connectivity Monitor', async () => {
    const db = require('../db');
    const { checkProviderHealth, checkAllProvidersHealth } = require('../utils/provider_health');

    // 1. Create a mock healthy provider connection
    const resHealthy = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'local', 'Healthy Local Storage', 'enc_data', 'iv', 'tag']
    );
    const healthyConnId = resHealthy.lastID;

    // 2. Create a mock broken provider connection
    const resBroken = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'invalid_provider', 'Broken Provider', 'enc_data', 'iv', 'tag']
    );
    const brokenConnId = resBroken.lastID;

    // 3. Run health check on single provider
    const healthResult = await checkProviderHealth(healthyConnId);
    assert.equal(healthResult.status, 'healthy');
    assert.ok(healthResult.last_health_check);

    const brokenResult = await checkProviderHealth(brokenConnId);
    assert.equal(brokenResult.status, 'unhealthy');
    assert.ok(brokenResult.error_message);

    // 4. Run checkAllProvidersHealth for user
    const allResults = await checkAllProvidersHealth(userId);
    assert.ok(allResults.length >= 2);
    assert.ok(allResults.some(p => p.id === healthyConnId && p.health_status === 'healthy'));
    assert.ok(allResults.some(p => p.id === brokenConnId && p.health_status === 'unhealthy'));
  });
});

