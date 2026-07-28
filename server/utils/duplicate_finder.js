const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Computes SHA-256 hash of a file on disk
 */
async function computeFileHash(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Recursively scans directory for duplicate files by SHA-256 hash
 */
async function scanDuplicates(userRoot) {
  const hashMap = new Map();

  async function walkDir(currentDir, relDir = '') {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden dirs/files (.trash, .vaults, etc.)
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.join(relDir, entry.name).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walkDir(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          const hash = await computeFileHash(fullPath);

          const item = {
            path: '/' + relPath,
            name: entry.name,
            size: stat.size,
            modified: stat.mtime
          };

          if (!hashMap.has(hash)) {
            hashMap.set(hash, {
              hash,
              size: stat.size,
              files: []
            });
          }
          hashMap.get(hash).files.push(item);
        } catch (err) {
          // Ignore unreadable files
        }
      }
    }
  }

  await walkDir(userRoot);

  const duplicates = [];
  for (const group of hashMap.values()) {
    if (group.files.length > 1) {
      duplicates.push({
        ...group,
        count: group.files.length
      });
    }
  }

  return duplicates;
}

/**
 * Safely resolves relative path against user root, blocking path traversal
 */
function resolveSafePath(userRoot, relPath) {
  if (!relPath || typeof relPath !== 'string') {
    const err = new Error('Path is required');
    err.statusCode = 400;
    throw err;
  }
  const cleanRel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
  const fullPath = path.resolve(userRoot, cleanRel);
  if (!fullPath.startsWith(userRoot)) {
    const err = new Error('Path traversal blocked');
    err.statusCode = 403;
    throw err;
  }
  return fullPath;
}

/**
 * Performs 1-click deduplication by deleting copy or replacing copy with hard link
 */
async function deduplicateFile(userRoot, { action, keepPath, targetPath }) {
  if (!action || !['delete', 'hardlink'].includes(action)) {
    const err = new Error('Invalid or missing action. Must be "delete" or "hardlink".');
    err.statusCode = 400;
    throw err;
  }

  const keepDisk = resolveSafePath(userRoot, keepPath);
  const targetDisk = resolveSafePath(userRoot, targetPath);

  let keepStat, targetStat;
  try {
    keepStat = await fs.stat(keepDisk);
    targetStat = await fs.stat(targetDisk);
  } catch (err) {
    const notFoundErr = new Error('Target or keep file does not exist');
    notFoundErr.statusCode = 404;
    throw notFoundErr;
  }

  if (!keepStat.isFile() || !targetStat.isFile()) {
    const err = new Error('Target and keep paths must be regular files');
    err.statusCode = 400;
    throw err;
  }

  const freed_bytes = targetStat.size;

  if (action === 'delete') {
    await fs.unlink(targetDisk);
  } else if (action === 'hardlink') {
    if (keepDisk !== targetDisk) {
      await fs.unlink(targetDisk);
      await fs.link(keepDisk, targetDisk);
    }
  }

  return {
    success: true,
    action,
    keepPath,
    targetPath,
    freed_bytes
  };
}

module.exports = {
  scanDuplicates,
  deduplicateFile,
  resolveSafePath
};
