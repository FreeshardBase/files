'use strict';

/**
 * Migration Wizard — Bidirectional Cloud Migration (#45)
 *
 * Provides:
 *   dryRun(opts)            – enumerate files without moving them
 *   executeMigration(opts)  – copy/move files with per-item progress callbacks
 *                            and soft-rollback (source preserved on write failure)
 */

/**
 * dryRun({ srcProvider, srcPath, dstPath, direction? })
 *
 * Enumerate items from srcProvider.list() and return a migration plan
 * without touching the destination.
 *
 * @param {object} opts
 * @param {{ list: (path: string) => Promise<Array<{path:string, size:number}>> }} opts.srcProvider
 * @param {string} opts.srcPath   - Root path to enumerate on source
 * @param {string} opts.dstPath   - Target root on destination (unused during dry-run)
 * @param {'local_to_cloud'|'cloud_to_local'} [opts.direction='local_to_cloud']
 * @returns {Promise<{direction, items, totalBytes, totalFiles, isDryRun, moved}>}
 */
async function dryRun({ srcProvider, srcPath = '/', dstPath = '/', direction = 'local_to_cloud' }) {
  const items = await srcProvider.list(srcPath);
  const totalBytes = items.reduce((sum, f) => sum + (f.size || 0), 0);
  return {
    direction,
    items,
    totalFiles: items.length,
    totalBytes,
    isDryRun: true,
    moved: 0,        // dry-run never touches destination
  };
}

/**
 * executeMigration({ srcProvider, dstProvider, items, operation, onProgress })
 *
 * Executes the migration plan item by item:
 *   - 'copy': reads from src, writes to dst; src untouched
 *   - 'move': reads from src, writes to dst; src deleted ONLY on success
 *             (soft-rollback: source preserved if write throws)
 *
 * @param {object} opts
 * @param {{ read: (path:string) => Promise<{stream, size}>, delete?: (path:string) => Promise<any> }} opts.srcProvider
 * @param {{ write: (path:string, stream) => Promise<{path,size}> }} opts.dstProvider
 * @param {Array<{path:string, size:number}>} opts.items
 * @param {'copy'|'move'} [opts.operation='copy']
 * @param {(progress: {done:number, total:number, currentPath:string}) => void} [opts.onProgress]
 * @returns {Promise<{completed:number, failed:number, errors:Array<{path,error}>}>}
 */
async function executeMigration({ srcProvider, dstProvider, items, operation = 'copy', onProgress = () => {} }) {
  let completed = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress({ done: i, total: items.length, currentPath: item.path });

    try {
      const readResult = await srcProvider.read(item.path);
      // Write to destination — may throw
      await dstProvider.write(item.path, readResult.stream);

      // Only delete source for 'move' after confirmed write success
      if (operation === 'move' && srcProvider.delete) {
        await srcProvider.delete(item.path);
      }
      completed++;
    } catch (err) {
      // Soft-rollback: do NOT delete source on any failure
      failed++;
      errors.push({ path: item.path, error: err.message });
    }
  }

  onProgress({ done: items.length, total: items.length, currentPath: null });

  return { completed, failed, errors };
}

module.exports = { dryRun, executeMigration };

// ── Issue #45: Bidirectional Cloud Migration & Soft Migration Wizard ──────────

const CLOUD_PROVIDER_TYPES = new Set(['s3', 'dropbox', 'gdrive', 'onedrive', 'wasabi', 'minio', 'webdav']);

/**
 * Classify migration direction from provider type strings.
 * @param {string} src
 * @param {string} dst
 * @returns {'local_to_cloud'|'cloud_to_local'|'cloud_to_cloud'|'local_to_local'}
 */
function classifyDirection(src, dst) {
  const srcCloud = CLOUD_PROVIDER_TYPES.has(src);
  const dstCloud = CLOUD_PROVIDER_TYPES.has(dst);
  if (!srcCloud && dstCloud) return 'local_to_cloud';
  if (srcCloud && !dstCloud) return 'cloud_to_local';
  if (srcCloud && dstCloud) return 'cloud_to_cloud';
  return 'local_to_local';
}

/**
 * Plan a migration: validate inputs, estimate totals, classify direction.
 *
 * @param {Object} opts
 * @param {Array<{path: string, size: number}>} opts.items  — files to migrate
 * @param {string} opts.srcProviderType                     — 'local', 's3', 'dropbox', …
 * @param {string} opts.dstProviderType
 * @param {string} [opts.srcPath]
 * @param {string} [opts.dstPath]
 * @returns {Promise<{itemCount, totalBytes, items, srcProviderType, dstProviderType, direction}>}
 */
async function planMigration({ items, srcProviderType, dstProviderType, srcPath, dstPath }) {
  if (!items || !Array.isArray(items)) throw new Error('items must be an array');
  if (!srcProviderType || !dstProviderType) throw new Error('srcProviderType and dstProviderType are required');

  // Guard: same provider type AND same root path = meaningless migration
  if (srcProviderType === dstProviderType && srcPath && dstPath && srcPath === dstPath) {
    throw new Error('source and destination must differ: same provider type and path');
  }

  const totalBytes = items.reduce((sum, f) => sum + (f.size || 0), 0);
  const direction = classifyDirection(srcProviderType, dstProviderType);

  return {
    itemCount: items.length,
    totalBytes,
    items,
    srcProviderType,
    dstProviderType,
    srcPath: srcPath || null,
    dstPath: dstPath || null,
    direction
  };
}

/**
 * Execute one file migration step atomically.
 * Source is deleted ONLY after a confirmed successful write (move semantics).
 * If write fails, source is preserved and result carries the error.
 *
 * @param {Object} opts
 * @param {{path: string, size: number}} opts.item
 * @param {{read: Function, delete?: Function}} opts.srcProvider
 * @param {{write: Function}} opts.dstProvider
 * @param {'copy'|'move'} [opts.operation='copy']
 * @param {Function} [opts.onProgress]   — called with {path, bytesTransferred, status}
 * @returns {Promise<{status:'completed'|'failed', path:string, bytesTransferred?:number, error?:string}>}
 */
async function executeMigrationStep({ item, srcProvider, dstProvider, operation = 'copy', onProgress }) {
  const { path: filePath, size = 0 } = item;

  let readResult;
  try {
    readResult = await srcProvider.read(filePath);
  } catch (readErr) {
    return { status: 'failed', path: filePath, error: readErr.message };
  }

  let writeResult;
  try {
    writeResult = await dstProvider.write(filePath, readResult.stream);
  } catch (writeErr) {
    // Write failed — source MUST NOT be deleted (rollback-safe)
    return { status: 'failed', path: filePath, error: writeErr.message };
  }

  const bytesTransferred = (writeResult && writeResult.size != null) ? writeResult.size : size;

  // Only delete source after confirmed write success (move semantics)
  if (operation === 'move' && typeof srcProvider.delete === 'function') {
    await srcProvider.delete(filePath);
  }

  if (typeof onProgress === 'function') {
    onProgress({ path: filePath, bytesTransferred, status: 'completed' });
  }

  return { status: 'completed', path: filePath, bytesTransferred };
}

Object.assign(module.exports, { planMigration, executeMigrationStep, classifyDirection });
