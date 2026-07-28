const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const { getPublicShareByToken, incrementPublicShareDownloads } = require('../db');
const LocalProvider = require('../providers/local');

function getOwnerUserRoot(ownerUserId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', ownerUserId);
}

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

function isShareUnlocked(req, token) {
  return req.session && req.session.unlockedShares && req.session.unlockedShares[token] === true;
}

function renderPublicSharePage(token, share, validation, isProtected, unlocked) {
  const baseName = share ? path.basename(share.file_path) : 'Shared Item';
  const owner = share ? (share.owner_display_name || share.owner_username) : 'FreeShard User';
  const ext = share ? baseName.split('.').pop().toLowerCase() : '';
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext);
  const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
  const isAudio = ['mp3', 'wav', 'ogg', 'flac'].includes(ext);
  const isPdf = ext === 'pdf';

  let bodyContent = '';

  if (!validation.valid) {
    bodyContent = `
      <div class="fs-sheet" style="text-align: center; max-width: 440px; margin: 40px auto;">
        <span style="font-size: 3rem;">⚠️</span>
        <h2 style="margin-top: 1rem; color: var(--danger);">${validation.error}</h2>
        <p style="color: var(--ink-muted); margin-top: 0.5rem; font-size: 13px;">Please contact the person who created this link.</p>
      </div>
    `;
  } else if (isProtected && !unlocked) {
    bodyContent = `
      <div class="fs-sheet" style="max-width: 400px; margin: 40px auto;">
        <div style="text-align: center; margin-bottom: 1.5rem;">
          <span style="font-size: 2.5rem;">🔒</span>
          <h2 style="margin-top: 0.5rem; font-size: 18px;">Password Protected</h2>
          <p class="fs-mono" style="color: var(--ink-muted); font-size: 12px; margin-top: 4px;">Shared by ${owner}</p>
        </div>
        <form id="pwdForm" onsubmit="unlockShare(event, '${token}')">
          <div class="fs-field" style="max-width: 100%;">
            <label class="fs-label">Enter Password</label>
            <input type="password" id="inputPassword" class="fs-input" placeholder="Password" required>
          </div>
          <div id="errMsg" class="fs-field__error" style="display: none; margin-bottom: 1rem;"></div>
          <button type="submit" class="fs-btn fs-btn--primary" style="width: 100%; justify-content: center;">Unlock File</button>
        </form>
      </div>
    `;
  } else {
    let previewElement = '';
    if (isImage) {
      previewElement = `<div style="margin-bottom: 1.5rem;"><img src="/s/${token}/download?inline=1" alt="${baseName}" style="max-width: 100%; max-height: 420px; border-radius: var(--radius-sheet); border: var(--border-w) solid var(--border-cool); object-fit: contain;" /></div>`;
    } else if (isVideo) {
      previewElement = `<div style="margin-bottom: 1.5rem;"><video controls src="/s/${token}/download?inline=1" style="max-width: 100%; max-height: 400px; border-radius: var(--radius-sheet);"></video></div>`;
    } else if (isAudio) {
      previewElement = `<div style="margin-bottom: 1.5rem;"><audio controls src="/s/${token}/download?inline=1" style="width: 100%;"></audio></div>`;
    } else if (isPdf) {
      previewElement = `<div style="margin-bottom: 1.5rem;"><iframe src="/s/${token}/download?inline=1" style="width: 100%; height: 400px; border: var(--border-w) solid var(--border-cool); border-radius: var(--radius-sheet);"></iframe></div>`;
    } else {
      const icon = share.is_directory ? '📁' : '📄';
      previewElement = `<div style="margin-bottom: 1rem; font-size: 3.5rem;">${icon}</div>`;
    }

    bodyContent = `
      <div class="fs-sheet" style="text-align: center; max-width: 520px; margin: 40px auto;">
        ${previewElement}
        <h2 class="fs-mono" style="margin-top: 0.5rem; font-size: 18px; word-break: break-all;">${baseName}</h2>
        <p class="fs-mono" style="color: var(--ink-muted); font-size: 12px; margin-top: 4px; margin-bottom: 1.5rem;">Shared by ${owner}</p>
        
        <a href="/s/${token}/download" class="fs-btn fs-btn--primary" style="padding: 12px 24px; font-size: 14px; text-decoration: none; display: inline-flex;">
          ⬇️ Download ${share.is_directory ? 'Directory (.zip)' : 'File'}
        </a>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${baseName} — FreeShard Public Share</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css">
  <style>
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--bg); padding: 1.5rem; }
  </style>
</head>
<body>
  <div style="width: 100%; max-width: 560px;">
    <div style="text-align: center; margin-bottom: 1.5rem;">
      <div class="shard-badge" style="display: inline-flex;">
        <span class="shard-diamond">◆</span>
        <span class="shard-id fs-mono">FreeShard Public Share</span>
      </div>
    </div>
    ${bodyContent}
  </div>
  <script>
    async function unlockShare(e, token) {
      e.preventDefault();
      const pwd = document.getElementById('inputPassword').value;
      const errEl = document.getElementById('errMsg');
      errEl.style.display = 'none';

      try {
        const res = await fetch('/s/' + token + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.reload();
        } else {
          errEl.textContent = data.error || 'Incorrect password';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.textContent = 'Error verifying password';
        errEl.style.display = 'block';
      }
    }
  </script>
</body>
</html>`;
}

// GET /s/:token — Main Public Share View (HTML Page or JSON metadata)
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const share = await getPublicShareByToken(token);
    const validation = validatePublicShareAccess(share);

    const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
    const isProtected = share ? !!share.password_hash : false;
    const unlocked = isProtected ? isShareUnlocked(req, token) : true;

    if (acceptsJson) {
      if (!validation.valid) {
        return res.status(validation.status).json({ error: validation.error });
      }
      return res.json({
        token: share.token,
        name: path.basename(share.file_path),
        isDirectory: !!share.is_directory,
        owner: share.owner_display_name || share.owner_username,
        protected: isProtected,
        unlocked,
        expiresAt: share.expires_at,
        maxDownloads: share.max_downloads,
        downloadCount: share.download_count
      });
    }

    const html = renderPublicSharePage(token, share, validation, isProtected, unlocked);
    res.status(validation.valid ? 200 : validation.status).send(html);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// POST /s/:token/verify — Verify Password
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

async function getProviderForShare(share) {
  if (!share.provider_type || share.provider_type === 'local' || !share.provider_connection_id) {
    const userRoot = getOwnerUserRoot(share.user_id);
    return new LocalProvider({ userRoot });
  }

  const { getProviderConnections } = require('../db');
  const GoogleDriveProvider = require('../providers/gdrive');
  const DropboxProvider = require('../providers/dropbox');

  const connections = await getProviderConnections(share.user_id);
  const conn = connections.find(c => c.id === parseInt(share.provider_connection_id, 10));

  if (!conn) {
    throw new Error('Associated cloud provider connection was deleted or is unavailable');
  }

  if (conn.provider_type === 'gdrive') {
    return new GoogleDriveProvider(conn.credentials);
  } else if (conn.provider_type === 'dropbox') {
    return new DropboxProvider(conn.credentials);
  }

  const userRoot = getOwnerUserRoot(share.user_id);
  return new LocalProvider({ userRoot });
}

// GET /s/:token/download — Direct Download Stream or Inline Media Preview
router.get('/:token/download', async (req, res) => {
  try {
    const { token } = req.params;
    const isInline = req.query.inline === '1';
    const share = await getPublicShareByToken(token);

    const validation = validatePublicShareAccess(share);
    if (!validation.valid) {
      return res.status(validation.status).send(validation.error);
    }

    if (share.password_hash && !isShareUnlocked(req, token)) {
      return res.status(401).send('Password required to download this share');
    }

    const provider = await getProviderForShare(share);

    // Only increment download counter for actual file downloads, not inline previews
    if (!isInline) {
      await incrementPublicShareDownloads(share.id);
    }

    const baseName = path.basename(share.file_path);
    const encodedName = encodeURIComponent(baseName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    const dispositionType = isInline ? 'inline' : 'attachment';

    if (share.is_directory) {
      let fullDirPath;
      if (typeof provider._safe === 'function') {
        fullDirPath = provider._safe(share.file_path);
      } else {
        const userRoot = getOwnerUserRoot(share.user_id);
        const local = new LocalProvider({ userRoot });
        fullDirPath = local._safe(share.file_path);
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${baseName}.zip"; filename*=UTF-8''${encodedName}.zip`);

      const archiverModule = await import('archiver');
      const archiver = archiverModule.default || archiverModule;
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(res);
      archive.directory(fullDirPath, baseName);
      await archive.finalize();
    } else {
      const { stream, size, mimeType } = await provider.read(share.file_path);
      const ext = baseName.split('.').pop().toLowerCase();
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext);
      const fallbackMime = isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';

      res.setHeader('Content-Type', mimeType || fallbackMime);
      if (size) res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${baseName}"; filename*=UTF-8''${encodedName}`);
      stream.pipe(res);
    }
  } catch (err) {
    res.status(500).send('Download Error: ' + err.message);
  }
});

module.exports = router;
