const path = require('path');
const fs = require('fs/promises');
const db = require('../db');

function getUserRoot(userId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', userId);
}

/**
 * Execute automated file synchronization job (#71)
 * @param {number} jobId - Sync job ID
 * @param {string} userId - User ID
 */
async function runSyncEngine(jobId, userId) {
  const job = await db.getSyncJobById(jobId, userId);
  if (!job) {
    throw new Error(`Sync job #${jobId} not found`);
  }

  await db.updateSyncJobStatus(jobId, { status: 'running' });

  try {
    const userRoot = getUserRoot(userId);
    const localAbs = path.join(userRoot, job.local_path.replace(/^\//, ''));
    const remoteAbs = path.join(userRoot, job.remote_path.replace(/^\//, ''));

    await fs.mkdir(localAbs, { recursive: true });
    await fs.mkdir(remoteAbs, { recursive: true });

    const localFiles = await fs.readdir(localAbs).catch(() => []);
    const remoteFiles = await fs.readdir(remoteAbs).catch(() => []);

    const localFileSet = new Set(localFiles);
    const remoteFileSet = new Set(remoteFiles);

    // Process files present in local directory
    for (const fileName of localFiles) {
      const localFilePath = path.join(localAbs, fileName);
      const localStat = await fs.stat(localFilePath).catch(() => null);
      if (!localStat || localStat.isDirectory()) continue;

      if (remoteFileSet.has(fileName)) {
        // Conflict handling
        const remoteFilePath = path.join(remoteAbs, fileName);
        const remoteStat = await fs.stat(remoteFilePath).catch(() => null);

        if (remoteStat && !remoteStat.isDirectory()) {
          const localContent = await fs.readFile(localFilePath);
          const remoteContent = await fs.readFile(remoteFilePath);

          if (!localContent.equals(remoteContent)) {
            if (job.conflict_strategy === 'keep_both') {
              const ext = path.extname(fileName);
              const base = path.basename(fileName, ext);
              const conflictFileName = `${base}_conflict${ext}`;

              await fs.writeFile(path.join(localAbs, conflictFileName), remoteContent);
              await fs.writeFile(path.join(remoteAbs, conflictFileName), localContent);
            } else {
              // Default: 'newer_wins'
              const localMtime = localStat.mtime.getTime();
              const remoteMtime = remoteStat.mtime.getTime();

              if (localMtime > remoteMtime) {
                await fs.writeFile(remoteFilePath, localContent);
              } else if (remoteMtime > localMtime) {
                await fs.writeFile(localFilePath, remoteContent);
              }
            }
          }
        }
      } else {
        // Only in local -> copy to remote
        const localContent = await fs.readFile(localFilePath);
        await fs.writeFile(path.join(remoteAbs, fileName), localContent);
      }
    }

    // Process files present only in remote directory
    for (const fileName of remoteFiles) {
      if (!localFileSet.has(fileName)) {
        const remoteFilePath = path.join(remoteAbs, fileName);
        const remoteStat = await fs.stat(remoteFilePath).catch(() => null);
        if (!remoteStat || remoteStat.isDirectory()) continue;

        const remoteContent = await fs.readFile(remoteFilePath);
        await fs.writeFile(path.join(localAbs, fileName), remoteContent);
      }
    }

    const now = new Date().toISOString();
    return await db.updateSyncJobStatus(jobId, {
      status: 'completed',
      lastSyncedAt: now
    });
  } catch (err) {
    await db.updateSyncJobStatus(jobId, {
      status: 'failed',
      error: err.message
    });
    throw err;
  }
}

module.exports = {
  runSyncEngine
};
