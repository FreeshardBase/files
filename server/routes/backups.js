const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * POST /api/backups/create
 * Create a new automated scheduled backup job (#83)
 */
router.post('/create', async (req, res) => {
  try {
    const { name, schedule, target_path, targetPath, encrypted } = req.body;
    const finalName = name;
    const finalPath = target_path || targetPath || '/';

    if (!finalName) {
      return res.status(400).json({ error: 'Backup job name is required' });
    }

    const job = await db.createBackupJob(req.userId, {
      name: finalName,
      schedule: schedule || 'daily',
      targetPath: finalPath,
      encrypted: encrypted !== undefined ? encrypted : true
    });

    res.status(201).json({ success: true, message: 'Backup job created', job, backup: job });
  } catch (err) {
    console.error('[Backups] Error creating backup job:', err);
    res.status(500).json({ error: err.message || 'Failed to create backup job' });
  }
});

/**
 * GET /api/backups/list
 * List all scheduled backup jobs for authenticated user (#83)
 */
router.get('/list', async (req, res) => {
  try {
    const backups = await db.getBackupJobsByUser(req.userId);
    res.json({ success: true, backups, jobs: backups });
  } catch (err) {
    console.error('[Backups] Error listing backup jobs:', err);
    res.status(500).json({ error: err.message || 'Failed to list backup jobs' });
  }
});

/**
 * GET /api/backups
 * Alias for listing backup jobs
 */
router.get('/', async (req, res) => {
  try {
    const backups = await db.getBackupJobsByUser(req.userId);
    res.json({ success: true, backups, jobs: backups });
  } catch (err) {
    console.error('[Backups] Error listing backup jobs:', err);
    res.status(500).json({ error: err.message || 'Failed to list backup jobs' });
  }
});

module.exports = router;
