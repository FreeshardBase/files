const express = require('express');
const router = express.Router();
const db = require('../db');
const { runCloudSyncEngine } = require('../utils/cloud_to_cloud_sync');

// Auth middleware check helper
function getUserId(req) {
  return req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
}

/**
 * POST /api/cloud-sync/jobs
 * Create a new direct cloud-to-cloud sync job (#93)
 */
router.post('/jobs', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { name, src_connection_id, src_path, dst_connection_id, dst_path, schedule } = req.body;
    if (!src_connection_id || !dst_connection_id) {
      return res.status(400).json({ error: 'Both src_connection_id and dst_connection_id are required' });
    }

    const job = await db.createCloudSyncJob(userId, {
      name: name || 'Cloud Sync Job',
      src_connection_id,
      src_path: src_path || '/',
      dst_connection_id,
      dst_path: dst_path || '/',
      schedule: schedule || 'manual'
    });

    res.status(201).json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cloud-sync/jobs
 * List all cloud-to-cloud sync jobs for user (#93)
 */
router.get('/jobs', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const jobs = await db.getCloudSyncJobsByUser(userId);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cloud-sync/jobs/:id
 * Get details of a specific cloud sync job (#93)
 */
router.get('/jobs/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const jobId = parseInt(req.params.id, 10);
    const job = await db.getCloudSyncJobById(userId, jobId);
    if (!job) {
      return res.status(404).json({ error: `Cloud sync job #${jobId} not found` });
    }

    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cloud-sync/jobs/:id/run
 * Trigger execution of a cloud sync job (#93)
 */
router.post('/jobs/:id/run', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const jobId = parseInt(req.params.id, 10);
    const job = await db.getCloudSyncJobById(userId, jobId);
    if (!job) {
      return res.status(404).json({ error: `Cloud sync job #${jobId} not found` });
    }

    // Trigger sync engine asynchronously
    runCloudSyncEngine(jobId, userId).catch(err => {
      console.error(`[CloudSyncEngine] Job #${jobId} error:`, err.message);
    });

    res.json({ success: true, message: `Cloud sync job #${jobId} triggered` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cloud-sync/jobs/:id
 * Delete a cloud sync job (#93)
 */
router.delete('/jobs/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const jobId = parseInt(req.params.id, 10);
    const deleted = await db.deleteCloudSyncJob(userId, jobId);
    if (!deleted) {
      return res.status(404).json({ error: `Cloud sync job #${jobId} not found` });
    }

    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
