const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getActivityLogByUser, getFileAccessLogs } = require('../db');

router.use(requireAuth);

/**
 * GET /api/activity?limit=50&offset=0
 * List audit/activity log items for current user (#22)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const activities = await getActivityLogByUser(userId, limit, offset);
    res.json({ activities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/activity/file-access
 * Retrieve role-based file access logs (#44)
 */
router.get('/file-access', async (req, res) => {
  try {
    const userId = req.query.userId || req.userId;
    const status = req.query.status;
    const filePath = req.query.filePath;
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);

    const logs = await getFileAccessLogs({ userId, status, filePath, limit, offset });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

