const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const {
  createFileShare, getFileSharesByOwner, getFileSharesForSharee, deleteFileShare,
  createPublicShare, getPublicSharesByUser, deletePublicShare
} = require('../db');

// Require session authentication for all link creation operations
router.use(requireAuth);

// ── INTERNAL SHARING (#14) ───────────────────────────────────────────────────

router.post('/internal', async (req, res) => {
  try {
    const ownerUserId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    if (!ownerUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { sharee_username, file_path, read_write = 0, is_directory = 0 } = req.body;
    if (!sharee_username || !file_path) {
      return res.status(400).json({ error: 'sharee_username and file_path are required' });
    }

    const shareeUser = await require('../db').get(
      'SELECT id, username, display_name FROM users WHERE username = ? OR display_name = ? OR id = ?',
      [sharee_username, sharee_username, sharee_username]
    );

    if (!shareeUser) {
      return res.status(404).json({ error: `Target user "${sharee_username}" not found` });
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

router.get('/internal/my-shares', async (req, res) => {
  try {
    const ownerUserId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shares = await getFileSharesByOwner(ownerUserId);
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/internal/shared-with-me', async (req, res) => {
  try {
    const shareeUserId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shares = await getFileSharesForSharee(shareeUserId);
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/internal/:id', async (req, res) => {
  try {
    const ownerUserId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shareId = req.params.id;
    const deleted = await deleteFileShare(shareId, ownerUserId);
    if (!deleted) {
      return res.status(404).json({ error: 'Share not found or permission denied' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUBLIC LINK SHARING (#15) ────────────────────────────────────────────────

router.post('/public', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { file_path, is_directory = 0, password, expires_at, max_downloads } = req.body;
    if (!file_path) return res.status(400).json({ error: 'file_path is required' });

    const token = crypto.randomBytes(12).toString('hex');
    let passwordHash = null;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const share = await createPublicShare(userId, token, file_path, is_directory, passwordHash, expires_at || null, max_downloads || null);

    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'fs-files.gryzia.de';
    const shareUrl = `${protocol}://${host}/s/${token}`;

    res.status(201).json({
      success: true,
      token,
      share_url: shareUrl,
      share
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/public/my-shares', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shares = await getPublicSharesByUser(userId);
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/public/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shareId = req.params.id;
    const deleted = await deletePublicShare(shareId, userId);
    if (!deleted) return res.status(404).json({ error: 'Public link not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
