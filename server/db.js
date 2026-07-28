const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { encrypt, decrypt } = require('./utils/crypto');

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'files.db');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    dbInstance = new sqlite3.Database(dbPath);
  }
  return dbInstance;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function closeDb() {
  return new Promise((resolve, reject) => {
    if (!dbInstance) return resolve();
    dbInstance.close((err) => {
      dbInstance = null;
      if (err) reject(err);
      else resolve();
    });
  });
}

async function initDb() {
  // Enforce WAL mode and busy timeout (Risk 1 in Architecture Guide #24)
  await run('PRAGMA journal_mode = WAL;');
  await run('PRAGMA busy_timeout = 5000;');
  await run('PRAGMA foreign_keys = ON;');

  // Core Users table (#3, #13, #25, #48)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT,
      password_hash TEXT,
      auth_type TEXT DEFAULT 'oidc',
      preferred_locale TEXT DEFAULT NULL,
      quota_bytes INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrations for existing databases
  const columns = await all("PRAGMA table_info(users);");
  const hasQuota = columns.some(c => c.name === 'quota_bytes');
  if (!hasQuota) {
    try { await run("ALTER TABLE users ADD COLUMN quota_bytes INTEGER DEFAULT NULL;"); } catch (e) {}
  }
  const hasDisplayName = columns.some(c => c.name === 'display_name');
  if (!hasDisplayName) {
    try { await run("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL;"); } catch (e) {}
  }
  const hasViewMode = columns.some(c => c.name === 'preferred_view_mode');
  if (!hasViewMode) {
    try { await run("ALTER TABLE users ADD COLUMN preferred_view_mode TEXT DEFAULT 'grid';"); } catch (e) {}
  }
  const hasClickMode = columns.some(c => c.name === 'preferred_click_mode');
  if (!hasClickMode) {
    try { await run("ALTER TABLE users ADD COLUMN preferred_click_mode TEXT DEFAULT 'double';"); } catch (e) {}
  }

  // App Passwords table (#2, #3, #21)
  await run(`
    CREATE TABLE IF NOT EXISTS app_passwords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Provider Connections table (#3, #5-#9)
  await run(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      credentials_encrypted TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      sync_mode TEXT DEFAULT 'remote',
      sync_folder TEXT,
      root_path TEXT DEFAULT '/',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Internal File Shares (#3, #14)
  await run(`
    CREATE TABLE IF NOT EXISTS file_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sharee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL DEFAULT 'local',
      provider_connection_id INTEGER REFERENCES provider_connections(id),
      file_path TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      read_write INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      unlinked_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Public Share Links (#3, #15, #53)
  await run(`
    CREATE TABLE IF NOT EXISTS public_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT NULL,
      provider_type TEXT NOT NULL DEFAULT 'local',
      provider_connection_id INTEGER REFERENCES provider_connections(id),
      file_path TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      permission_mode TEXT DEFAULT 'read',
      password_hash TEXT,
      expires_at TEXT,
      max_downloads INTEGER,
      download_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      unlinked_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const fileSharesCols = await all("PRAGMA table_info(file_shares);");
  if (!fileSharesCols.some(c => c.name === 'status')) {
    try { await run("ALTER TABLE file_shares ADD COLUMN status TEXT DEFAULT 'active';"); } catch (e) {}
  }
  if (!fileSharesCols.some(c => c.name === 'unlinked_at')) {
    try { await run("ALTER TABLE file_shares ADD COLUMN unlinked_at TEXT DEFAULT NULL;"); } catch (e) {}
  }

  const publicColumns = await all("PRAGMA table_info(public_shares);");
  const hasLabel = publicColumns.some(c => c.name === 'label');
  if (!hasLabel) {
    try {
      await run("ALTER TABLE public_shares ADD COLUMN label TEXT DEFAULT NULL;");
    } catch (e) {
      if (!e.message.includes('duplicate column')) throw e;
    }
  }
  if (!publicColumns.some(c => c.name === 'status')) {
    try { await run("ALTER TABLE public_shares ADD COLUMN status TEXT DEFAULT 'active';"); } catch (e) {}
  }
  if (!publicColumns.some(c => c.name === 'unlinked_at')) {
    try { await run("ALTER TABLE public_shares ADD COLUMN unlinked_at TEXT DEFAULT NULL;"); } catch (e) {}
  }

  // Trash Items (#18)
  await run(`
    CREATE TABLE IF NOT EXISTS trash_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      deleted_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);

  // Activity Log (#22)
  await run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'local',
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Transversal Transfers (#26)
  await run(`
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      src_provider_type TEXT NOT NULL,
      src_provider_connection_id INTEGER REFERENCES provider_connections(id),
      src_path TEXT NOT NULL,
      dst_provider_type TEXT NOT NULL,
      dst_provider_connection_id INTEGER REFERENCES provider_connections(id),
      dst_path TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'copy',
      is_directory INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      total_bytes INTEGER DEFAULT 0,
      transferred_bytes INTEGER DEFAULT 0,
      total_files INTEGER DEFAULT 1,
      completed_files INTEGER DEFAULT 0,
      current_file TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    )
  `);

  // Notifications (#32)
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT,
      read_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Audit Log (#44)
  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      user_agent TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Ecosystem Ingest Log (#62 — Paperless-ngx & Immich)
  await run(`
    CREATE TABLE IF NOT EXISTS ecosystem_ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      remote_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Sync Jobs (#71 — Automated File Synchronization Engine)
  await run(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_connection_id INTEGER REFERENCES provider_connections(id),
      local_path TEXT NOT NULL,
      remote_path TEXT NOT NULL,
      sync_mode TEXT DEFAULT 'two_way',
      conflict_strategy TEXT DEFAULT 'newer_wins',
      status TEXT DEFAULT 'pending',
      last_synced_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // User Webhooks (#72 — Webhook Event Dispatcher for Real-Time Change Notifications)
  await run(`
    CREATE TABLE IF NOT EXISTS user_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT DEFAULT '["file_created","file_deleted","share_revoked"]',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // FTS5 Full-Text Search (#74 — Full-Text Search Indexing with SQLite FTS5)
  await run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      user_id UNINDEXED,
      path,
      filename,
      content,
      updated_at UNINDEXED
    )
  `);

  // Ensure fallback default-user exists for unauthenticated operations (#44)
  await upsertUser('default-user', 'Default User', 'default@freeshard.local');
}

// ── CRUD Helpers ─────────────────────────────────────────────────────────────

async function upsertUser(id, username, email = null, authType = 'oidc', quotaBytes = null, displayName = null) {
  await run(`
    INSERT INTO users (id, username, email, display_name, auth_type, quota_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      email = excluded.email,
      display_name = COALESCE(excluded.display_name, users.display_name),
      quota_bytes = excluded.quota_bytes,
      updated_at = datetime('now')
  `, [id, username, email, displayName, authType, quotaBytes]);
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

async function addProviderConnection(userId, providerType, displayName, credentialsObj, syncMode = 'remote') {
  const plaintext = JSON.stringify(credentialsObj);
  const { iv, authTag, data } = encrypt(plaintext);

  const res = await run(`
    INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, sync_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, providerType, displayName, data, iv, authTag, syncMode]);

  return res.lastID;
}

async function getProviderConnections(userId) {
  const rows = await all('SELECT * FROM provider_connections WHERE user_id = ? AND enabled = 1', [userId]);
  return rows.map(row => {
    const decryptedJson = decrypt({
      iv: row.iv,
      authTag: row.auth_tag,
      data: row.credentials_encrypted
    });
    return {
      ...row,
      credentials: JSON.parse(decryptedJson)
    };
  });
}

// ── Internal Sharing Helpers (#14) ───────────────────────────────────────────

async function createFileShare(ownerUserId, shareeUserId, filePath, providerType = 'local', isDirectory = 0, readWrite = 0, providerConnectionId = null) {
  const normConnId = providerConnectionId ? parseInt(providerConnectionId, 10) : null;
  const res = await run(`
    INSERT INTO file_shares (owner_user_id, sharee_user_id, provider_type, file_path, is_directory, read_write, provider_connection_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [ownerUserId, shareeUserId, providerType || 'local', filePath, isDirectory ? 1 : 0, readWrite ? 1 : 0, normConnId]);
  return get('SELECT * FROM file_shares WHERE id = ?', [res.lastID]);
}

async function getFileSharesByOwner(ownerUserId) {
  return all(`
    SELECT fs.*, u.username as sharee_username, u.display_name as sharee_display_name
    FROM file_shares fs
    JOIN users u ON fs.sharee_user_id = u.id
    WHERE fs.owner_user_id = ?
    ORDER BY fs.created_at DESC
  `, [ownerUserId]);
}

async function getFileSharesByPath(ownerUserId, filePath) {
  return all(`
    SELECT fs.*, u.username as sharee_username, u.display_name as sharee_display_name
    FROM file_shares fs
    JOIN users u ON fs.sharee_user_id = u.id
    WHERE fs.owner_user_id = ? AND fs.file_path = ?
    ORDER BY fs.created_at DESC
  `, [ownerUserId, filePath]);
}

async function getFileSharesForSharee(shareeUserId) {
  return all(`
    SELECT fs.*, u.username as owner_username, u.display_name as owner_display_name
    FROM file_shares fs
    JOIN users u ON fs.owner_user_id = u.id
    WHERE fs.sharee_user_id = ?
    ORDER BY fs.created_at DESC
  `, [shareeUserId]);
}

async function deleteFileShare(shareId, ownerUserId) {
  const res = await run('DELETE FROM file_shares WHERE id = ? AND owner_user_id = ?', [shareId, ownerUserId]);
  return res.changes > 0;
}

// ── Public Link Sharing Helpers (#15, #53) ───────────────────────────────────

async function createPublicShare(userId, token, filePath, isDirectory = 0, passwordHash = null, expiresAt = null, maxDownloads = null, label = null, providerType = 'local', providerConnectionId = null) {
  const normConnId = providerConnectionId ? parseInt(providerConnectionId, 10) : null;
  await run(`
    INSERT INTO public_shares (user_id, token, file_path, is_directory, password_hash, expires_at, max_downloads, label, provider_type, provider_connection_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, token, filePath, isDirectory ? 1 : 0, passwordHash, expiresAt, maxDownloads, label, providerType || 'local', normConnId]);
  return get('SELECT * FROM public_shares WHERE token = ?', [token]);
}

async function updatePublicShare(shareId, userId, { label, passwordHash, expiresAt, maxDownloads, clearPassword }) {
  const numericId = parseInt(shareId, 10);
  let sql = 'UPDATE public_shares SET ';
  const params = [];
  const updates = [];

  if (label !== undefined) {
    updates.push('label = ?');
    params.push(label);
  }
  if (clearPassword) {
    updates.push('password_hash = NULL');
  } else if (passwordHash !== undefined && passwordHash !== null) {
    updates.push('password_hash = ?');
    params.push(passwordHash);
  }
  if (expiresAt !== undefined) {
    updates.push('expires_at = ?');
    params.push(expiresAt);
  }
  if (maxDownloads !== undefined) {
    updates.push('max_downloads = ?');
    params.push(maxDownloads);
  }

  if (updates.length === 0) return get('SELECT * FROM public_shares WHERE id = ? AND user_id = ?', [numericId, userId]);

  sql += updates.join(', ') + ' WHERE id = ? AND user_id = ?';
  params.push(numericId, userId);

  await run(sql, params);
  return get('SELECT * FROM public_shares WHERE id = ? AND user_id = ?', [numericId, userId]);
}

async function getPublicShareByToken(token) {
  return get(`
    SELECT ps.*, u.username as owner_username, u.display_name as owner_display_name
    FROM public_shares ps
    JOIN users u ON ps.user_id = u.id
    WHERE ps.token = ?
  `, [token]);
}

async function getPublicSharesByUser(userId) {
  return all('SELECT * FROM public_shares WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getPublicSharesByPath(userId, filePath) {
  return all(`
    SELECT * FROM public_shares
    WHERE user_id = ? AND file_path = ?
    ORDER BY created_at DESC
  `, [userId, filePath]);
}

async function deletePublicShare(shareId, userId) {
  const res = await run('DELETE FROM public_shares WHERE id = ? AND user_id = ?', [shareId, userId]);
  return res.changes > 0;
}

async function incrementPublicShareDownloads(shareId) {
  await run('UPDATE public_shares SET download_count = download_count + 1 WHERE id = ?', [shareId]);
}

/**
 * Invariant: Atomic path update for file_shares & public_shares on rename/move (#14, #15, #45)
 */
async function updateSharePathsOnMove(userId, srcPath, dstPath) {
  // Single file move update
  await run(`UPDATE file_shares SET file_path = ? WHERE file_path = ? AND owner_user_id = ?`, [dstPath, srcPath, userId]);
  await run(`UPDATE public_shares SET file_path = ? WHERE file_path = ? AND user_id = ?`, [dstPath, srcPath, userId]);

  // Subfolder prefix cascading update
  const srcPrefix = srcPath.endsWith('/') ? srcPath : `${srcPath}/`;
  const dstPrefix = dstPath.endsWith('/') ? dstPath : `${dstPath}/`;

  await run(`
    UPDATE file_shares
    SET file_path = ? || SUBSTR(file_path, ?)
    WHERE file_path LIKE ? || '%' AND owner_user_id = ?
  `, [dstPrefix, srcPrefix.length + 1, srcPrefix, userId]);

  await run(`
    UPDATE public_shares
    SET file_path = ? || SUBSTR(file_path, ?)
    WHERE file_path LIKE ? || '%' AND user_id = ?
  `, [dstPrefix, srcPrefix.length + 1, srcPrefix, userId]);
}

// ── Trash & Soft-Delete Helpers (#18) ────────────────────────────────────────

async function createTrashItem(id, userId, originalPath, originalName, isDirectory = 0, sizeBytes = 0, retentionDays = 30) {
  await run(`
    INSERT INTO trash_items (id, user_id, original_path, original_name, is_directory, size_bytes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
  `, [id, userId, originalPath, originalName, isDirectory ? 1 : 0, sizeBytes, retentionDays]);
  return get('SELECT * FROM trash_items WHERE id = ?', [id]);
}

async function getTrashItemsByUser(userId) {
  return all('SELECT * FROM trash_items WHERE user_id = ? ORDER BY deleted_at DESC', [userId]);
}

async function getTrashItemById(id, userId) {
  return get('SELECT * FROM trash_items WHERE id = ? AND user_id = ?', [id, userId]);
}

async function deleteTrashItem(id, userId) {
  const res = await run('DELETE FROM trash_items WHERE id = ? AND user_id = ?', [id, userId]);
  return res.changes > 0;
}

async function emptyTrash(userId) {
  const items = await all('SELECT * FROM trash_items WHERE user_id = ?', [userId]);
  await run('DELETE FROM trash_items WHERE user_id = ?', [userId]);
  return items;
}

async function cleanupExpiredTrashItems() {
  const expiredItems = await all("SELECT * FROM trash_items WHERE expires_at <= datetime('now')");
  if (expiredItems.length > 0) {
    await run("DELETE FROM trash_items WHERE expires_at <= datetime('now')");
  }
  return expiredItems;
}

// ── Activity Log Helpers (#22) ───────────────────────────────────────────────

async function logActivity(userId, action, filePath, fileName, isDirectory = 0, details = null, providerType = 'local') {
  const res = await run(`
    INSERT INTO activity_log (user_id, action, provider_type, file_path, file_name, is_directory, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, action, providerType, filePath, fileName, isDirectory ? 1 : 0, details]);
  return get('SELECT * FROM activity_log WHERE id = ?', [res.lastID]);
}

async function getActivityLogByUser(userId, limit = 50, offset = 0) {
  return all(`
    SELECT * FROM activity_log
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `, [userId, limit, offset]);
}

async function getUserById(id) {
  return await get('SELECT * FROM users WHERE id = ?', [id]);
}

async function updateUserClickMode(id, mode) {
  if (!['double', 'single'].includes(mode)) {
    throw new Error('Invalid click mode: must be "double" or "single"');
  }
  return await run('UPDATE users SET preferred_click_mode = ? WHERE id = ?', [mode, id]);
}

// ── Background Transfer Helpers (#64) ─────────────────────────────────────────

async function createTransfer({ id, userId, srcProviderType, srcProviderConnectionId = null, srcPath, dstProviderType, dstProviderConnectionId = null, dstPath, operation = 'copy', isDirectory = 0, totalBytes = 0, totalFiles = 1 }) {
  const normSrcConn = srcProviderConnectionId ? parseInt(srcProviderConnectionId, 10) : null;
  const normDstConn = dstProviderConnectionId ? parseInt(dstProviderConnectionId, 10) : null;
  await run(`
    INSERT INTO transfers (
      id, user_id, src_provider_type, src_provider_connection_id, src_path,
      dst_provider_type, dst_provider_connection_id, dst_path, operation,
      is_directory, total_bytes, total_files, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', datetime('now'))
  `, [
    id, userId, srcProviderType || 'local', normSrcConn, srcPath,
    dstProviderType || 'local', normDstConn, dstPath, operation || 'copy',
    isDirectory ? 1 : 0, totalBytes || 0, totalFiles || 1
  ]);
  return get('SELECT * FROM transfers WHERE id = ?', [id]);
}

async function getTransfersByUser(userId) {
  return all('SELECT * FROM transfers WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getTransferById(id, userId) {
  return get('SELECT * FROM transfers WHERE id = ? AND user_id = ?', [id, userId]);
}

async function updateTransferProgress(id, { status, transferredBytes, completedFiles, currentFile, errorMessage, startedAt, finishedAt }) {
  const updates = [];
  const params = [];

  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (transferredBytes !== undefined) { updates.push('transferred_bytes = ?'); params.push(transferredBytes); }
  if (completedFiles !== undefined) { updates.push('completed_files = ?'); params.push(completedFiles); }
  if (currentFile !== undefined) { updates.push('current_file = ?'); params.push(currentFile); }
  if (errorMessage !== undefined) { updates.push('error_message = ?'); params.push(errorMessage); }
  if (startedAt !== undefined) { updates.push('started_at = ?'); params.push(startedAt); }
  if (finishedAt !== undefined) { updates.push('finished_at = ?'); params.push(finishedAt); }

  if (updates.length === 0) return get('SELECT * FROM transfers WHERE id = ?', [id]);

  params.push(id);
  await run(`UPDATE transfers SET ${updates.join(', ')} WHERE id = ?`, params);
  return get('SELECT * FROM transfers WHERE id = ?', [id]);
}

async function cancelTransfer(id, userId) {
  const res = await run(`
    UPDATE transfers
    SET status = 'cancelled', finished_at = datetime('now')
    WHERE id = ? AND user_id = ? AND status IN ('queued', 'in_progress')
  `, [id, userId]);
  return res.changes > 0;
}

// ── Ecosystem Ingest Log Helpers (#62) ────────────────────────────────────────

/**
 * Record a Paperless-ngx or Immich ingest event.
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.filePath
 * @param {string} opts.fileName
 * @param {'paperless'|'immich'} opts.target
 * @param {'success'|'error'} opts.status
 * @param {string|null} opts.remoteId  - ID returned by the remote service
 * @param {string|null} opts.details
 */
async function createEcosystemIngestLog({ userId, filePath, fileName, target, status = 'success', remoteId = null, details = null }) {
  const res = await run(`
    INSERT INTO ecosystem_ingest_log (user_id, file_path, file_name, target, status, remote_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, filePath, fileName, target, status, remoteId, details]);
  return get('SELECT * FROM ecosystem_ingest_log WHERE id = ?', [res.lastID]);
}

/**
 * Fetch all ecosystem ingest log entries for a user, newest first.
 */
async function getEcosystemIngestLogs(userId, limit = 100, offset = 0) {
  return all(`
    SELECT * FROM ecosystem_ingest_log
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `, [userId, limit, offset]);
}

/**
 * Sync Jobs Helpers (#71)
 */
async function createSyncJob({ userId, providerConnectionId = null, localPath, remotePath, conflictStrategy = 'newer_wins', syncMode = 'two_way' }) {
  const res = await run(`
    INSERT INTO sync_jobs (user_id, provider_connection_id, local_path, remote_path, sync_mode, conflict_strategy, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `, [userId, providerConnectionId, localPath, remotePath, syncMode, conflictStrategy]);

  return getSyncJobById(res.lastID, userId);
}

async function getSyncJobById(id, userId) {
  return get(`SELECT * FROM sync_jobs WHERE id = ? AND user_id = ?`, [id, userId]);
}

async function getSyncJobsByUser(userId) {
  return all(`SELECT * FROM sync_jobs WHERE user_id = ? ORDER BY id DESC`, [userId]);
}

async function updateSyncJobStatus(id, { status, lastSyncedAt = null, error = null }) {
  await run(`
    UPDATE sync_jobs
    SET status = ?, last_synced_at = COALESCE(?, last_synced_at), error = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [status, lastSyncedAt, error, id]);

  return get(`SELECT * FROM sync_jobs WHERE id = ?`, [id]);
}

/**
 * User Webhook Helpers (#72)
 */
async function createWebhook({ userId, url, secret = null, events = ['file_created', 'file_deleted', 'share_revoked'], enabled = 1 }) {
  const eventsStr = Array.isArray(events) ? JSON.stringify(events) : (events || '["file_created","file_deleted","share_revoked"]');
  const res = await run(`
    INSERT INTO user_webhooks (user_id, url, secret, events, enabled)
    VALUES (?, ?, ?, ?, ?)
  `, [userId, url, secret, eventsStr, enabled ? 1 : 0]);
  return getWebhookById(res.lastID, userId);
}

async function getWebhooksByUser(userId) {
  return all(`SELECT * FROM user_webhooks WHERE user_id = ? ORDER BY id DESC`, [userId]);
}

async function getWebhookById(id, userId) {
  return get(`SELECT * FROM user_webhooks WHERE id = ? AND user_id = ?`, [id, userId]);
}

async function deleteWebhook(id, userId) {
  const res = await run(`DELETE FROM user_webhooks WHERE id = ? AND user_id = ?`, [id, userId]);
  return res.changes > 0;
}

async function updateWebhook(id, userId, { url, secret, events, enabled }) {
  const updates = [];
  const params = [];
  if (url !== undefined) { updates.push('url = ?'); params.push(url); }
  if (secret !== undefined) { updates.push('secret = ?'); params.push(secret); }
  if (events !== undefined) {
    const eventsStr = Array.isArray(events) ? JSON.stringify(events) : events;
    updates.push('events = ?');
    params.push(eventsStr);
  }
  if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  updates.push("updated_at = datetime('now')");

  params.push(id, userId);
  await run(`UPDATE user_webhooks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  return getWebhookById(id, userId);
}

/**
 * FTS5 Full-Text Search Helpers (#74)
 */
function sanitizeFtsQuery(q) {
  if (!q || typeof q !== 'string') return '';
  const cleaned = q.replace(/['"():*]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.split(/\s+/).filter(Boolean).map(w => `"${w}"*`).join(' ');
}

async function indexFileInFts(userId, filePath, fileName, content = '') {
  const normName = fileName || path.basename(filePath);
  await run('DELETE FROM files_fts WHERE user_id = ? AND path = ?', [userId, filePath]);
  await run(`
    INSERT INTO files_fts (user_id, path, filename, content, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `, [userId, filePath, normName, content || '']);
  return true;
}

async function deleteFileFromFts(userId, filePath) {
  const prefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
  await run(`
    DELETE FROM files_fts
    WHERE user_id = ? AND (path = ? OR path LIKE ? || '%')
  `, [userId, filePath, prefix]);
  return true;
}

async function updateFtsPathOnMove(userId, srcPath, dstPath) {
  const dstName = path.basename(dstPath);
  await run(`
    UPDATE files_fts
    SET path = ?, filename = ?
    WHERE user_id = ? AND path = ?
  `, [dstPath, dstName, userId, srcPath]);

  const srcPrefix = srcPath.endsWith('/') ? srcPath : `${srcPath}/`;
  const dstPrefix = dstPath.endsWith('/') ? dstPath : `${dstPath}/`;

  await run(`
    UPDATE files_fts
    SET path = ? || SUBSTR(path, ?)
    WHERE user_id = ? AND path LIKE ? || '%'
  `, [dstPrefix, srcPrefix.length + 1, userId, srcPrefix]);
}

async function searchFulltext(userId, query, limit = 50) {
  if (!query || typeof query !== 'string') return [];
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  try {
    const rows = await all(`
      SELECT
        path,
        filename,
        content,
        snippet(files_fts, 3, '<b>', '</b>', '...', 10) as snippet,
        rank
      FROM files_fts
      WHERE user_id = ? AND files_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `, [userId, sanitized, limit]);

    return rows.map(r => ({
      path: r.path,
      filename: r.filename,
      snippet: r.snippet || (r.content ? r.content.slice(0, 100) : ''),
      rank: r.rank
    }));
  } catch (err) {
    return [];
  }
}

async function reindexUserFiles(userId, userRoot) {
  const fs = require('fs/promises');
  const textExts = new Set(['.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.xml', '.csv', '.py', '.c', '.cpp', '.h', '.java', '.sh', '.yaml', '.yml', '.env', '.log']);

  await run('DELETE FROM files_fts WHERE user_id = ?', [userId]);
  let count = 0;

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = '/' + path.relative(userRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        let content = '';
        const ext = path.extname(entry.name).toLowerCase();
        if (textExts.has(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size < 2 * 1024 * 1024) {
              content = await fs.readFile(fullPath, 'utf8');
            }
          } catch (e) {}
        }
        await indexFileInFts(userId, relPath, entry.name, content);
        count++;
      }
    }
  }

  await walk(userRoot);
  return count;
}

module.exports = {
  getDb,
  run,
  get,
  all,
  closeDb,
  initDb,
  upsertUser,
  getUserById,
  updateUserClickMode,
  addProviderConnection,
  getProviderConnections,
  createFileShare,
  getFileSharesByOwner,
  getFileSharesByPath,
  getFileSharesForSharee,
  deleteFileShare,
  createPublicShare,
  updatePublicShare,
  getPublicShareByToken,
  getPublicSharesByUser,
  getPublicSharesByPath,
  deletePublicShare,
  incrementPublicShareDownloads,
  updateSharePathsOnMove,
  createTrashItem,
  getTrashItemsByUser,
  getTrashItemById,
  deleteTrashItem,
  emptyTrash,
  cleanupExpiredTrashItems,
  logActivity,
  getActivityLogByUser,
  createTransfer,
  getTransfersByUser,
  getTransferById,
  updateTransferProgress,
  cancelTransfer,
  createEcosystemIngestLog,
  getEcosystemIngestLogs,
  createSyncJob,
  getSyncJobById,
  getSyncJobsByUser,
  updateSyncJobStatus,
  createWebhook,
  getWebhooksByUser,
  getWebhookById,
  deleteWebhook,
  updateWebhook,
  indexFileInFts,
  deleteFileFromFts,
  updateFtsPathOnMove,
  searchFulltext,
  reindexUserFiles
};


