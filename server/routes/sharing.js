const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const {
  createFileShare, getFileSharesByOwner, getFileSharesByPath, getFileSharesForSharee, deleteFileShare,
  createPublicShare, updatePublicShare, getPublicSharesByUser, getPublicSharesByPath, deletePublicShare, logActivity
} = require('../db');

// Require session authentication for all link creation operations
router.use(requireAuth);

// ── OVERVIEW & ITEM DETAILS (#52) ─────────────────────────────────────────────

router.get('/overview', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const filePath = req.query.path;

    if (!filePath) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const internalShares = await getFileSharesByPath(userId, filePath);
    const publicShares = await getPublicSharesByPath(userId, filePath);

    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'fs-files.gryzia.de';

    const formattedPublicShares = publicShares.map(share => ({
      ...share,
      password_protected: !!share.password_hash,
      share_url: `${protocol}://${host}/s/${share.token}`
    }));

    res.json({
      file_path: filePath,
      internal_shares: internalShares,
      public_shares: formattedPublicShares
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INTERNAL SHARING (#14, #22) ──────────────────────────────────────────────

router.post('/internal', async (req, res) => {
  try {
    const ownerUserId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    if (!ownerUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { sharee_username, file_path, read_write = 0, is_directory = 0, provider_type = 'local', provider_connection_id = null } = req.body;
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

    const share = await createFileShare(ownerUserId, shareeUser.id, file_path, provider_type, is_directory, read_write, provider_connection_id);
    await logActivity(ownerUserId, 'share_internal', file_path, path.basename(file_path), is_directory, JSON.stringify({ sharee: shareeUser.username, provider_type }));

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

// ── PUBLIC LINK SHARING (#15, #22, #53) ──────────────────────────────────────

router.post('/public', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { file_path, is_directory = 0, password, expires_at, max_downloads, label, provider_type = 'local', provider_connection_id = null } = req.body;
    if (!file_path) return res.status(400).json({ error: 'file_path is required' });

    const token = crypto.randomBytes(12).toString('hex');
    let passwordHash = null;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const share = await createPublicShare(userId, token, file_path, is_directory, passwordHash, expires_at || null, max_downloads || null, label || null, provider_type, provider_connection_id);

    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'fs-files.gryzia.de';
    const shareUrl = `${protocol}://${host}/s/${token}`;

    await logActivity(userId, 'share_public', file_path, path.basename(file_path), is_directory, JSON.stringify({ token, label }));

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

router.patch('/public/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const shareId = req.params.id;
    const { label, password, expires_at, max_downloads, remove_password } = req.body;

    let passwordHash = undefined;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    const updatedShare = await updatePublicShare(shareId, userId, {
      label,
      passwordHash,
      expiresAt: expires_at,
      maxDownloads: max_downloads,
      clearPassword: !!remove_password
    });

    if (!updatedShare) {
      return res.status(404).json({ error: 'Public link not found or permission denied' });
    }

    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'fs-files.gryzia.de';

    res.json({
      success: true,
      share: {
        ...updatedShare,
        password_protected: !!updatedShare.password_hash,
        share_url: `${protocol}://${host}/s/${updatedShare.token}`
      }
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
