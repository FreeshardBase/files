const path = require('path');
const fs = require('fs/promises');
const { safePath } = require('../utils/safepath');
const db = require('../db');

async function ensureUserHome(userRoot) {
  await fs.mkdir(userRoot, { recursive: true });
  await fs.mkdir(path.join(userRoot, 'Documents'), { recursive: true });
  await fs.mkdir(path.join(userRoot, 'Pictures'), { recursive: true });
}

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

async function validateUserIsolation(req, res, next) {
  const userId = req.userId || req.session?.userId || req.session?.user?.id || 'default-user';
  const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
  const userRoot = req.userRoot || path.resolve(rootBase, userId);

  try {
    await ensureUserHome(userRoot);

    req.userRoot = userRoot;
    req.userId = userId;

    const requestedPath = req.query.path || req.body?.path || req.body?.src || '/';
    req.resolvedPath = safePath(userRoot, requestedPath);

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const user = await db.getUserById(userId);
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
