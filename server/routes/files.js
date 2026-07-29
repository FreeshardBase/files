const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const Busboy = require('busboy');
const crypto = require('crypto');
const LocalProvider = require('../providers/local');
const { validateUserIsolation } = require('../middleware/isolation');
const { updateSharePathsOnMove, createTrashItem, logActivity, updateFtsPathOnMove, deleteFileFromFts, searchFulltext, reindexUserFiles, indexFileInFts, checkActiveLegalHold, addFavorite, removeFavorite, getFavoritesByUser, updateFavoritePathsOnMove } = require('../db');
const { decodeUtf8Filename } = require('../utils/utf8');
const { dispatchWebhookEvent } = require('../utils/webhook_dispatcher');
const { emitSSEEvent } = require('../utils/sse_events');
const { scanBuffer, scanFile } = require('../utils/malware_scanner');
const { extractExifFromFile } = require('../utils/exif_extractor');
const { buildGalleryItems } = require('../utils/gallery');


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

// Apply user isolation middleware to all file operation routes
router.use(validateUserIsolation);

/**
 * GET /api/files/quota
 * Fetch local shard storage quota & usage for current user (#63)
 */
router.get('/quota', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const db = require('../db');
    const user = await db.get('SELECT quota_bytes FROM users WHERE id = ?', [userId]);
    const quotaBytes = user ? user.quota_bytes : null;
    const q = await provider.getQuota(quotaBytes);
    res.json({
      success: true,
      provider_type: 'local',
      display_name: 'Local Shard',
      used: q.used,
      total: q.total,
      percent: q.total ? Math.min(100, Math.round((q.used / q.total) * 100)) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/local/metadata?path=/Documents/hello.txt (#52)
router.get('/metadata', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'path parameter is required' });

    const meta = await provider.metadata(requestedPath);
    res.json({
      success: true,
      metadata: {
        ...meta,
        created_at: meta.created || meta.modified,
        updated_at: meta.modified,
        provider: 'local'
      }
    });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(404).json({ error: err.message });
  }
});

// GET /api/files/metadata/exif?path=/Photos/sample.jpg (#96)
router.get('/metadata/exif', async (req, res) => {
  try {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'path parameter is required' });

    const { provider } = getLocalProvider(req);
    const fullPath = provider._resolve(requestedPath);
    const metadata = await extractExifFromFile(fullPath);
    res.json({
      success: true,
      path: requestedPath,
      metadata
    });
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(404).json({ error: err.message });
  }
});


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

/**
 * Favorites / Quick Access Endpoints (#28)
 */
router.get('/favorites', async (req, res) => {
  try {
    const favorites = await getFavoritesByUser(req.userId);
    res.json({ success: true, favorites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/favorites', async (req, res) => {
  try {
    const { path: filePath, item_type = 'file', title } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const fav = await addFavorite(req.userId, filePath, item_type, title || path.basename(filePath));
    res.status(201).json({ success: true, favorite: fav });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/favorites', async (req, res) => {
  try {
    const filePath = req.query.path || (req.body && req.body.path);
    if (!filePath) return res.status(400).json({ error: 'path parameter is required' });
    await removeFavorite(req.userId, filePath);
    res.json({ success: true, unpinned: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/gallery?path=/Photos
 * Photo Gallery Mode (#23): returns only image files in the requested folder,
 * sorted alphabetically, with thumbnailUrl for grid/lightbox consumption.
 */
router.get('/gallery', async (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const requestedPath = req.query.path || '/';
    const items = await buildGalleryItems(provider, requestedPath);
    res.json({ success: true, path: requestedPath, items, total: items.length });
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

// POST /api/files/local/upload (Streaming upload via Busboy with UTF-8 filename decoding and Malware Scanning)
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

        const activeHold = await checkActiveLegalHold(userId, destinationPath);
        if (activeHold) {
          return res.status(403).json({ error: `File '${destinationPath}' is under active legal hold and cannot be modified or overwritten` });
        }

        const { Readable } = require('stream');
        const streamToSave = Readable.from(fullBuffer);
        const result = await provider.write(destinationPath, streamToSave);
        await logActivity(userId, 'upload', destinationPath, filename, 0);
        await dispatchWebhookEvent(userId, 'file_created', { path: destinationPath, type: 'file' }).catch(() => {});
        emitSSEEvent(userId, 'file_uploaded', { path: destinationPath, filename });
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

/**
 * POST /api/files/scan
 * Scans content buffer or file path for malware signatures (#84)
 */
router.post('/scan', async (req, res) => {
  try {
    const { content, path: filePath } = req.body;
    let result = { infected: false, threat: null };

    if (content !== undefined && content !== null) {
      result = scanBuffer(content);
    } else if (filePath) {
      const { provider } = getLocalProvider(req);
      const fullDiskPath = provider.resolvePath(filePath);
      result = await scanFile(fullDiskPath);
    }

    if (result.infected) {
      return res.status(422).json({
        success: false,
        infected: true,
        threat: result.threat,
        error: `Malware detected: ${result.threat}`
      });
    }

    res.json({ success: true, infected: false, threat: null });
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
    await dispatchWebhookEvent(userId, 'file_created', { path: dirPath, type: 'directory' }).catch(() => {});
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
    await updateFtsPathOnMove(userId, src, dst).catch(() => {});
    await updateFavoritePathsOnMove(userId, src, dst).catch(() => {});
    await logActivity(userId, 'move', src, path.basename(src), 0, JSON.stringify({ dst }));
    emitSSEEvent(userId, 'file_renamed', { src, dst });

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

    const activeHold = await checkActiveLegalHold(userId, requestedPath);
    if (activeHold) {
      return res.status(403).json({ error: `File '${requestedPath}' is under active legal hold and cannot be deleted` });
    }

    if (isPermanent) {
      await provider.delete(requestedPath);
      await removeFavorite(userId, requestedPath).catch(() => {});
      await deleteFileFromFts(userId, requestedPath).catch(() => {});
      await logActivity(userId, 'delete_permanent', requestedPath, path.basename(requestedPath), 0);
      await dispatchWebhookEvent(userId, 'file_deleted', { path: requestedPath, permanent: true }).catch(() => {});
      emitSSEEvent(userId, 'file_deleted', { path: requestedPath, permanent: true });
      return res.json({ success: true, permanent: true });
    }

    await removeFavorite(userId, requestedPath).catch(() => {});

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
    await deleteFileFromFts(userId, requestedPath).catch(() => {});
    await logActivity(userId, 'delete', requestedPath, path.basename(requestedPath), meta.isDirectory ? 1 : 0);
    await dispatchWebhookEvent(userId, 'file_deleted', { path: requestedPath, permanent: false }).catch(() => {});
    emitSSEEvent(userId, 'file_deleted', { path: requestedPath, permanent: false });

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
      const activeHold = await checkActiveLegalHold(userId, p);
      if (activeHold) {
        return res.status(403).json({ error: `File '${p}' is under active legal hold and cannot be deleted` });
      }
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
        await updateFavoritePathsOnMove(userId, item.src, item.dst).catch(() => {});
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

// POST /api/files/local/batch/rename (#35 Pattern-Based Bulk File Renaming)
router.post('/batch/rename', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { paths, items, prefix, suffix, search, replace, isRegex, useRegex } = req.body;
    const filePaths = paths || items;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return res.status(400).json({ error: 'paths or items array is required' });
    }

    if (!prefix && !suffix && search === undefined) {
      return res.status(400).json({ error: 'At least one rename rule (prefix, suffix, or search) is required' });
    }

    const regexEnabled = Boolean(isRegex || useRegex);
    let renamedCount = 0;
    const results = [];

    for (const srcPath of filePaths) {
      if (typeof srcPath !== 'string' || !srcPath) continue;

      const dir = path.posix.dirname(srcPath);
      const filename = path.posix.basename(srcPath);
      const ext = path.extname(filename);
      let stem = path.basename(filename, ext);

      if (search !== undefined && search !== '') {
        if (regexEnabled) {
          const rx = new RegExp(search, 'g');
          stem = stem.replace(rx, replace || '');
        } else {
          stem = stem.replaceAll(search, replace || '');
        }
      }

      if (prefix) {
        stem = prefix + stem;
      }
      if (suffix) {
        stem = stem + suffix;
      }

      const newFilename = stem + ext;
      const dstPath = path.posix.join(dir, newFilename);

      if (srcPath !== dstPath) {
        await provider.move(srcPath, dstPath);
        await updateSharePathsOnMove(userId, srcPath, dstPath);
        await updateFavoritePathsOnMove(userId, srcPath, dstPath).catch(() => {});
        await logActivity(userId, 'rename', srcPath, filename, 0, JSON.stringify({ dst: dstPath }));
        renamedCount++;
        results.push({ src: srcPath, dst: dstPath });
      }
    }

    res.json({ success: true, renamedCount, results });
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

    const archiverModule = await import('archiver');
    const archiver = archiverModule.default || archiverModule;
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

/**
 * POST /api/files/image/transform (or /api/files/local/image/transform) (#73)
 * Save transformed image back to disk/cloud
 */
router.post('/image/transform', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { path: itemPath, imageData, operations, rotate, flip, crop } = req.body || {};

    if (!itemPath) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    let existingBuffer = null;
    try {
      const { stream } = await provider.read(itemPath);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      existingBuffer = Buffer.concat(chunks);
    } catch (e) {
      if (e.message && (e.message.includes('Path traversal blocked') || e.message.includes('path escapes user root'))) {
        return res.status(403).json({ error: 'Path traversal blocked' });
      }
      if (!imageData) {
        return res.status(404).json({ error: `File not found: ${itemPath}` });
      }
    }

    const { transformImageBuffer } = require('../utils/image_transform');
    const transformedBuffer = transformImageBuffer(existingBuffer, {
      imageData,
      operations,
      rotate,
      flip,
      crop
    });

    if (!transformedBuffer) {
      return res.status(400).json({ error: 'Failed to process image transformation' });
    }

    const { Readable } = require('stream');
    await provider.write(itemPath, Readable.from(transformedBuffer));

    await logActivity(userId, 'image_transform', itemPath, path.basename(itemPath), transformedBuffer.length);
    try {
      dispatchWebhookEvent(userId, 'file_updated', { path: itemPath, action: 'transform' });
    } catch (e) {}

    return res.json({
      success: true,
      path: itemPath,
      size: transformedBuffer.length,
      message: 'Image transformed and saved successfully'
    });
  } catch (err) {
    if (err.message && (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root'))) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    return res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/files/pdf/rotate (#38)
 */
router.post('/pdf/rotate', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { path: itemPath, angle = 90, pages = null } = req.body || {};

    if (!itemPath) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const { stream } = await provider.read(itemPath);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const { rotatePdfPages, getPdfPageCount } = require('../utils/pdf_tools');
    const updatedBuffer = rotatePdfPages(buffer, { angle, pages });

    const { Readable } = require('stream');
    await provider.write(itemPath, Readable.from([updatedBuffer]));

    await logActivity(userId, 'pdf_rotate', itemPath, path.basename(itemPath), 0, JSON.stringify({ size: updatedBuffer.length }));
    try {
      dispatchWebhookEvent(userId, 'file_updated', { path: itemPath, action: 'rotate' });
    } catch (e) {}

    return res.json({
      success: true,
      path: itemPath,
      size: updatedBuffer.length,
      pageCount: getPdfPageCount(updatedBuffer)
    });
  } catch (err) {
    if (err.message && (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root'))) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    return res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * POST /api/files/pdf/split (#38)
 */
router.post('/pdf/split', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { path: itemPath, ranges, targetDir } = req.body || {};

    if (!itemPath) {
      return res.status(400).json({ error: 'path parameter is required' });
    }

    const { stream } = await provider.read(itemPath);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const { splitPdfPages } = require('../utils/pdf_tools');
    const splitBuffers = splitPdfPages(buffer, { ranges });

    const dir = targetDir || path.dirname(itemPath);
    const base = path.basename(itemPath, path.extname(itemPath));
    const ext = path.extname(itemPath) || '.pdf';
    const createdFiles = [];

    const { Readable } = require('stream');
    for (let i = 0; i < splitBuffers.length; i++) {
      const outPath = path.posix.join(dir, `${base}_part${i + 1}${ext}`);
      await provider.write(outPath, Readable.from([splitBuffers[i]]));
      createdFiles.push(outPath);

      await logActivity(userId, 'pdf_split', outPath, path.basename(outPath), 0, JSON.stringify({ size: splitBuffers[i].length }));
      try {
        dispatchWebhookEvent(userId, 'file_created', { path: outPath, action: 'split' });
      } catch (e) {}
    }

    return res.json({
      success: true,
      createdFiles
    });
  } catch (err) {
    if (err.message && (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root'))) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    return res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * POST /api/files/pdf/merge (#38)
 */
router.post('/pdf/merge', async (req, res) => {
  try {
    const { provider, userId } = getLocalProvider(req);
    const { paths: filePaths, targetPath } = req.body || {};

    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }
    if (!targetPath) {
      return res.status(400).json({ error: 'targetPath parameter is required' });
    }

    const buffers = [];
    for (const fPath of filePaths) {
      const { stream } = await provider.read(fPath);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      buffers.push(Buffer.concat(chunks));
    }

    const { mergePdfBuffers, getPdfPageCount } = require('../utils/pdf_tools');
    const mergedBuffer = mergePdfBuffers(buffers);

    const { Readable } = require('stream');
    await provider.write(targetPath, Readable.from([mergedBuffer]));

    await logActivity(userId, 'pdf_merge', targetPath, path.basename(targetPath), 0, JSON.stringify({ size: mergedBuffer.length }));
    try {
      dispatchWebhookEvent(userId, 'file_created', { path: targetPath, action: 'merge' });
    } catch (e) {}

    return res.json({
      success: true,
      targetPath,
      size: mergedBuffer.length,
      pageCount: getPdfPageCount(mergedBuffer)
    });
  } catch (err) {
    if (err.message && (err.message.includes('Path traversal blocked') || err.message.includes('path escapes user root'))) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }
    return res.status(err.status || 400).json({ error: err.message });
  }
});


/**
 * GET /api/files/search/fulltext?q=query (#74)
 */
router.get('/search/fulltext', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'q query parameter is required' });
    }

    const results = await searchFulltext(req.userId, query.trim());
    res.json({
      success: true,
      query: query.trim(),
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/search/reindex (#74)
 */
router.post('/search/reindex', async (req, res) => {
  try {
    const indexedCount = await reindexUserFiles(req.userId, req.userRoot);
    res.json({
      success: true,
      indexed_count: indexedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/ocr/extract (#80)
 * Optical Character Recognition text extraction from stored images and PDFs
 */
router.post('/ocr/extract', async (req, res) => {
  try {
    const relPath = req.body.path || req.body.filePath || req.body.file_path;
    if (!relPath) {
      return res.status(400).json({ error: 'path is required' });
    }

    const { resolveSafePath } = require('../utils/duplicate_finder');
    const ocrService = require('../utils/ocr_service');
    const fullDiskPath = resolveSafePath(req.userRoot, relPath);

    try {
      await fs.stat(fullDiskPath);
    } catch (e) {
      return res.status(404).json({ error: 'File not found' });
    }

    const text = await ocrService.extractTextFromFile(fullDiskPath);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    const fileName = path.basename(fullDiskPath);
    if (text) {
      await indexFileInFts(req.userId, relPath, fileName, text);
    }

    res.json({
      success: true,
      path: relPath,
      text,
      word_count: words
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message });
  }
});

/**
 * GET /api/files/duplicates (#76)
 * Scan user root storage for duplicate files by SHA-256 hash
 */
router.get('/duplicates', async (req, res) => {
  try {
    const { scanDuplicates } = require('../utils/duplicate_finder');
    const duplicates = await scanDuplicates(req.userRoot);
    res.json({
      success: true,
      duplicates,
      count: duplicates.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/deduplicate (#76)
 * Deduplicate files by deleting target copy or creating hard link
 */
router.post('/deduplicate', async (req, res) => {
  try {
    const { deduplicateFile } = require('../utils/duplicate_finder');
    const { action, keepPath, targetPath } = req.body || {};
    const result = await deduplicateFile(req.userRoot, { action, keepPath, targetPath });
    res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message });
  }
});

/**
 * GET /api/files/versions (#78)
 * Retrieve file revisions for user / specific file
 */
router.get('/versions', async (req, res) => {
  try {
    const db = require('../db');
    const requestedPath = req.query.path || null;
    const versions = await db.getFileVersions(req.userId, requestedPath);
    res.json({
      success: true,
      versions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/files/versions/create (#78)
 * Create a new version snapshot of a file
 */
router.post('/versions/create', async (req, res) => {
  try {
    const { saveFileVersion } = require('../utils/file_versioning');
    const { filePath, comment } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'filePath parameter is required' });
    }
    const version = await saveFileVersion(req.userRoot, req.userId, filePath, {
      author: req.userId,
      comment
    });
    res.json({
      success: true,
      version
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /api/files/versions/rollback (#78)
 * Roll back file content to target version
 */
router.post('/versions/rollback', async (req, res) => {
  try {
    const { rollbackFileVersion } = require('../utils/file_versioning');
    const { filePath, versionId, versionNumber } = req.body || {};
    const result = await rollbackFileVersion(req.userRoot, req.userId, {
      filePath,
      versionId,
      versionNumber
    });
    res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message });
  }
});

// ── Favorites / Quick Access (#28) ──────────────────────────────────────────

/**
 * POST /api/files/local/favorites
 * Pin a file or folder to the current user's favorites sidebar.
 * Body: { path, item_type?, title? }
 */
router.post('/favorites', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { path: filePath, item_type = 'file', title = null } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const favorite = await addFavorite(userId, filePath, item_type, title);
    res.status(201).json({ success: true, favorite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/files/local/favorites
 * List all pinned favorites for the current user.
 */
router.get('/favorites', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const favorites = await getFavoritesByUser(userId);
    res.json({ success: true, favorites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/files/local/favorites?path=<filePath>
 * Unpin a file or folder from the current user's favorites.
 */
router.delete('/favorites', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
    await removeFavorite(userId, filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Smart Folders & Saved Dynamic Search Views (#46) ────────────────────────

/**
 * POST /smart-folders
 * Create a new smart folder / saved search view.
 */
router.post('/smart-folders', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { createSmartFolder } = require('../db');
    const { name, query, filters } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const smartFolder = await createSmartFolder(userId, name, query, filters);
    res.status(201).json({ success: true, smartFolder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /smart-folders
 * List all smart folders for current user.
 */
router.get('/smart-folders', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { getSmartFoldersByUser } = require('../db');
    const smartFolders = await getSmartFoldersByUser(userId);
    res.json({ success: true, smartFolders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /smart-folders/:id
 * Get single smart folder definition.
 */
router.get('/smart-folders/:id', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { getSmartFolderById } = require('../db');
    const smartFolder = await getSmartFolderById(req.params.id, userId);
    if (!smartFolder) return res.status(404).json({ error: 'Smart folder not found' });
    res.json({ success: true, smartFolder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /smart-folders/:id/contents
 * Dynamically evaluate smart folder criteria and return matching file items.
 */
router.get('/smart-folders/:id/contents', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { getSmartFolderById } = require('../db');
    const { evaluateSmartFolder } = require('../utils/smart_folders');
    const smartFolder = await getSmartFolderById(req.params.id, userId);
    if (!smartFolder) return res.status(404).json({ error: 'Smart folder not found' });

    const items = await evaluateSmartFolder(req.userRoot, smartFolder);
    res.json({ success: true, smartFolder, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /smart-folders/:id or PATCH /smart-folders/:id
 * Update smart folder definition.
 */
const updateSmartFolderHandler = async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { updateSmartFolder } = require('../db');
    const updated = await updateSmartFolder(req.params.id, userId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Smart folder not found' });
    res.json({ success: true, smartFolder: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
router.put('/smart-folders/:id', updateSmartFolderHandler);
router.patch('/smart-folders/:id', updateSmartFolderHandler);

/**
 * DELETE /smart-folders/:id
 * Delete smart folder definition.
 */
router.delete('/smart-folders/:id', async (req, res) => {
  try {
    const { userId } = getLocalProvider(req);
    const { deleteSmartFolder, getSmartFolderById } = require('../db');
    const existing = await getSmartFolderById(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Smart folder not found' });
    await deleteSmartFolder(req.params.id, userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;



