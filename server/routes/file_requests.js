const express = require('express');
const router = express.Router();
const path = require('path');
const Busboy = require('busboy');
const { Readable } = require('stream');
const db = require('../db');
const LocalProvider = require('../providers/local');
const { decodeUtf8Filename } = require('../utils/utf8');
const { scanBuffer } = require('../utils/malware_scanner');
const { dispatchWebhookEvent } = require('../utils/webhook_dispatcher');

function getOwnerUserRoot(ownerUserId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', ownerUserId);
}

function getUserIdFromReq(req) {
  return req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
}

// ── Authenticated Management Endpoints ─────────────────────────────────────

// POST /api/file-requests — Create new file request link
router.post('/', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { target_folder, title, description, expires_at, max_uploads, token } = req.body;
    const request = await db.createFileRequest(userId, {
      target_folder,
      title,
      description,
      expires_at,
      max_uploads,
      token
    });

    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/file-requests — List file requests for logged in user
router.get('/', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const requests = await db.getFileRequestsByUser(userId);
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file-requests/:id — Delete/Revoke a file request link
router.delete('/:id', async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const deleted = await db.deleteFileRequest(userId, id);

    if (!deleted) {
      return res.status(404).json({ error: 'File request not found' });
    }

    res.json({ success: true, message: 'File request deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public File Request Portal Endpoints ───────────────────────────────────

// GET /api/public/request/:token or GET /api/public/upload/:token — View portal details
router.get('/request/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const request = await db.getFileRequestByToken(token);

    if (!request) {
      return res.status(404).json({ error: 'File request link not found' });
    }

    if (request.expires_at) {
      const expiry = new Date(request.expires_at);
      if (!isNaN(expiry.getTime()) && new Date() > expiry) {
        return res.status(410).json({ error: 'File request link has expired' });
      }
    }

    if (request.max_uploads && request.upload_count >= request.max_uploads) {
      return res.status(410).json({ error: 'Maximum upload limit reached for this file request link' });
    }

    res.json({
      success: true,
      request: {
        token: request.token,
        title: request.title,
        description: request.description,
        targetFolder: request.target_folder,
        owner: request.owner_display_name || request.owner_username,
        expiresAt: request.expires_at,
        maxUploads: request.max_uploads,
        uploadCount: request.upload_count
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET fallback for /upload/:token
router.get('/upload/:token', async (req, res) => {
  res.redirect(`/api/public/request/${req.params.token}`);
});

// POST /api/public/upload/:token — Anonymous File Upload
router.post('/upload/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const fileReq = await db.getFileRequestByToken(token);

    if (!fileReq) {
      return res.status(404).json({ error: 'File request link not found' });
    }

    if (fileReq.expires_at) {
      const expiry = new Date(fileReq.expires_at);
      if (!isNaN(expiry.getTime()) && new Date() > expiry) {
        return res.status(410).json({ error: 'File request link has expired' });
      }
    }

    if (fileReq.max_uploads && fileReq.upload_count >= fileReq.max_uploads) {
      return res.status(410).json({ error: 'Maximum upload limit reached for this file request link' });
    }

    const ownerRoot = getOwnerUserRoot(fileReq.user_id);
    const provider = new LocalProvider({ userRoot: ownerRoot });

    const contentType = req.headers['content-type'] || '';

    // Handle Multipart Form Data
    if (contentType.includes('multipart/form-data')) {
      const busboy = Busboy({ headers: req.headers });

      busboy.on('file', async (fieldname, fileStream, info) => {
        const filename = decodeUtf8Filename(info.filename || 'uploaded_file');
        const destinationPath = path.posix.join(fileReq.target_folder || '/', filename);

        try {
          const chunks = [];
          for await (const chunk of fileStream) {
            chunks.push(chunk);
          }
          const fullBuffer = Buffer.concat(chunks);

          const scanResult = scanBuffer(fullBuffer);
          if (scanResult.infected) {
            return res.status(422).json({
              success: false,
              error: `Malware detected: ${scanResult.threat}`,
              threat: scanResult.threat
            });
          }

          const streamToSave = Readable.from(fullBuffer);
          const result = await provider.write(destinationPath, streamToSave);
          await db.incrementFileRequestUploads(fileReq.id);
          await db.logActivity(fileReq.user_id, 'public_upload', destinationPath, filename, 0).catch(() => {});
          await dispatchWebhookEvent(fileReq.user_id, 'file_created', { path: destinationPath, type: 'file' }).catch(() => {});

          res.status(201).json({ success: true, message: 'File uploaded successfully', filename, path: destinationPath, file: result });
        } catch (err) {
          if (err.message && err.message.includes('Path traversal blocked')) {
            return res.status(403).json({ error: err.message });
          }
          res.status(500).json({ error: err.message });
        }
      });

      busboy.on('error', (err) => {
        res.status(500).json({ error: err.message });
      });

      req.pipe(busboy);
      return;
    }

    // Handle JSON / Buffer Body Uploads
    if (req.body && req.body.filename) {
      const filename = decodeUtf8Filename(req.body.filename);
      const destinationPath = path.posix.join(fileReq.target_folder || '/', filename);
      const fileBuffer = Buffer.isBuffer(req.body.content)
        ? req.body.content
        : Buffer.from(req.body.content || '', 'utf8');

      const scanResult = scanBuffer(fileBuffer);
      if (scanResult.infected) {
        return res.status(422).json({
          success: false,
          error: `Malware detected: ${scanResult.threat}`,
          threat: scanResult.threat
        });
      }

      const streamToSave = Readable.from(fileBuffer);
      const result = await provider.write(destinationPath, streamToSave);
      await db.incrementFileRequestUploads(fileReq.id);
      await db.logActivity(fileReq.user_id, 'public_upload', destinationPath, filename, 0).catch(() => {});
      await dispatchWebhookEvent(fileReq.user_id, 'file_created', { path: destinationPath, type: 'file' }).catch(() => {});

      return res.status(201).json({ success: true, message: 'File uploaded successfully', filename, path: destinationPath, file: result });
    }

    return res.status(400).json({ error: 'No file provided in request body or multipart form data' });
  } catch (err) {
    if (err.message && err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
