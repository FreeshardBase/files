const db = require('../db');
const { getProvider } = require('../providers');

/**
 * Helper to resolve active provider instance for a user connection ID
 */
async function resolveProviderInstance(connectionId, userId) {
  const connections = await db.getProviderConnections(userId);
  const conn = connections.find(c => c.id === parseInt(connectionId, 10));
  if (!conn) {
    throw new Error(`Provider connection #${connectionId} not found or permission denied`);
  }
  return getProvider(conn.provider_type, conn.credentials);
}

/**
 * Execute Cloud-to-Cloud Sync Job (Issue #93)
 * Stream files directly from source provider to destination provider
 */
async function runCloudSyncEngine(jobId, userId, options = {}) {
  const job = await db.getCloudSyncJobById(userId, jobId);
  if (!job) {
    throw new Error(`Cloud sync job #${jobId} not found`);
  }

  await db.updateCloudSyncJob(userId, jobId, { status: 'running', error_message: null });

  try {
    const srcProvider = options.srcProvider || await resolveProviderInstance(job.src_connection_id, userId);
    const dstProvider = options.dstProvider || await resolveProviderInstance(job.dst_connection_id, userId);

    let totalFiles = 0;
    let totalBytes = 0;

    // Check if src_path is a directory or single file
    let items = [];
    try {
      items = await srcProvider.list(job.src_path);
    } catch (e) {
      items = [];
    }

    if (items.length > 0) {
      // Sync directory items
      for (const item of items) {
        if (item.isDirectory) continue;
        const { stream, size, mimeType } = await srcProvider.read(item.path);
        const relPath = item.path.startsWith(job.src_path)
          ? item.path.substring(job.src_path.length).replace(/^\/+/, '')
          : item.name;
        const dstTarget = job.dst_path.endsWith('/') ? `${job.dst_path}${relPath}` : `${job.dst_path}/${relPath}`;
        await dstProvider.write(dstTarget, stream, { mimeType, size });
        totalFiles += 1;
        totalBytes += size || item.size || 0;
      }
    } else {
      // Single file sync
      const { stream, size, mimeType } = await srcProvider.read(job.src_path);
      await dstProvider.write(job.dst_path, stream, { mimeType, size });
      totalFiles = 1;
      totalBytes = size || 0;
    }

    const updatedJob = await db.updateCloudSyncJob(userId, jobId, {
      status: 'completed',
      transferred_files: totalFiles,
      transferred_bytes: totalBytes,
      last_run_at: new Date().toISOString(),
      error_message: null
    });

    return updatedJob;
  } catch (err) {
    const failedJob = await db.updateCloudSyncJob(userId, jobId, {
      status: 'failed',
      error_message: err.message
    });
    return failedJob;
  }
}

module.exports = {
  runCloudSyncEngine
};
