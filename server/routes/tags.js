const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/tags (#77)
 * List file tags for the authenticated user, optionally filtered by path query parameter.
 */
router.get('/', async (req, res) => {
  try {
    const filePath = req.query.path || req.query.filePath || req.query.file_path || null;
    const tags = await db.getTagsByUser(req.userId, filePath);
    res.json({ success: true, tags });
  } catch (err) {
    console.error('[Tags] Error listing tags:', err);
    res.status(500).json({ error: 'Failed to list tags' });
  }
});

/**
 * POST /api/tags/assign (#77)
 * Assign a tag label and hex color to a file path.
 */
router.post('/assign', async (req, res) => {
  try {
    const { filePath, path: p, file_path, tagName, tag_name, name, color } = req.body || {};
    const targetPath = filePath || p || file_path;
    const targetTag = tagName || tag_name || name;

    if (!targetPath || !targetTag) {
      return res.status(400).json({ error: 'filePath and tagName are required' });
    }

    const tag = await db.assignTag(req.userId, targetPath, targetTag, color);
    res.json({ success: true, tag });
  } catch (err) {
    console.error('[Tags] Error assigning tag:', err);
    res.status(500).json({ error: 'Failed to assign tag' });
  }
});

/**
 * DELETE /api/tags/remove (#77)
 * Remove a tag label mapping from a file path.
 */
router.delete('/remove', async (req, res) => {
  try {
    const targetPath = req.body.filePath || req.body.path || req.body.file_path || req.query.filePath || req.query.path || req.query.file_path;
    const targetTag = req.body.tagName || req.body.tag_name || req.body.name || req.query.tagName || req.query.tag_name || req.query.name;

    if (!targetPath || !targetTag) {
      return res.status(400).json({ error: 'filePath and tagName are required' });
    }

    await db.removeTag(req.userId, targetPath, targetTag);
    res.json({ success: true });
  } catch (err) {
    console.error('[Tags] Error removing tag:', err);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

module.exports = router;
