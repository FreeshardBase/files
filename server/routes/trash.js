const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const {
  createTrashItem, getTrashItemsByUser, getTrashItemById, deleteTrashItem, emptyTrash
} = require('../db');
const LocalProvider = require('../providers/local');

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
 * GET /api/trash
 * List all items in trash for current user (#18)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const items = await getTrashItemsByUser(userId);
    res.json({ items });
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

    const provider = new LocalProvider({ userRoot: getUserRoot(userId) });
    const meta = await provider.metadata(target_path);

    const trashDir = getUserTrashDir(userId);
    await fs.mkdir(trashDir, { recursive: true });

    const trashId = crypto.randomUUID();
    const trashPathOnDisk = path.join(trashDir, trashId);
    const sourcePathOnDisk = provider._safe(target_path);

    // Move file/folder on disk into .trash/<uuid>
    await fs.rename(sourcePathOnDisk, trashPathOnDisk);

    const item = await createTrashItem(
      trashId,
      userId,
      target_path,
      path.basename(target_path),
      meta.isDirectory ? 1 : 0,
      meta.size || 0,
      30
    );

    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trash/:id/restore
 * Restore file/folder from trash back to original path (#18)
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

    res.json({ success: true, original_path: item.original_path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trash/:id
 * Permanently delete a single item from trash (#18)
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const trashId = req.params.id;

    const item = await getTrashItemById(trashId, userId);
    if (!item) {
      return res.status(404).json({ error: 'Trash item not found' });
    }

    const trashPathOnDisk = path.join(getUserTrashDir(userId), item.id);
    await fs.rm(trashPathOnDisk, { recursive: true, force: true });
    await deleteTrashItem(trashId, userId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/trash
 * Empty entire trash for user (#18)
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

    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
