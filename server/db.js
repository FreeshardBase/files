const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'files.db');

// Ensure parent dir exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  // Enforce WAL mode and busy timeout (Risk 1 in Architecture Guide #24)
  await run('PRAGMA journal_mode = WAL;');
  await run('PRAGMA busy_timeout = 5000;');
  await run('PRAGMA foreign_keys = ON;');

  // Core Users table (#3, #25)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT,
      auth_type TEXT DEFAULT 'oidc',
      preferred_locale TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Public Share Links (#3, #15)
  await run(`
    CREATE TABLE IF NOT EXISTS public_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL DEFAULT 'local',
      provider_connection_id INTEGER REFERENCES provider_connections(id),
      file_path TEXT NOT NULL,
      is_directory INTEGER DEFAULT 0,
      permission_mode TEXT DEFAULT 'read',
      password_hash TEXT,
      expires_at TEXT,
      max_downloads INTEGER,
      download_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

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
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb
};
