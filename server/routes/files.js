const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const Busboy = require('busboy');
const archiver = require('archiver');
const LocalProvider = require('../providers/local');
const { validateUserIsolation } = require('../middleware/isolation');
const { updateSharePathsOnMove } = require('../db');

function getLocalProvider(req) {
  const userRoot = req.userRoot;
  const provider = new LocalProvider({ userRoot });
  return { provider, userId: req.userId };
}

/**
 * Safely decodes UTF-8 filenames if busboy/headers parsed them as latin1/binary
 */
function decodeUtf8Filename(filename) {
  try {
    const decoded = Buffer.from(filename, 'binary').toString('utf8');
    return decoded.includes('') ? filename : decoded;
  } catch (e) {
    return filename;
  }
}

// Apply user isolation middleware to all file operation routes
router.use(validateUserIsolation);

// GET /api/files/local/list?path=/
router.get('/list', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const requestedPath = req.query.path || '/';
    const items = await provider.list(requestedPath);
    res.json({ path: requestedPath, items });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// GET /api/files/local/read?path=/Documents/hello.txt
router.get('/read', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'path parameter is required' });

    const { stream, size, mimeType } = await provider.read(requestedPath);
    const baseName = path.basename(requestedPath);
    const encodedName = encodeURIComponent(baseName).replace(/['()]/g, escape).replace(/\*/g, '%2A');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', size);
    res.setHeader('Content-Disposition', `inline; filename="${baseName}"; filename*=UTF-8''${encodedName}`);
    stream.pipe(res);
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(404).json({ error: err.message });
  }
});

// POST /api/files/local/upload (Streaming upload via Busboy with UTF-8 filename decoding)
router.post('/upload', (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const busboy = Busboy({ headers: req.headers });
    let targetPath = '/';

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'path') targetPath = val;
    });

    busboy.on('file', async (fieldname, fileStream, info) => {
      const rawFilename = info.filename;
      const filename = decodeUtf8Filename(rawFilename);
      const destinationPath = path.posix.join(targetPath, filename);

      try {
        const result = await provider.write(destinationPath, fileStream);
        res.status(201).json({ success: true, file: result });
      } catch (err) {
        if (err.message.includes('Path traversal blocked')) {
          return res.status(403).json({ error: err.message });
        }
        res.status(500).json({ error: err.message });
      }
    });

    busboy.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });

    req.pipe(busboy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/local/mkdir
router.post('/mkdir', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });

    await provider.mkdir(dirPath);
    res.status(201).json({ success: true, path: dirPath });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/local/move
router.post('/move', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { src, dst } = req.body;
    if (!src || !dst) return res.status(400).json({ error: 'src and dst are required' });

    await provider.move(src, dst);

    // Invariant: Update internal & public share link target paths on move (#14, #15, #45)
    await updateSharePathsOnMove(userId, src, dst);

    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/local/copy
router.post('/copy', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const { src, dst } = req.body;
    if (!src || !dst) return res.status(400).json({ error: 'src and dst are required' });

    await provider.copy(src, dst);
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/files/local
router.delete('/', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const requestedPath = req.query.path || req.body.path;
    if (!requestedPath) return res.status(400).json({ error: 'path is required' });

    await provider.delete(requestedPath);
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// ── BATCH OPERATIONS (#12) ───────────────────────────────────────────────────

// POST /api/files/local/batch/delete
router.post('/batch/delete', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const { paths } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    let deletedCount = 0;
    for (const p of paths) {
      await provider.delete(p);
      deletedCount++;
    }

    res.json({ success: true, deletedCount });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/local/batch/move
router.post('/batch/move', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { items } = req.body; // [{ src, dst }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    let movedCount = 0;
    for (const item of items) {
      if (item.src && item.dst) {
        await provider.move(item.src, item.dst);
        await updateSharePathsOnMove(userId, item.src, item.dst);
        movedCount++;
      }
    }

    res.json({ success: true, movedCount });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// GET /api/files/local/batch/zip?paths=/Documents/f1.txt,/Documents/f2.txt
router.get('/batch/zip', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const rawPaths = req.query.paths;
    if (!rawPaths) return res.status(400).json({ error: 'paths parameter is required' });

    const pathsList = Array.isArray(rawPaths) ? rawPaths : rawPaths.split(',').map(p => p.trim()).filter(Boolean);
    if (pathsList.length === 0) return res.status(400).json({ error: 'At least one valid path is required' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="freeshard-files.zip"');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    for (const itemPath of pathsList) {
      const fullPath = provider._safe(itemPath);
      const stat = await fs.stat(fullPath);
      const name = path.basename(itemPath);

      if (stat.isDirectory()) {
        archive.directory(fullPath, name);
      } else {
        archive.file(fullPath, { name });
      }
    }

    await archive.finalize();
  } catch (err) {
    if (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root')) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
