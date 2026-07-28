const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const db = require('../db');

async function saveFileVersion(userRoot, userId, filePath, { author, comment } = {}) {
  if (!filePath) {
    throw new Error('filePath parameter is required');
  }

  const cleanPath = filePath.startsWith('/') ? filePath : '/' + filePath;
  const absPath = path.join(userRoot, cleanPath);

  try {
    await fs.access(absPath);
  } catch (err) {
    const error = new Error(`Target file not found: ${cleanPath}`);
    error.statusCode = 404;
    throw error;
  }

  const versionsDir = path.join(userRoot, '.versions');
  await fs.mkdir(versionsDir, { recursive: true });

  const stat = await fs.stat(absPath);
  const nextVer = await db.getNextVersionNumber(userId, cleanPath);
  const storageFilename = `${crypto.randomUUID()}_v${nextVer}`;
  const storagePath = path.join(versionsDir, storageFilename);

  await fs.copyFile(absPath, storagePath);

  const versionRecord = await db.createFileVersion(
    userId,
    cleanPath,
    nextVer,
    storageFilename,
    stat.size,
    author || userId,
    comment || null
  );

  return versionRecord;
}

async function rollbackFileVersion(userRoot, userId, { filePath, versionId, versionNumber } = {}) {
  let versionRecord = null;

  if (versionId) {
    versionRecord = await db.getFileVersionById(versionId, userId);
  } else if (filePath && versionNumber) {
    const cleanPath = filePath.startsWith('/') ? filePath : '/' + filePath;
    const versions = await db.getFileVersions(userId, cleanPath);
    versionRecord = versions.find(v => Number(v.version_number) === Number(versionNumber));
  }

  if (!versionRecord) {
    const err = new Error('Version not found');
    err.statusCode = 404;
    throw err;
  }

  const storageFilePath = path.join(userRoot, '.versions', versionRecord.storage_path);
  try {
    await fs.access(storageFilePath);
  } catch (err) {
    const error = new Error('Stored version backup file missing on disk');
    error.statusCode = 404;
    throw error;
  }

  const targetPath = path.join(userRoot, versionRecord.file_path);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(storageFilePath, targetPath);

  return {
    success: true,
    message: `File ${versionRecord.file_path} rolled back to version ${versionRecord.version_number}`,
    version: versionRecord
  };
}

module.exports = {
  saveFileVersion,
  rollbackFileVersion
};
