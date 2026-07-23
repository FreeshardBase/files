const path = require('path');
const fs = require('fs/promises');
const { lstatSync } = require('fs');
const { safePath } = require('../utils/safepath');
const db = require('../db');

/**
 * Ensures user's home directory structure exists
 * @param {string} userRoot 
 */
async function ensureUserHome(userRoot) {
  await fs.mkdir(userRoot, { recursive: true });
  await fs.mkdir(path.join(userRoot, 'Documents'), { recursive: true });
  await fs.mkdir(path.join(userRoot, 'Pictures'), { recursive: true });
}

/**
 * Calculates total disk usage in bytes for a user home directory
 * @param {string} userRoot 
 * @returns {Promise<number>} Total size in bytes
 */
async function getUserStorageUsage(userRoot) {
  let totalBytes = 0;

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.lstat(fullPath);
          if (stat.isDirectory()) {
            await walk(fullPath);
          } else {
            totalBytes += stat.size;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  await walk(userRoot);
  return totalBytes;
}

/**
 * Middleware enforcing user home isolation, path traversal prevention, and storage quota checks
 */
async function validateUserIsolation(req, res, next) {
  const userId = req.session?.userId || req.headers['remote-user'] || 'default-user';
  const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
  const userRoot = path.resolve(rootBase, userId);

  try {
    // 1. Auto-provision user home directory on access
    await ensureUserHome(userRoot);

    // Attach user environment to request
    req.userRoot = userRoot;
    req.userId = userId;

    // 2. Validate requested path if present in query, params, or body
    const requestedPath = req.query.path || req.body?.path || req.body?.src || '/';
    req.resolvedPath = safePath(userRoot, requestedPath);

    // 3. Quota check for write operations
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const user = await db.get('SELECT quota_bytes FROM users WHERE id = ?', [userId]);
      if (user && user.quota_bytes !== null && user.quota_bytes > 0) {
        const currentUsage = await getUserStorageUsage(userRoot);
        const incomingContentLength = parseInt(req.headers['content-length'] || '0', 10);
        
        if (currentUsage + incomingContentLength > user.quota_bytes) {
          return res.status(507).json({
            error: 'Storage quota exceeded',
            code: 'INSUFFICIENT_STORAGE',
            quotaBytes: user.quota_bytes,
            currentUsageBytes: currentUsage
          });
        }
      }
    }

    next();
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
}

module.exports = {
  ensureUserHome,
  getUserStorageUsage,
  validateUserIsolation
};
