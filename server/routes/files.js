const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const Busboy = require('busboy');
const archiver = require('archiver');
const crypto = require('crypto');
const LocalProvider = require('../providers/local');
const { validateUserIsolation } = require('../middleware/isolation');
const { updateSharePathsOnMove, createTrashItem, logActivity } = require('../db');

function getLocalProvider(req) {
  const userRoot = req.userRoot;
  const provider = new LocalProvider({ userRoot });
  return { provider, userId: req.userId };
}

/**
 * Calculates total recursive directory size on disk
 */
async function getDirectorySize(dirOnDisk) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirOnDisk, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirOnDisk, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  } catch (e) {}
  return total;
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
    const { provider, userId } = getLocalProvider(req);
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
        await logActivity(userId, 'upload', destinationPath, filename, 0);
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
    const { provider, userId } = getLocalProvider(req);
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });

    await provider.mkdir(dirPath);
    await logActivity(userId, 'mkdir', dirPath, path.basename(dirPath), 1);
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
    await logActivity(userId, 'move', src, path.basename(src), 0, JSON.stringify({ dst }));

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
    const { provider, userId } = getLocalProvider(req);
    const { src, dst } = req.body;
    if (!src || !dst) return res.status(400).json({ error: 'src and dst are required' });

    await provider.copy(src, dst);
    await logActivity(userId, 'copy', src, path.basename(src), 0, JSON.stringify({ dst }));
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/files/local (Soft-delete to Trash by default, permanent=true for instant deletion) (#18, #22)
router.delete('/', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const requestedPath = req.query.path || req.body.path;
    const isPermanent = req.query.permanent === 'true' || req.body.permanent === true;

    if (!requestedPath) return res.status(400).json({ error: 'path is required' });

    if (isPermanent) {
      await provider.delete(requestedPath);
      await logActivity(userId, 'delete_permanent', requestedPath, path.basename(requestedPath), 0);
      return res.json({ success: true, permanent: true });
    }

    // Soft-delete: Move to user's isolated .trash/ directory
    const meta = await provider.metadata(requestedPath);
    const trashDir = path.join(req.userRoot, '.trash');
    await fs.mkdir(trashDir, { recursive: true });

    const trashId = crypto.randomUUID();
    const sourcePathOnDisk = provider._safe(requestedPath);
    const trashPathOnDisk = path.join(trashDir, trashId);

    await fs.rename(sourcePathOnDisk, trashPathOnDisk);
    const sizeBytes = meta.isDirectory ? await getDirectorySize(trashPathOnDisk) : (meta.size || 0);

    await createTrashItem(trashId, userId, requestedPath, path.basename(requestedPath), meta.isDirectory ? 1 : 0, sizeBytes, 30);
    await logActivity(userId, 'delete', requestedPath, path.basename(requestedPath), meta.isDirectory ? 1 : 0);

    res.json({ success: true, trashed: true, trashId });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// ── BATCH OPERATIONS (#12, #18, #22) ──────────────────────────────────────────

// POST /api/files/local/batch/delete (Soft-delete to Trash by default)
router.post('/batch/delete', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { paths, permanent = false } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    let deletedCount = 0;
    const trashDir = path.join(req.userRoot, '.trash');
    if (!permanent) await fs.mkdir(trashDir, { recursive: true });

    for (const p of paths) {
      if (permanent) {
        await provider.delete(p);
        await logActivity(userId, 'delete_permanent', p, path.basename(p), 0);
      } else {
        const meta = await provider.metadata(p);
        const trashId = crypto.randomUUID();
        const sourcePathOnDisk = provider._safe(p);
        const trashPathOnDisk = path.join(trashDir, trashId);

        await fs.rename(sourcePathOnDisk, trashPathOnDisk);
        const sizeBytes = meta.isDirectory ? await getDirectorySize(trashPathOnDisk) : (meta.size || 0);
        await createTrashItem(trashId, userId, p, path.basename(p), meta.isDirectory ? 1 : 0, sizeBytes, 30);
        await logActivity(userId, 'delete', p, path.basename(p), meta.isDirectory ? 1 : 0);
      }
      deletedCount++;
    }

    res.json({ success: true, deletedCount, permanent });
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
        await logActivity(userId, 'move', item.src, path.basename(item.src), 0, JSON.stringify({ dst: item.dst }));
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
    const { provider, userId } = getLocalProvider(req);
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
    await logActivity(userId, 'download_zip', pathsList.join(', '), 'freeshard-files.zip', 0);
  } catch (err) {
    if (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root')) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
