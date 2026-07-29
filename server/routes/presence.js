const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * POST /api/presence/heartbeat (#94)
 * Record or refresh a user's presence in a specific folder/file.
 */
router.post('/heartbeat', async (req, res) => {
  try {
    const { folder_path, folderPath, path: p, file_name, fileName, action, username } = req.body || {};
    const targetFolder = folder_path || folderPath || p || '/';
    const targetFile = file_name || fileName || null;
    const targetAction = action || 'viewing';

    const presenceList = await db.recordPresenceHeartbeat(req.userId, {
      username: username || (req.session && req.session.user && req.session.user.username),
      folder_path: targetFolder,
      file_name: targetFile,
      action: targetAction
    });

    res.json({
      success: true,
      presence: presenceList,
      users: presenceList,
      activeUsers: presenceList
    });
  } catch (err) {
    console.error('[Presence] Error recording heartbeat:', err);
    res.status(500).json({ error: 'Failed to record presence heartbeat' });
  }
});

/**
 * GET /api/presence/folder (#94)
 * List active users currently viewing or editing files in a folder path.
 */
router.get('/folder', async (req, res) => {
  try {
    const targetFolder = req.query.path || req.query.folder_path || req.query.folderPath || '/';
    const ttl = parseInt(req.query.ttl || req.query.seconds || '60', 10);

    const presenceList = await db.getActiveFolderPresence(targetFolder, ttl);

    res.json({
      success: true,
      presence: presenceList,
      users: presenceList,
      activeUsers: presenceList
    });
  } catch (err) {
    console.error('[Presence] Error fetching folder presence:', err);
    res.status(500).json({ error: 'Failed to fetch folder presence' });
  }
});

/**
 * POST /api/presence/leave (#94)
 * Explicitly leave presence tracking for a folder.
 */
router.post('/leave', async (req, res) => {
  try {
    const { folder_path, folderPath, path: p } = req.body || {};
    const targetFolder = folder_path || folderPath || p || null;

    await db.removeUserPresence(req.userId, targetFolder);
    res.json({ success: true });
  } catch (err) {
    console.error('[Presence] Error leaving presence:', err);
    res.status(500).json({ error: 'Failed to clear user presence' });
  }
});

module.exports = router;
