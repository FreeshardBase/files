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

async function createFileShare(ownerUserId, shareeUserId, filePath, providerType = 'local', isDirectory = 0, readWrite = 0) {
  const res = await run(`
    INSERT INTO file_shares (owner_user_id, sharee_user_id, provider_type, file_path, is_directory, read_write)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [ownerUserId, shareeUserId, providerType, filePath, isDirectory ? 1 : 0, readWrite ? 1 : 0]);
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

async function createPublicShare(userId, token, filePath, isDirectory = 0, passwordHash = null, expiresAt = null, maxDownloads = null, label = null) {
  const res = await run(`
    INSERT INTO public_shares (user_id, token, file_path, is_directory, password_hash, expires_at, max_downloads, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, token, filePath, isDirectory ? 1 : 0, passwordHash, expiresAt, maxDownloads, label]);
  return get('SELECT * FROM public_shares WHERE id = ?', [res.lastID]);
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

module.exports = {
  getDb,
  run,
  get,
  all,
  closeDb,
  initDb,
  upsertUser,
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
  getActivityLogByUser
};
