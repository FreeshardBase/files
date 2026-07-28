const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * GET /api/comments (#79)
 * Retrieve discussion comments for the authenticated user, optionally filtered by file path.
 */
router.get('/', async (req, res) => {
  try {
    const filePath = req.query.path || req.query.filePath || req.query.file_path || null;
    const comments = await db.getFileComments(req.userId, filePath);
    res.json({ success: true, comments });
  } catch (err) {
    console.error('[Comments] Error listing comments:', err);
    res.status(500).json({ error: 'Failed to list comments' });
  }
});

/**
 * POST /api/comments/create (#79)
 * Attach a new comment to a specific file or folder path.
 */
router.post('/create', async (req, res) => {
  try {
    const { filePath, path: p, file_path, comment, text } = req.body || {};
    const targetPath = filePath || p || file_path;
    const targetComment = comment || text;

    if (!targetPath || !targetComment) {
      return res.status(400).json({ error: 'filePath and comment are required' });
    }

    const createdComment = await db.createFileComment(req.userId, targetPath, targetComment);
    res.status(201).json({ success: true, comment: createdComment });
  } catch (err) {
    console.error('[Comments] Error creating comment:', err);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * POST /api/comments/resolve (#79)
 * Mark a file comment thread/annotation as resolved or unresolved.
 */
router.post('/resolve', async (req, res) => {
  try {
    const { id, commentId, resolved = true } = req.body || {};
    const targetId = id || commentId;

    if (!targetId) {
      return res.status(400).json({ error: 'id parameter is required' });
    }

    const updatedComment = await db.resolveFileComment(targetId, req.userId, resolved ? 1 : 0);
    if (!updatedComment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    res.json({ success: true, comment: updatedComment });
  } catch (err) {
    console.error('[Comments] Error resolving comment:', err);
    res.status(500).json({ error: 'Failed to resolve comment' });
  }
});

/**
 * DELETE /api/comments/remove (#79)
 * Delete a comment by ID.
 */
router.delete('/remove', async (req, res) => {
  try {
    const targetId = req.body.id || req.body.commentId || req.query.id || req.query.commentId;

    if (!targetId) {
      return res.status(400).json({ error: 'id parameter is required' });
    }

    const deleted = await db.deleteFileComment(targetId, req.userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Comments] Error deleting comment:', err);
    res.status(500).json({ error: 'Failed to remove comment' });
  }
});

module.exports = router;
