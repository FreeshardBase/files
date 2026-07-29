const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const mime = require('mime-types');
const { requireAuth } = require('../middleware/auth');
const {
  createTrashItem, getTrashItemsByUser, getTrashItemById, deleteTrashItem, emptyTrash, logActivity, checkActiveLegalHold
} = require('../db');
const LocalProvider = require('../providers/local');
const { dispatchWebhookEvent } = require('../utils/webhook_dispatcher');

router.use(requireAuth);

function getUserTrashDir(userId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', userId, '.trash');
}

function getUserRoot(userId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', userId);
}

/**
 * Calculates total recursive directory size on disk
 */
async function getDirectorySize(dirOnDisk) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirOnDisk, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirOnDisk, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  } catch (e) {}
  return total;
}

/**
 * GET /api/trash
 * List all top-level items in trash for current user (#18)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const items = await getTrashItemsByUser(userId);

    // Dynamically resolve size if 0 B for directories (#18)
    const trashDir = getUserTrashDir(userId);
    for (const item of items) {
      if (item.is_directory && item.size_bytes === 0) {
        const diskPath = path.join(trashDir, item.id);
        item.size_bytes = await getDirectorySize(diskPath);
      }
    }

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trash/inspect?id=<trashId>&subpath=/
 * Browse/inspect contents inside a trashed directory (#18)
 */
router.get('/inspect', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const trashId = req.query.id;
    const subpath = req.query.subpath || '/';

    if (!trashId) {
      return res.status(400).json({ error: 'id query parameter is required' });
    }

    const item = await getTrashItemById(trashId, userId);
    if (!item) {
      return res.status(404).json({ error: 'Trash item not found' });
    }

    const baseTrashItemDiskPath = path.join(getUserTrashDir(userId), item.id);
    const targetSubPathOnDisk = path.join(baseTrashItemDiskPath, subpath);

    // Prevent directory traversal out of the trashed item
    if (!targetSubPathOnDisk.startsWith(baseTrashItemDiskPath)) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    const entries = await fs.readdir(targetSubPathOnDisk, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const fullPath = path.join(targetSubPathOnDisk, entry.name);
      const stat = await fs.stat(fullPath);
      const isDir = entry.isDirectory();
      const itemSubpath = path.join(subpath, entry.name);
      const size = isDir ? await getDirectorySize(fullPath) : stat.size;

      items.push({
        name: entry.name,
        path: path.join(item.original_path, itemSubpath),
        subpath: itemSubpath,
        isDirectory: isDir,
        size,
        modified: stat.mtime ? stat.mtime.toISOString() : null,
        mimeType: isDir ? null : (mime.lookup(entry.name) || 'application/octet-stream')
      });
    }

    res.json({
      id: item.id,
      original_name: item.original_name,
      original_path: item.original_path,
      subpath,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trash/move
 * Soft-delete: Move file/folder to user's isolated .trash/ directory (#18)
 */
router.post('/move', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { target_path } = req.body;

    if (!target_path) {
      return res.status(400).json({ error: 'target_path is required' });
    }

    const activeHold = await checkActiveLegalHold(userId, target_path);
    if (activeHold) {
      return res.status(403).json({ error: `File '${target_path}' is under active legal hold and cannot be deleted` });
    }

    const provider = new LocalProvider({ userRoot: getUserRoot(userId) });
    const meta = await provider.metadata(target_path);

    const trashDir = getUserTrashDir(userId);
    await fs.mkdir(trashDir, { recursive: true });

    const trashId = crypto.randomUUID();
    const trashPathOnDisk = path.join(trashDir, trashId);
    const sourcePathOnDisk = provider._safe(target_path);

    // Move file/folder on disk into .trash/<uuid>
    await fs.rename(sourcePathOnDisk, trashPathOnDisk);

    // Calculate recursive directory size if it is a directory
    const sizeBytes = meta.isDirectory ? await getDirectorySize(trashPathOnDisk) : (meta.size || 0);

    const item = await createTrashItem(
      trashId,
      userId,
      target_path,
      path.basename(target_path),
      meta.isDirectory ? 1 : 0,
      sizeBytes,
      30
    );

    await logActivity(userId, 'delete', target_path, path.basename(target_path), meta.isDirectory ? 1 : 0);
    await dispatchWebhookEvent(userId, 'file_deleted', { path: target_path, trashed: true }).catch(() => {});

    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trash/:id/restore
 * Restore file/folder from trash back to original path (#18, #22)
 */
router.post('/:id/restore', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const trashId = req.params.id;

    const item = await getTrashItemById(trashId, userId);
    if (!item) {
      return res.status(404).json({ error: 'Trash item not found' });
    }

    const provider = new LocalProvider({ userRoot: getUserRoot(userId) });
    const targetPathOnDisk = provider._safe(item.original_path);
    const trashPathOnDisk = path.join(getUserTrashDir(userId), item.id);

    // Recreate parent directories if missing
    await fs.mkdir(path.dirname(targetPathOnDisk), { recursive: true });

    // Move from .trash/<uuid> back to original location
    await fs.rename(trashPathOnDisk, targetPathOnDisk);
    await deleteTrashItem(trashId, userId);
    await logActivity(userId, 'restore', item.original_path, item.original_name, item.is_directory);

    res.json({ success: true, original_path: item.original_path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trash/:id
 * Permanently delete a single item from trash (#18, #22)
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const trashId = req.params.id;

    const item = await getTrashItemById(trashId, userId);
    if (!item) {
      return res.status(404).json({ error: 'Trash item not found' });
    }

    const activeHold = await checkActiveLegalHold(userId, item.original_path);
    if (activeHold) {
      return res.status(403).json({ error: `File '${item.original_path}' is under active legal hold and cannot be deleted` });
    }

    const trashPathOnDisk = path.join(getUserTrashDir(userId), item.id);
    await fs.rm(trashPathOnDisk, { recursive: true, force: true });
    await deleteTrashItem(trashId, userId);
    await logActivity(userId, 'delete_permanent', item.original_path, item.original_name, item.is_directory);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trash
 * Empty entire trash for user (#18, #22)
 */
router.delete('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const items = await emptyTrash(userId);

    const trashDir = getUserTrashDir(userId);
    for (const item of items) {
      const diskPath = path.join(trashDir, item.id);
      await fs.rm(diskPath, { recursive: true, force: true });
    }

    await logActivity(userId, 'empty_trash', '/.trash', 'Trash', 1, JSON.stringify({ count: items.length }));

    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
