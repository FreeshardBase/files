const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const db = require('../db');
const { safePath } = require('../utils/safepath');

// Helper to resolve file target from WOPI token and route params
function resolveUserFilePath(userId, fileIdentifier) {
  const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
  const userRoot = path.resolve(rootBase, userId);

  let relativePath = fileIdentifier;
  // If fileIdentifier is base64 encoded user:path
  try {
    const decoded = Buffer.from(fileIdentifier, 'base64url').toString('utf-8');
    if (decoded.includes(':')) {
      const parts = decoded.split(':');
      relativePath = parts.slice(1).join(':');
    }
  } catch (e) {}

  return {
    userRoot,
    relativePath,
    absolutePath: safePath(userRoot, relativePath)
  };
}

// Token authentication middleware
async function authenticateWopiToken(req, res, next) {
  let token = req.query.access_token || req.headers['x-wopi-token'];
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Access token missing' });
  }

  try {
    const tokenRecord = await db.getWopiToken(token);
    if (!tokenRecord) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    if (new Date(tokenRecord.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ error: 'Access token expired' });
    }

    req.wopiToken = tokenRecord;
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// 1. Create WOPI access token endpoint
router.post('/tokens', async (req, res) => {
  try {
    const { userId = 'default-user', filePath, canWrite = true, ttlMs = 24 * 60 * 60 * 1000 } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const fileId = Buffer.from(`${userId}:${filePath}`).toString('base64url');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    await db.createWopiToken({
      token,
      fileId,
      userId,
      canWrite: canWrite ? 1 : 0,
      expiresAt
    });

    res.json({
      accessToken: token,
      fileId,
      wopiSrc: `/wopi/files/${fileId}`,
      expiresAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. WOPI CheckFileInfo or Lock operations: GET/POST /wopi/files/:id
router.get('/files/:id', authenticateWopiToken, async (req, res) => {
  try {
    const userId = req.wopiToken.user_id;
    const file_id = req.wopiToken.file_id;
    const target = resolveUserFilePath(userId, file_id);

    try {
      const stat = await fs.stat(target.absolutePath);
      res.json({
        BaseFileName: path.basename(target.relativePath),
        OwnerId: userId,
        Size: stat.size,
        UserId: userId,
        UserCanWrite: Boolean(req.wopiToken.can_write),
        SupportsUpdate: true,
        SupportsLocks: true,
        Version: String(stat.mtimeMs)
      });
    } catch (err) {
      return res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Handle WOPI Lock operations on /wopi/files/:id
router.post('/files/:id', authenticateWopiToken, async (req, res) => {
  const override = req.headers['x-wopi-override'];
  const lockId = req.headers['x-wopi-lock'];
  const fileId = req.params.id;

  try {
    const existingLock = await db.getWopiLock(fileId);

    if (override === 'LOCK') {
      if (existingLock && existingLock.lock_id !== lockId) {
        res.setHeader('X-WOPI-Lock', existingLock.lock_id);
        return res.status(409).json({ error: 'Lock conflict' });
      }
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.setWopiLock(fileId, lockId, expiresAt);
      res.setHeader('X-WOPI-Lock', lockId);
      return res.status(200).send();
    } else if (override === 'GET_LOCK') {
      const lockVal = existingLock ? existingLock.lock_id : '';
      res.setHeader('X-WOPI-Lock', lockVal);
      return res.status(200).send();
    } else if (override === 'UNLOCK') {
      if (!existingLock || existingLock.lock_id !== lockId) {
        if (existingLock) res.setHeader('X-WOPI-Lock', existingLock.lock_id);
        return res.status(409).json({ error: 'Lock mismatch' });
      }
      await db.deleteWopiLock(fileId);
      return res.status(200).send();
    } else if (override === 'REFRESH_LOCK') {
      if (!existingLock || existingLock.lock_id !== lockId) {
        if (existingLock) res.setHeader('X-WOPI-Lock', existingLock.lock_id);
        return res.status(409).json({ error: 'Lock mismatch' });
      }
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.setWopiLock(fileId, lockId, expiresAt);
      return res.status(200).send();
    }

    res.status(400).json({ error: 'Unsupported WOPI override action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. WOPI GetFile: GET /wopi/files/:id/contents
router.get('/files/:id/contents', authenticateWopiToken, async (req, res) => {
  try {
    const userId = req.wopiToken.user_id;
    const file_id = req.wopiToken.file_id;
    const target = resolveUserFilePath(userId, file_id);

    try {
      const content = await fs.readFile(target.absolutePath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(content);
    } catch (err) {
      return res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. WOPI PutFile: POST /wopi/files/:id/contents
router.post('/files/:id/contents', authenticateWopiToken, async (req, res) => {
  try {
    if (!req.wopiToken.can_write) {
      return res.status(403).json({ error: 'Read-only access token' });
    }

    const userId = req.wopiToken.user_id;
    const file_id = req.wopiToken.file_id;
    const target = resolveUserFilePath(userId, file_id);

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    await fs.writeFile(target.absolutePath, buffer);
    res.status(200).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
