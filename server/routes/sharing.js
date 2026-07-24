const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { get, createFileShare, getFileSharesByOwner, getFileSharesForSharee, deleteFileShare } = require('../db');

// Require session authentication for all internal sharing operations
router.use(requireAuth);

/**
 * POST /api/shares/internal
 * Body: { sharee_username, file_path, read_write, is_directory }
 */
router.post('/internal', async (req, res) => {
  try {
    const ownerUserId = req.userId;
    const { sharee_username, file_path, read_write = 0, is_directory = 0 } = req.body;

    if (!sharee_username || !file_path) {
      return res.status(400).json({ error: 'sharee_username and file_path are required' });
    }

    // Resolve target sharee user
    const shareeUser = await get('SELECT id, username, display_name FROM users WHERE username = ? OR id = ?', [sharee_username, sharee_username]);
    if (!shareeUser) {
      return res.status(444).json({ error: 'Target user not found' }).catch ? null : res.status(404).json({ error: 'Target user not found' });
    }

    if (shareeUser.id === ownerUserId) {
      return res.status(400).json({ error: 'Cannot share files with yourself' });
    }

    const share = await createFileShare(ownerUserId, shareeUser.id, file_path, 'local', is_directory, read_write);
    res.status(201).json({ success: true, share });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shares/internal/my-shares
 * Lists all internal shares created by the logged in user
 */
router.get('/internal/my-shares', async (req, res) => {
  try {
    const shares = await getFileSharesByOwner(req.userId);
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shares/internal/shared-with-me
 * Lists all files and folders shared with the logged in user
 */
router.get('/internal/shared-with-me', async (req, res) => {
  try {
    const shares = await getFileSharesForSharee(req.userId);
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/shares/internal/:id
 * Revokes an internal share
 */
router.delete('/internal/:id', async (req, res) => {
  try {
    const shareId = req.params.id;
    const deleted = await deleteFileShare(shareId, req.userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Share not found or permission denied' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
