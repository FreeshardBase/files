const express = require('express');
const router = express.Router();
const path = require('path');
const Busboy = require('busboy');
const LocalProvider = require('../providers/local');
const { validateUserIsolation } = require('../middleware/isolation');

function getLocalProvider(req) {
  const userRoot = req.userRoot;
  const provider = new LocalProvider({ userRoot });
  return { provider, userId: req.userId };
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
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', size);
    stream.pipe(res);
  } catch (err) {
    if (err.message.includes('Path traversal blocked')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(404).json({ error: err.message });
  }
});

// POST /api/files/local/upload (Streaming upload via Busboy)
router.post('/upload', (req, res) => {
  try {
    const { provider } = getLocalProvider(req);
    const busboy = Busboy({ headers: req.headers });
    let targetPath = '/';
    let fileUploaded = false;

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'path') targetPath = val;
    });

    busboy.on('file', async (fieldname, fileStream, info) => {
      const { filename } = info;
      const destinationPath = path.posix.join(targetPath, filename);
      fileUploaded = true;

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
    const { provider } = getLocalProvider(req);
    const { src, dst } = req.body;
    if (!src || !dst) return res.status(400).json({ error: 'src and dst are required' });

    await provider.move(src, dst);
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

module.exports = router;
