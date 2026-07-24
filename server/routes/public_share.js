const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { getPublicShareByToken, incrementPublicShareDownloads } = require('../db');
const LocalProvider = require('../providers/local');

function getOwnerUserRoot(ownerUserId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', ownerUserId);
}

/**
 * Validates whether a public share link has expired or reached download limits
 */
function validatePublicShareAccess(share) {
  if (!share) {
    return { valid: false, status: 404, error: 'Share link not found' };
  }

  if (share.expires_at) {
    const expiry = new Date(share.expires_at);
    if (!isNaN(expiry.getTime()) && new Date() > expiry) {
      return { valid: false, status: 410, error: 'This share link has expired' };
    }
  }

  if (share.max_downloads && share.download_count >= share.max_downloads) {
    return { valid: false, status: 410, error: 'Maximum download limit reached for this link' };
  }

  return { valid: true };
}

/**
 * Check password authorization for protected share links
 */
function isShareUnlocked(req, token) {
  return req.session && req.session.unlockedShares && req.session.unlockedShares[token] === true;
}

// GET /s/:token — Metadata / Public View Endpoint
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const share = await getPublicShareByToken(token);
    const validation = validatePublicShareAccess(share);
    if (!validation.valid) {
      return res.status(validation.status).json({ error: validation.error });
    }

    const isProtected = !!share.password_hash;
    const unlocked = isProtected ? isShareUnlocked(req, token) : true;

    const baseName = path.basename(share.file_path);

    res.json({
      token: share.token,
      name: baseName,
      isDirectory: !!share.is_directory,
      owner: share.owner_display_name || share.owner_username,
      protected: isProtected,
      unlocked,
      expiresAt: share.expires_at,
      maxDownloads: share.max_downloads,
      downloadCount: share.download_count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /s/:token/verify — Verify Password for Protected Share
router.post('/:token/verify', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    const share = await getPublicShareByToken(token);

    const validation = validatePublicShareAccess(share);
    if (!validation.valid) {
      return res.status(validation.status).json({ error: validation.error });
    }

    if (!share.password_hash) {
      return res.json({ success: true });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const match = await bcrypt.compare(password.trim(), share.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    if (!req.session.unlockedShares) req.session.unlockedShares = {};
    req.session.unlockedShares[token] = true;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /s/:token/download — Direct Download Endpoint for File or Directory Zip
router.get('/:token/download', async (req, res) => {
  try {
    const { token } = req.params;
    const share = await getPublicShareByToken(token);

    const validation = validatePublicShareAccess(share);
    if (!validation.valid) {
      return res.status(validation.status).json({ error: validation.error });
    }

    if (share.password_hash && !isShareUnlocked(req, token)) {
      return res.status(401).json({ error: 'Password required to download this share' });
    }

    const userRoot = getOwnerUserRoot(share.user_id);
    const provider = new LocalProvider({ userRoot });

    await incrementPublicShareDownloads(share.id);

    const baseName = path.basename(share.file_path);
    const encodedName = encodeURIComponent(baseName).replace(/['()]/g, escape).replace(/\*/g, '%2A');

    if (share.is_directory) {
      const fullDirPath = provider._safe(share.file_path);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"; filename*=UTF-8''${encodedName}.zip`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);
      archive.directory(fullDirPath, baseName);
      await archive.finalize();
    } else {
      const { stream, size, mimeType } = await provider.read(share.file_path);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}"; filename*=UTF-8''${encodedName}`);
      stream.pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
