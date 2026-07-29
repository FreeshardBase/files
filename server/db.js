const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

  // Filing Rules (#90)
  await run(`
    CREATE TABLE IF NOT EXISTS filing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      condition_type TEXT NOT NULL,
      condition_value TEXT NOT NULL,
      target_folder TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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

  // Public Share Analytics & Access Dashboard (#81)
  await run(`
    CREATE TABLE IF NOT EXISTS share_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL REFERENCES public_shares(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // E2EE Vaults (#75)
  await run(`
    CREATE TABLE IF NOT EXISTS vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      encrypted_metadata TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Custom File Tagging (#77)
  await run(`
    CREATE TABLE IF NOT EXISTS file_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      color TEXT DEFAULT '#3B82F6',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, file_path, tag_name)
    )
  `);

  // File Versioning (#78)
  await run(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      author TEXT NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Collaborative Comments (#79)
  await run(`
    CREATE TABLE IF NOT EXISTS file_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      comment TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Automated Scheduled Storage Backup & Disaster Recovery Snapshots (#83)
  await run(`
    CREATE TABLE IF NOT EXISTS backup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      schedule TEXT DEFAULT 'daily',
      target_path TEXT NOT NULL DEFAULT '/',
      encrypted INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      last_run_at TEXT,
      next_run_at TEXT,
      backup_file_path TEXT,
      file_size INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Advanced Office Document Live Collaborative Editing (#85)
  await run(`
    CREATE TABLE IF NOT EXISTS wopi_tokens (
      token TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      can_write INTEGER DEFAULT 1,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS wopi_locks (
      file_id TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Bandwidth Throttling Settings (#86)
  await run(`
    CREATE TABLE IF NOT EXISTS user_bandwidth_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      upload_limit_kbps INTEGER DEFAULT 0,
      download_limit_kbps INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // File Checksums & Bit-Rot Scanner (#87)
  await run(`
    CREATE TABLE IF NOT EXISTS file_checksums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      algorithm TEXT DEFAULT 'sha256',
      file_size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ok',
      last_scanned_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Media Transcriptions (#89)
  await run(`
    CREATE TABLE IF NOT EXISTS media_transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      language TEXT DEFAULT 'en',
      transcript TEXT,
      vtt TEXT,
      duration REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Security Sessions (#91)
  await run(`
    CREATE TABLE IF NOT EXISTS security_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_type TEXT DEFAULT 'Desktop',
      ip_address TEXT DEFAULT '127.0.0.1',
      user_agent TEXT DEFAULT '',
      last_active_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // User Custom Branding (#92)
  await run(`
    CREATE TABLE IF NOT EXISTS user_branding (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      logo_url TEXT DEFAULT NULL,
      primary_color TEXT DEFAULT NULL,
      welcome_message TEXT DEFAULT NULL,
      custom_domain TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Cloud-to-Cloud Sync Jobs (#93)
  await run(`
    CREATE TABLE IF NOT EXISTS cloud_sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      src_connection_id INTEGER NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      src_path TEXT NOT NULL DEFAULT '/',
      dst_connection_id INTEGER NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      dst_path TEXT NOT NULL DEFAULT '/',
      schedule TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'pending',
      transferred_files INTEGER DEFAULT 0,
      transferred_bytes INTEGER DEFAULT 0,
      error_message TEXT DEFAULT NULL,
      last_run_at TEXT DEFAULT NULL,
      next_run_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Real-Time Presence (#94)
  await run(`
    CREATE TABLE IF NOT EXISTS user_presence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      folder_path TEXT NOT NULL,
      file_name TEXT DEFAULT NULL,
      action TEXT DEFAULT 'viewing',
      last_heartbeat TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Secure Temporary Dropboxes / File Request Portals (#95)
  await run(`
    CREATE TABLE IF NOT EXISTS file_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      target_folder TEXT NOT NULL DEFAULT '/',
      title TEXT DEFAULT NULL,
      description TEXT DEFAULT NULL,
      expires_at TEXT DEFAULT NULL,
      max_uploads INTEGER DEFAULT NULL,
      upload_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Compliance Retention & Legal Hold Policies (#99)
  await run(`
    CREATE TABLE IF NOT EXISTS legal_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      policy_name TEXT DEFAULT 'retention_policy',
      reason TEXT DEFAULT NULL,
      lock_until TEXT DEFAULT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
        const ocrService = require('./utils/ocr_service');
        if (textExts.has(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size < 2 * 1024 * 1024) {
              content = await fs.readFile(fullPath, 'utf8');
            }
          } catch (e) {}
        } else if (ocrService.isSupportedFile(fullPath)) {
          try {
            content = await ocrService.extractTextFromFile(fullPath);
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

// E2EE Vaults (#75)
async function createVault(userId, name, salt, encryptedMetadata) {
  const res = await run(
    `INSERT INTO vaults (user_id, name, salt, encrypted_metadata) VALUES (?, ?, ?, ?)`,
    [userId, name, salt, encryptedMetadata]
  );
  return get('SELECT * FROM vaults WHERE id = ?', [res.lastID]);
}

async function getVaultsByUser(userId) {
  return all('SELECT * FROM vaults WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getVaultById(id, userId) {
  return get('SELECT * FROM vaults WHERE id = ? AND user_id = ?', [id, userId]);
}

// File Tags (#77)
async function assignTag(userId, filePath, tagName, color = '#3B82F6') {
  await run(`
    INSERT INTO file_tags (user_id, file_path, tag_name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, file_path, tag_name) DO UPDATE SET color = excluded.color
  `, [userId, filePath, tagName, color || '#3B82F6']);
  return get('SELECT * FROM file_tags WHERE user_id = ? AND file_path = ? AND tag_name = ?', [userId, filePath, tagName]);
}

async function removeTag(userId, filePath, tagName) {
  const res = await run('DELETE FROM file_tags WHERE user_id = ? AND file_path = ? AND tag_name = ?', [userId, filePath, tagName]);
  return res.changes > 0;
}

async function getTagsByUser(userId, filePath = null) {
  if (filePath) {
    return all('SELECT * FROM file_tags WHERE user_id = ? AND file_path = ? ORDER BY created_at ASC', [userId, filePath]);
  }
  return all('SELECT * FROM file_tags WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

// File Versioning (#78)
async function getNextVersionNumber(userId, filePath) {
  const row = await get('SELECT MAX(version_number) as maxVer FROM file_versions WHERE user_id = ? AND file_path = ?', [userId, filePath]);
  return (row && row.maxVer) ? row.maxVer + 1 : 1;
}

async function createFileVersion(userId, filePath, versionNumber, storagePath, size, author, comment = null) {
  const res = await run(`
    INSERT INTO file_versions (user_id, file_path, version_number, storage_path, size, author, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, filePath, versionNumber, storagePath, size, author, comment]);
  return get('SELECT * FROM file_versions WHERE id = ?', [res.lastID]);
}

async function getFileVersions(userId, filePath = null) {
  if (filePath) {
    return all('SELECT * FROM file_versions WHERE user_id = ? AND file_path = ? ORDER BY version_number DESC', [userId, filePath]);
  }
  return all('SELECT * FROM file_versions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getFileVersionById(id, userId) {
  return get('SELECT * FROM file_versions WHERE id = ? AND user_id = ?', [id, userId]);
}

// Collaborative Comments (#79)
async function createFileComment(userId, filePath, comment) {
  const res = await run(`
    INSERT INTO file_comments (user_id, file_path, comment)
    VALUES (?, ?, ?)
  `, [userId, filePath, comment]);
  return get('SELECT * FROM file_comments WHERE id = ?', [res.lastID]);
}

async function getFileComments(userId, filePath = null) {
  if (filePath) {
    return all('SELECT * FROM file_comments WHERE user_id = ? AND file_path = ? ORDER BY created_at ASC', [userId, filePath]);
  }
  return all('SELECT * FROM file_comments WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function resolveFileComment(id, userId, resolved = 1) {
  await run(`
    UPDATE file_comments
    SET resolved = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `, [resolved ? 1 : 0, id, userId]);
  return get('SELECT * FROM file_comments WHERE id = ? AND user_id = ?', [id, userId]);
}

async function deleteFileComment(id, userId) {
  const res = await run('DELETE FROM file_comments WHERE id = ? AND user_id = ?', [id, userId]);
  return res.changes > 0;
}

// Public Share Analytics (#81)
async function logShareAccess({ shareId, eventType, ipAddress, userAgent, referrer }) {
  return run(
    `INSERT INTO share_analytics (share_id, event_type, ip_address, user_agent, referrer) VALUES (?, ?, ?, ?, ?)`,
    [shareId, eventType, ipAddress || null, userAgent || null, referrer || null]
  );
}

async function getShareAnalytics(shareId, userId) {
  const share = await get('SELECT * FROM public_shares WHERE id = ? AND user_id = ?', [shareId, userId]);
  if (!share) return null;

  const totalViewsRow = await get('SELECT COUNT(*) as count FROM share_analytics WHERE share_id = ? AND event_type = "view"', [shareId]);
  const totalDownloadsRow = await get('SELECT COUNT(*) as count FROM share_analytics WHERE share_id = ? AND event_type = "download"', [shareId]);
  const uniqueVisitorsRow = await get('SELECT COUNT(DISTINCT ip_address) as count FROM share_analytics WHERE share_id = ? AND ip_address IS NOT NULL', [shareId]);

  const userAgents = await all('SELECT user_agent, COUNT(*) as count FROM share_analytics WHERE share_id = ? AND user_agent IS NOT NULL GROUP BY user_agent ORDER BY count DESC', [shareId]);
  const referrers = await all('SELECT referrer, COUNT(*) as count FROM share_analytics WHERE share_id = ? AND referrer IS NOT NULL GROUP BY referrer ORDER BY count DESC', [shareId]);
  const events = await all('SELECT * FROM share_analytics WHERE share_id = ? ORDER BY created_at DESC, id DESC', [shareId]);

  return {
    share_id: share.id,
    token: share.token,
    file_path: share.file_path,
    download_count: share.download_count,
    analytics: {
      total_views: totalViewsRow ? totalViewsRow.count : 0,
      total_downloads: totalDownloadsRow ? totalDownloadsRow.count : 0,
      unique_visitors: uniqueVisitorsRow ? uniqueVisitorsRow.count : 0,
      user_agents: userAgents,
      referrers: referrers
    },
    events
  };
}

// ── Automated Scheduled Storage Backup (#83) ──────────────────────────────────

async function createBackupJob(userIdOrObj, nameParam, scheduleParam, targetPathParam, encryptedParam) {
  let userId, name, schedule, targetPath, encrypted;
  if (typeof userIdOrObj === 'object' && userIdOrObj !== null) {
    userId = userIdOrObj.userId || userIdOrObj.user_id;
    name = userIdOrObj.name;
    schedule = userIdOrObj.schedule || 'daily';
    targetPath = userIdOrObj.targetPath || userIdOrObj.target_path || '/';
    encrypted = userIdOrObj.encrypted !== undefined ? (userIdOrObj.encrypted ? 1 : 0) : 1;
  } else if (typeof nameParam === 'object' && nameParam !== null) {
    userId = userIdOrObj;
    name = nameParam.name;
    schedule = nameParam.schedule || 'daily';
    targetPath = nameParam.targetPath || nameParam.target_path || '/';
    encrypted = nameParam.encrypted !== undefined ? (nameParam.encrypted ? 1 : 0) : 1;
  } else {
    userId = userIdOrObj;
    name = nameParam;
    schedule = scheduleParam || 'daily';
    targetPath = targetPathParam || '/';
    encrypted = encryptedParam !== undefined ? (encryptedParam ? 1 : 0) : 1;
  }

  const res = await run(`
    INSERT INTO backup_jobs (user_id, name, schedule, target_path, encrypted, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `, [userId, name, schedule, targetPath, encrypted]);

  return get('SELECT * FROM backup_jobs WHERE id = ?', [res.lastID]);
}

async function getBackupJobsByUser(userId) {
  return all('SELECT * FROM backup_jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getBackupJobById(id, userId = null) {
  if (userId) {
    return get('SELECT * FROM backup_jobs WHERE id = ? AND user_id = ?', [id, userId]);
  }
  return get('SELECT * FROM backup_jobs WHERE id = ?', [id]);
}

async function updateBackupJobStatus(id, status, details = {}) {
  const { lastRunAt, nextRunAt, backupFilePath, fileSize, errorMessage } = details;
  await run(`
    UPDATE backup_jobs
    SET status = ?,
        last_run_at = COALESCE(?, last_run_at),
        next_run_at = COALESCE(?, next_run_at),
        backup_file_path = COALESCE(?, backup_file_path),
        file_size = COALESCE(?, file_size),
        error_message = COALESCE(?, error_message),
        updated_at = datetime('now')
    WHERE id = ?
  `, [status, lastRunAt || null, nextRunAt || null, backupFilePath || null, fileSize || null, errorMessage || null, id]);
  return get('SELECT * FROM backup_jobs WHERE id = ?', [id]);
}

async function createWopiToken({ token, fileId, userId, canWrite = 1, expiresAt }) {
  await run(`
    INSERT INTO wopi_tokens (token, file_id, user_id, can_write, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `, [token, fileId, userId, canWrite ? 1 : 0, expiresAt]);
  return get('SELECT * FROM wopi_tokens WHERE token = ?', [token]);
}

async function getWopiToken(token) {
  return get('SELECT * FROM wopi_tokens WHERE token = ?', [token]);
}

async function deleteWopiToken(token) {
  return run('DELETE FROM wopi_tokens WHERE token = ?', [token]);
}

async function getWopiLock(fileId) {
  return get('SELECT * FROM wopi_locks WHERE file_id = ?', [fileId]);
}

async function setWopiLock(fileId, lockId, expiresAt) {
  await run(`
    INSERT INTO wopi_locks (file_id, lock_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET lock_id = excluded.lock_id, expires_at = excluded.expires_at
  `, [fileId, lockId, expiresAt]);
  return get('SELECT * FROM wopi_locks WHERE file_id = ?', [fileId]);
}

async function deleteWopiLock(fileId) {
  return run('DELETE FROM wopi_locks WHERE file_id = ?', [fileId]);
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
  reindexUserFiles,
  createVault,
  getVaultsByUser,
  getVaultById,
  assignTag,
  removeTag,
  getTagsByUser,
  getNextVersionNumber,
  createFileVersion,
  getFileVersions,
  getFileVersionById,
  createFileComment,
  getFileComments,
  resolveFileComment,
  deleteFileComment,
  logShareAccess,
  getShareAnalytics,
  createBackupJob,
  getBackupJobsByUser,
  getBackupJobById,
  updateBackupJobStatus,
  createWopiToken,
  getWopiToken,
  deleteWopiToken,
  getWopiLock,
  setWopiLock,
  deleteWopiLock,
  getBandwidthSettings,
  setBandwidthSettings,
  saveFileChecksum,
  getFileChecksum,
  getAllChecksums,
  updateChecksumStatus,
  getCorruptedFiles,
  deleteFileChecksum,
  saveTranscription,
  getTranscriptionsByUser,
  getTranscriptionByFile,
  deleteTranscription,
  createFilingRule,
  getFilingRulesByUser,
  getFilingRuleById,
  updateFilingRule,
  deleteFilingRule,
  createSecuritySession,
  getSecuritySessionsByUser,
  getSecuritySessionById,
  deleteSecuritySession,
  revokeAllOtherSessions,
  getUserBranding,
  setUserBranding,
  deleteUserBranding,
  createCloudSyncJob,
  getCloudSyncJobsByUser,
  getCloudSyncJobById,
  updateCloudSyncJob,
  deleteCloudSyncJob,
  recordPresenceHeartbeat,
  getActiveFolderPresence,
  removeUserPresence,
  createFileRequest,
  getFileRequestByToken,
  getFileRequestsByUser,
  deleteFileRequest,
  incrementFileRequestUploads,
  createLegalHold,
  getLegalHoldsByUser,
  getLegalHoldById,
  releaseLegalHold,
  checkActiveLegalHold,
  searchUniversal
};

async function getBandwidthSettings(userId) {
  const row = await get('SELECT upload_limit_kbps, download_limit_kbps FROM user_bandwidth_settings WHERE user_id = ?', [userId]);
  if (!row) {
    return { upload_limit_kbps: 0, download_limit_kbps: 0 };
  }
  return {
    upload_limit_kbps: row.upload_limit_kbps || 0,
    download_limit_kbps: row.download_limit_kbps || 0
  };
}

async function setBandwidthSettings(userId, { upload_limit_kbps = 0, download_limit_kbps = 0 }) {
  const up = Math.max(0, parseInt(upload_limit_kbps, 10) || 0);
  const down = Math.max(0, parseInt(download_limit_kbps, 10) || 0);
  await run(`
    INSERT INTO user_bandwidth_settings (user_id, upload_limit_kbps, download_limit_kbps, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      upload_limit_kbps = excluded.upload_limit_kbps,
      download_limit_kbps = excluded.download_limit_kbps,
      updated_at = datetime('now')
  `, [userId, up, down]);
  return { upload_limit_kbps: up, download_limit_kbps: down };
}

async function saveFileChecksum(filePath, checksum, fileSize = 0, algorithm = 'sha256') {
  await run(`
    INSERT INTO file_checksums (file_path, checksum, algorithm, file_size, status, last_scanned_at, updated_at)
    VALUES (?, ?, ?, ?, 'ok', datetime('now'), datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      checksum = excluded.checksum,
      algorithm = excluded.algorithm,
      file_size = excluded.file_size,
      status = 'ok',
      last_scanned_at = datetime('now'),
      updated_at = datetime('now')
  `, [filePath, checksum, algorithm, fileSize]);
  return getFileChecksum(filePath);
}

async function getFileChecksum(filePath) {
  return get('SELECT * FROM file_checksums WHERE file_path = ?', [filePath]);
}

async function getAllChecksums() {
  return all('SELECT * FROM file_checksums ORDER BY file_path ASC');
}

async function updateChecksumStatus(filePath, status, extra = {}) {
  const params = [status];
  let extraSql = '';
  if (extra.checksum) {
    extraSql += ', checksum = ?';
    params.push(extra.checksum);
  }
  params.push(filePath);
  await run(`
    UPDATE file_checksums
    SET status = ?, last_scanned_at = datetime('now'), updated_at = datetime('now')${extraSql}
    WHERE file_path = ?
  `, params);
  return getFileChecksum(filePath);
}

async function getCorruptedFiles() {
  return all("SELECT * FROM file_checksums WHERE status = 'corrupted' ORDER BY updated_at DESC");
}

async function deleteFileChecksum(filePath) {
  return run('DELETE FROM file_checksums WHERE file_path = ?', [filePath]);
}

// ── Media Transcription Helpers (#89) ─────────────────────────────────────────

async function saveTranscription({ userId, filePath, language = 'en', transcript = '', vtt = '', duration = 0 }) {
  const existing = await get(
    'SELECT id FROM media_transcriptions WHERE user_id = ? AND file_path = ?',
    [userId, filePath]
  );
  if (existing) {
    await run(`
      UPDATE media_transcriptions
      SET language = ?, transcript = ?, vtt = ?, duration = ?, updated_at = datetime('now')
      WHERE user_id = ? AND file_path = ?
    `, [language, transcript, vtt, duration, userId, filePath]);
    return get('SELECT * FROM media_transcriptions WHERE user_id = ? AND file_path = ?', [userId, filePath]);
  }
  const res = await run(`
    INSERT INTO media_transcriptions (user_id, file_path, language, transcript, vtt, duration)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [userId, filePath, language, transcript, vtt, duration]);
  return get('SELECT * FROM media_transcriptions WHERE id = ?', [res.lastID]);
}

async function getTranscriptionsByUser(userId) {
  return all('SELECT * FROM media_transcriptions WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getTranscriptionByFile(userId, filePath) {
  return get('SELECT * FROM media_transcriptions WHERE user_id = ? AND file_path = ?', [userId, filePath]);
}

async function deleteTranscription(userId, filePath) {
  const res = await run(
    'DELETE FROM media_transcriptions WHERE user_id = ? AND file_path = ?',
    [userId, filePath]
  );
  return res.changes > 0;
}

// ── Intelligent Document Classification & Auto-Filing Helpers (#90) ───────────

async function createFilingRule(userId, { name = '', condition_type, condition_value, target_folder, is_active = 1, priority = 0 }) {
  const res = await run(`
    INSERT INTO filing_rules (user_id, name, condition_type, condition_value, target_folder, is_active, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, name, condition_type, condition_value, target_folder, is_active ? 1 : 0, priority || 0]);
  return get('SELECT * FROM filing_rules WHERE id = ?', [res.lastID]);
}

async function getFilingRulesByUser(userId) {
  return all('SELECT * FROM filing_rules WHERE user_id = ? ORDER BY priority DESC, id ASC', [userId]);
}

async function getFilingRuleById(userId, ruleId) {
  return get('SELECT * FROM filing_rules WHERE user_id = ? AND id = ?', [userId, ruleId]);
}

async function updateFilingRule(userId, ruleId, updates = {}) {
  const existing = await getFilingRuleById(userId, ruleId);
  if (!existing) return null;

  const name = updates.name !== undefined ? updates.name : existing.name;
  const condition_type = updates.condition_type !== undefined ? updates.condition_type : existing.condition_type;
  const condition_value = updates.condition_value !== undefined ? updates.condition_value : existing.condition_value;
  const target_folder = updates.target_folder !== undefined ? updates.target_folder : existing.target_folder;
  const is_active = updates.is_active !== undefined ? (updates.is_active ? 1 : 0) : existing.is_active;
  const priority = updates.priority !== undefined ? updates.priority : existing.priority;

  await run(`
    UPDATE filing_rules
    SET name = ?, condition_type = ?, condition_value = ?, target_folder = ?, is_active = ?, priority = ?, updated_at = datetime('now')
    WHERE user_id = ? AND id = ?
  `, [name, condition_type, condition_value, target_folder, is_active, priority, userId, ruleId]);

  return getFilingRuleById(userId, ruleId);
}

async function deleteFilingRule(userId, ruleId) {
  const res = await run('DELETE FROM filing_rules WHERE user_id = ? AND id = ?', [userId, ruleId]);
  return res.changes > 0;
}

// ── Session & Device Security Helpers (#91) ───────────────────────────────────

async function createSecuritySession({ id, userId, deviceType = 'Desktop', ipAddress = '127.0.0.1', userAgent = '' }) {
  await run(`
    INSERT INTO security_sessions (id, user_id, device_type, ip_address, user_agent, last_active_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      device_type = excluded.device_type,
      ip_address = excluded.ip_address,
      user_agent = excluded.user_agent,
      last_active_at = datetime('now'),
      updated_at = datetime('now')
  `, [id, userId, deviceType, ipAddress, userAgent]);
  return getSecuritySessionById(userId, id);
}

async function getSecuritySessionsByUser(userId) {
  return all('SELECT * FROM security_sessions WHERE user_id = ? ORDER BY last_active_at DESC', [userId]);
}

async function getSecuritySessionById(userId, sessionId) {
  return get('SELECT * FROM security_sessions WHERE user_id = ? AND id = ?', [userId, sessionId]);
}

async function deleteSecuritySession(userId, sessionId) {
  const res = await run('DELETE FROM security_sessions WHERE user_id = ? AND id = ?', [userId, sessionId]);
  return res.changes > 0;
}

async function revokeAllOtherSessions(userId, currentSessionId) {
  const res = await run('DELETE FROM security_sessions WHERE user_id = ? AND id != ?', [userId, currentSessionId]);
  return res.changes;
}

// ── User Custom Branding Helpers (#92) ────────────────────────────────────────

async function getUserBranding(userId) {
  const row = await get('SELECT * FROM user_branding WHERE user_id = ?', [userId]);
  if (!row) {
    return {
      user_id: userId,
      logo_url: null,
      primary_color: null,
      welcome_message: null,
      custom_domain: null
    };
  }
  return row;
}

async function setUserBranding(userId, { logo_url = null, primary_color = null, welcome_message = null, custom_domain = null }) {
  await run(`
    INSERT INTO user_branding (user_id, logo_url, primary_color, welcome_message, custom_domain, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      logo_url = excluded.logo_url,
      primary_color = excluded.primary_color,
      welcome_message = excluded.welcome_message,
      custom_domain = excluded.custom_domain,
      updated_at = datetime('now')
  `, [userId, logo_url, primary_color, welcome_message, custom_domain]);
  return getUserBranding(userId);
}

async function deleteUserBranding(userId) {
  const res = await run('DELETE FROM user_branding WHERE user_id = ?', [userId]);
  return res.changes > 0;
}

// ── Bulk Direct Cloud-to-Cloud Backup Sync Helpers (#93) ──────────────────────

async function createCloudSyncJob(userId, { name = '', src_connection_id, src_path = '/', dst_connection_id, dst_path = '/', schedule = 'manual' }) {
  const res = await run(`
    INSERT INTO cloud_sync_jobs (user_id, name, src_connection_id, src_path, dst_connection_id, dst_path, schedule, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `, [userId, name, src_connection_id, src_path, dst_connection_id, dst_path, schedule]);
  return getCloudSyncJobById(userId, res.lastID);
}

async function getCloudSyncJobsByUser(userId) {
  return all('SELECT * FROM cloud_sync_jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

async function getCloudSyncJobById(userId, jobId) {
  return get('SELECT * FROM cloud_sync_jobs WHERE user_id = ? AND id = ?', [userId, jobId]);
}

async function updateCloudSyncJob(userId, jobId, updates = {}) {
  const existing = await getCloudSyncJobById(userId, jobId);
  if (!existing) return null;

  const status = updates.status !== undefined ? updates.status : existing.status;
  const transferred_files = updates.transferred_files !== undefined ? updates.transferred_files : existing.transferred_files;
  const transferred_bytes = updates.transferred_bytes !== undefined ? updates.transferred_bytes : existing.transferred_bytes;
  const error_message = updates.error_message !== undefined ? updates.error_message : existing.error_message;
  const last_run_at = updates.last_run_at !== undefined ? updates.last_run_at : existing.last_run_at;
  const next_run_at = updates.next_run_at !== undefined ? updates.next_run_at : existing.next_run_at;

  await run(`
    UPDATE cloud_sync_jobs
    SET status = ?, transferred_files = ?, transferred_bytes = ?, error_message = ?, last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND id = ?
  `, [status, transferred_files, transferred_bytes, error_message, last_run_at, next_run_at, userId, jobId]);

  return getCloudSyncJobById(userId, jobId);
}

async function deleteCloudSyncJob(userId, jobId) {
  const res = await run('DELETE FROM cloud_sync_jobs WHERE user_id = ? AND id = ?', [userId, jobId]);
  return res.changes > 0;
}

// ── Real-Time Presence Helpers (#94) ──────────────────────────────────────────

async function recordPresenceHeartbeat(userId, { username = null, folder_path = '/', file_name = null, action = 'viewing' } = {}) {
  const normFolder = folder_path || '/';
  const normFile = file_name || null;
  const act = action || 'viewing';

  let name = username;
  if (!name) {
    const userRow = await get('SELECT username, email, name FROM users WHERE id = ?', [userId]);
    if (userRow) name = userRow.username || userRow.name || userRow.email || userId;
    else name = userId;
  }

  const existing = await get(
    'SELECT id FROM user_presence WHERE user_id = ? AND folder_path = ? AND (file_name = ? OR (file_name IS NULL AND ? IS NULL))',
    [userId, normFolder, normFile, normFile]
  );

  if (existing) {
    await run(
      `UPDATE user_presence 
       SET username = ?, action = ?, last_heartbeat = datetime('now') 
       WHERE id = ?`,
      [name, act, existing.id]
    );
  } else {
    await run(
      `INSERT INTO user_presence (user_id, username, folder_path, file_name, action, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [userId, name, normFolder, normFile, act]
    );
  }

  return getActiveFolderPresence(normFolder);
}

async function getActiveFolderPresence(folderPath, ttlSeconds = 60) {
  const normFolder = folderPath || '/';
  const rows = await all(
    `SELECT id, user_id, username, folder_path, file_name, action, last_heartbeat, created_at
     FROM user_presence
     WHERE folder_path = ? AND last_heartbeat >= datetime('now', '-' || ? || ' seconds')
     ORDER BY last_heartbeat DESC`,
    [normFolder, ttlSeconds]
  );
  return rows;
}

async function removeUserPresence(userId, folderPath = null) {
  if (folderPath) {
    const res = await run('DELETE FROM user_presence WHERE user_id = ? AND folder_path = ?', [userId, folderPath]);
    return res.changes > 0;
  } else {
    const res = await run('DELETE FROM user_presence WHERE user_id = ?', [userId]);
    return res.changes > 0;
  }
}

// ── File Request Portal Helpers (#95) ───────────────────────────────────────

async function createFileRequest(userId, { target_folder = '/', title = null, description = null, expires_at = null, max_uploads = null, token = null } = {}) {
  const reqToken = token || ('req_' + crypto.randomBytes(12).toString('hex'));
  const normFolder = target_folder || '/';

  await run(`
    INSERT INTO file_requests (token, user_id, target_folder, title, description, expires_at, max_uploads, upload_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `, [reqToken, userId, normFolder, title, description, expires_at, max_uploads]);

  return getFileRequestByToken(reqToken);
}

async function getFileRequestByToken(token) {
  const row = await get(`
    SELECT fr.*, u.username as owner_username, u.display_name as owner_display_name
    FROM file_requests fr
    LEFT JOIN users u ON fr.user_id = u.id
    WHERE fr.token = ?
  `, [token]);
  return row || null;
}

async function getFileRequestsByUser(userId) {
  const rows = await all(`
    SELECT * FROM file_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [userId]);
  return rows;
}

async function deleteFileRequest(userId, idOrToken) {
  const res = await run(`
    DELETE FROM file_requests
    WHERE user_id = ? AND (id = ? OR token = ?)
  `, [userId, idOrToken, idOrToken]);
  return res.changes > 0;
}

async function incrementFileRequestUploads(id) {
  await run(`
    UPDATE file_requests
    SET upload_count = upload_count + 1
    WHERE id = ?
  `, [id]);
  return get('SELECT * FROM file_requests WHERE id = ?', [id]);
}

// ── Compliance Retention & Legal Hold Helpers (#99) ─────────────────────────

async function createLegalHold(userId, { file_path, policy_name = 'compliance_retention', reason = null, lock_until = null } = {}) {
  const normPath = file_path ? (file_path.startsWith('/') ? file_path : '/' + file_path) : '/';
  const res = await run(`
    INSERT INTO legal_holds (user_id, file_path, policy_name, reason, lock_until, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `, [userId, normPath, policy_name, reason, lock_until]);

  return getLegalHoldById(res.lastID, userId);
}

async function getLegalHoldsByUser(userId) {
  const rows = await all(`
    SELECT * FROM legal_holds
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [userId]);
  return rows;
}

async function getLegalHoldById(id, userId) {
  const row = await get(`
    SELECT * FROM legal_holds
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return row || null;
}

async function releaseLegalHold(id, userId) {
  const res = await run(`
    UPDATE legal_holds
    SET status = 'released', updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return res.changes > 0;
}

async function checkActiveLegalHold(userId, filePath) {
  if (!filePath) return null;
  const normPath = filePath.startsWith('/') ? filePath : '/' + filePath;
  
  const holds = await all(`
    SELECT * FROM legal_holds
    WHERE user_id = ? AND status = 'active'
  `, [userId]);

  for (const hold of holds) {
    if (hold.lock_until) {
      const lockDate = new Date(hold.lock_until);
      if (!isNaN(lockDate.getTime()) && lockDate.getTime() <= Date.now()) {
        continue; // Expired
      }
    }

    const holdPath = hold.file_path.startsWith('/') ? hold.file_path : '/' + hold.file_path;
    if (normPath === holdPath || normPath.startsWith(holdPath.endsWith('/') ? holdPath : holdPath + '/')) {
      return hold;
    }
  }

  return null;
}

async function searchUniversal(userId, query, limit = 50) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { files: [], shares: [], tags: [], ecosystem: [] };
  }
  const q = query.trim();
  const pattern = `%${q}%`;

  let files = await searchFulltext(userId, q, limit);
  if (!files || files.length === 0) {
    const rows = await all(`
      SELECT path, filename, content FROM files_fts
      WHERE user_id = ? AND (filename LIKE ? OR path LIKE ? OR content LIKE ?)
      LIMIT ?
    `, [userId, pattern, pattern, pattern, limit]);
    files = rows.map(r => ({
      path: r.path,
      filename: r.filename,
      snippet: r.content ? r.content.slice(0, 100) : '',
      rank: 0
    }));
  }

  const formattedFiles = files.map(f => ({
    ...f,
    type: 'file',
    title: f.filename || path.basename(f.path),
    deepLink: `/api/files/download?path=${encodeURIComponent(f.path)}`
  }));

  const publicShares = await all(`
    SELECT * FROM public_shares
    WHERE user_id = ? AND (label LIKE ? OR file_path LIKE ? OR token LIKE ?)
    LIMIT ?
  `, [userId, pattern, pattern, pattern, limit]);

  const fileShares = await all(`
    SELECT * FROM file_shares
    WHERE (owner_user_id = ? OR sharee_user_id = ?) AND file_path LIKE ?
    LIMIT ?
  `, [userId, userId, pattern, limit]);

  const formattedPublicShares = publicShares.map(s => ({
    id: s.id,
    type: 'public_share',
    title: s.label || s.file_path,
    token: s.token,
    filePath: s.file_path,
    deepLink: `/s/${s.token}`
  }));

  const formattedFileShares = fileShares.map(s => ({
    id: s.id,
    type: 'internal_share',
    title: s.file_path,
    filePath: s.file_path,
    readWrite: s.read_write,
    deepLink: `/shares/${s.id}`
  }));

  const shares = [...formattedPublicShares, ...formattedFileShares];

  const tagRows = await all(`
    SELECT * FROM file_tags
    WHERE user_id = ? AND (tag_name LIKE ? OR file_path LIKE ?)
    LIMIT ?
  `, [userId, pattern, pattern, limit]);

  const tags = tagRows.map(t => ({
    id: t.id,
    type: 'tag',
    tagName: t.tag_name,
    filePath: t.file_path,
    color: t.color,
    deepLink: `/api/tags?tag=${encodeURIComponent(t.tag_name)}`
  }));

  const ecoRows = await all(`
    SELECT * FROM ecosystem_ingest_log
    WHERE user_id = ? AND (file_name LIKE ? OR file_path LIKE ? OR target LIKE ? OR details LIKE ? OR remote_id LIKE ?)
    LIMIT ?
  `, [userId, pattern, pattern, pattern, pattern, pattern, limit]);

  const paperlessBase = (process.env.PAPERLESS_URL || 'http://paperless.freeshard.local').replace(/\/$/, '');
  const immichBase = (process.env.IMMICH_URL || 'http://immich.freeshard.local').replace(/\/$/, '');

  const ecosystem = ecoRows.map(e => {
    let deepLink = `/${e.target}?remoteId=${e.remote_id || ''}`;
    if (e.target === 'paperless' && e.remote_id) {
      deepLink = `${paperlessBase}/documents/${e.remote_id}`;
    } else if (e.target === 'immich' && e.remote_id) {
      deepLink = `${immichBase}/photos/${e.remote_id}`;
    }
    return {
      id: e.id,
      type: e.target,
      target: e.target,
      fileName: e.file_name,
      filePath: e.file_path,
      remoteId: e.remote_id,
      status: e.status,
      details: e.details,
      deepLink
    };
  });

  return {
    files: formattedFiles,
    shares,
    tags,
    ecosystem
  };
}




