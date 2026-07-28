const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const { runSyncEngine } = require('../utils/sync_engine');

router.use(requireAuth);

/**
 * POST /api/sync/start
 * Initiate a file synchronization job (#71)
 */
router.post('/start', async (req, res) => {
  try {
    const { provider_connection_id, local_path, remote_path, conflict_strategy, sync_mode } = req.body;

    if (!local_path || !remote_path) {
      return res.status(400).json({ error: 'Both local_path and remote_path are required' });
    }

    const job = await db.createSyncJob({
      userId: req.userId,
      providerConnectionId: provider_connection_id || null,
      localPath: local_path,
      remotePath: remote_path,
      conflictStrategy: conflict_strategy || 'newer_wins',
      syncMode: sync_mode || 'two_way'
    });

    // Run sync process
    await runSyncEngine(job.id, req.userId).catch((err) => {
      console.error(`[SyncEngine] Job #${job.id} failed:`, err.message);
    });

    const currentJob = await db.getSyncJobById(job.id, req.userId);
    res.json({ message: 'Sync job started', job: currentJob || job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/status
 * Get status of sync jobs for authenticated user (#71)
 */
router.get('/status', async (req, res) => {
  try {
    const { job_id } = req.query;
    if (job_id) {
      const job = await db.getSyncJobById(job_id, req.userId);
      if (!job) {
        return res.status(404).json({ error: 'Sync job not found' });
      }
      return res.json({ job });
    }

    const jobs = await db.getSyncJobsByUser(req.userId);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
