/**
 * Ecosystem Integration Routes (#62)
 * POST /api/ecosystem/ingest/paperless — ingest file into Paperless-ngx
 * POST /api/ecosystem/ingest/immich    — ingest file into Immich
 * GET  /api/ecosystem/ingest/logs      — retrieve ingest history for user
 *
 * Service URLs are configured via env vars:
 *   PAPERLESS_URL       e.g. http://paperless.freeshard.local
 *   PAPERLESS_API_TOKEN (optional — Bearer token for Paperless API)
 *   IMMICH_URL          e.g. http://immich.freeshard.local
 *   IMMICH_API_KEY      (required for Immich API)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

router.use(requireAuth);

/**
 * Resolve the absolute on-disk path for a user-relative file path,
 * enforcing path traversal protection.
 */
function resolveUserFilePath(userRoot, filePath) {
  const rel = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const abs = path.resolve(userRoot, rel);
  if (!abs.startsWith(path.resolve(userRoot))) {
    throw new Error('Path traversal blocked');
  }
  return abs;
}

/**
 * Minimal multipart/form-data body builder for uploading a file buffer.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(boundary, fieldName, fileName, mimeType, fileBuffer) {
  const crlf = '\r\n';
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"`,
    `Content-Type: ${mimeType}`,
    '',
    ''
  ].join(crlf);
  const footer = `${crlf}--${boundary}--${crlf}`;
  return Buffer.concat([
    Buffer.from(header),
    fileBuffer,
    Buffer.from(footer)
  ]);
}

/**
 * Guess MIME type from file extension (minimal subset relevant to Paperless/Immich).
 */
function guessMime(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.tiff': 'image/tiff',
    '.tif':  'image/tiff',
    '.txt':  'text/plain',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc':  'application/msword'
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * POST /api/ecosystem/ingest/paperless
 *
 * Body: { filePath: string }
 *
 * Reads the local file and POSTs it to the Paperless-ngx
 * `/api/documents/post_document/` endpoint as multipart/form-data.
 */
router.post('/ingest/paperless', async (req, res) => {
  const { filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) {
    return res.status(503).json({
      error: 'Paperless-ngx is not configured. Set PAPERLESS_URL in environment.'
    });
  }

  const userId = req.userId;
  const userRoot = req.userRoot || (() => {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    return path.join(dataDir, 'users', userId);
  })();

  try {
    const absPath = resolveUserFilePath(userRoot, filePath);
    const fileName = path.basename(absPath);
    const fileBuffer = await fs.readFile(absPath);
    const mimeType = guessMime(fileName);

    const boundary = `----FreeshardBoundary${Date.now()}`;
    const body = buildMultipart(boundary, 'document', fileName, mimeType, fileBuffer);

    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    };
    if (process.env.PAPERLESS_API_TOKEN) {
      headers['Authorization'] = `Token ${process.env.PAPERLESS_API_TOKEN}`;
    }

    const endpoint = `${paperlessUrl.replace(/\/$/, '')}/api/documents/post_document/`;
    const upstream = await fetch(endpoint, { method: 'POST', headers, body });

    let remoteId = null;
    let details = null;
    let status = 'success';

    if (upstream.ok) {
      try {
        const upBody = await upstream.json();
        remoteId = upBody.id !== undefined ? String(upBody.id) : null;
      } catch (_) {
        // Some Paperless versions return plain text task UUID
        const text = await upstream.text().catch(() => null);
        remoteId = text ? text.trim() : null;
      }
    } else {
      status = 'error';
      details = `Upstream HTTP ${upstream.status}`;
    }

    await db.createEcosystemIngestLog({ userId, filePath, fileName, target: 'paperless', status, remoteId, details });
    await db.logActivity(userId, 'ecosystem_ingest_paperless', filePath, fileName, 0, JSON.stringify({ remoteId, status }));

    if (status === 'error') {
      return res.status(502).json({ success: false, target: 'paperless', error: details });
    }

    res.json({ success: true, target: 'paperless', remoteId, fileName });
  } catch (err) {
    if (err.message.includes('Path traversal')) {
      return res.status(403).json({ error: err.message });
    }
    await db.createEcosystemIngestLog({
      userId, filePath, fileName: path.basename(filePath), target: 'paperless',
      status: 'error', remoteId: null, details: err.message
    }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ecosystem/ingest/immich
 *
 * Body: { filePath: string }
 *
 * Reads the local file and POSTs it to the Immich `/api/assets` endpoint
 * as multipart/form-data, authenticated via IMMICH_API_KEY.
 */
router.post('/ingest/immich', async (req, res) => {
  const { filePath } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  const immichUrl = process.env.IMMICH_URL;
  if (!immichUrl) {
    return res.status(503).json({
      error: 'Immich is not configured. Set IMMICH_URL in environment.'
    });
  }

  const userId = req.userId;
  const userRoot = req.userRoot || (() => {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    return path.join(dataDir, 'users', userId);
  })();

  try {
    const absPath = resolveUserFilePath(userRoot, filePath);
    const fileName = path.basename(absPath);
    const fileBuffer = await fs.readFile(absPath);
    const mimeType = guessMime(fileName);

    const boundary = `----FreeshardImmichBoundary${Date.now()}`;
    const body = buildMultipart(boundary, 'assetData', fileName, mimeType, fileBuffer);

    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    };
    if (process.env.IMMICH_API_KEY) {
      headers['x-api-key'] = process.env.IMMICH_API_KEY;
    }

    const endpoint = `${immichUrl.replace(/\/$/, '')}/api/assets`;
    const upstream = await fetch(endpoint, { method: 'POST', headers, body });

    let remoteId = null;
    let details = null;
    let status = 'success';

    if (upstream.ok) {
      try {
        const upBody = await upstream.json();
        remoteId = upBody.id || upBody.assetId || null;
      } catch (_) {}
    } else {
      status = 'error';
      details = `Upstream HTTP ${upstream.status}`;
    }

    await db.createEcosystemIngestLog({ userId, filePath, fileName, target: 'immich', status, remoteId, details });
    await db.logActivity(userId, 'ecosystem_ingest_immich', filePath, fileName, 0, JSON.stringify({ remoteId, status }));

    if (status === 'error') {
      return res.status(502).json({ success: false, target: 'immich', error: details });
    }

    res.json({ success: true, target: 'immich', remoteId, fileName });
  } catch (err) {
    if (err.message.includes('Path traversal')) {
      return res.status(403).json({ error: err.message });
    }
    await db.createEcosystemIngestLog({
      userId, filePath, fileName: path.basename(filePath), target: 'immich',
      status: 'error', remoteId: null, details: err.message
    }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ecosystem/ingest/logs
 * Returns the ingest history for the authenticated user.
 */
router.get('/ingest/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const logs = await db.getEcosystemIngestLogs(req.userId, limit, offset);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
