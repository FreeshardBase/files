const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  createLegalHold,
  getLegalHoldsByUser,
  getLegalHoldById,
  releaseLegalHold,
  checkActiveLegalHold
} = require('../db');

router.use(requireAuth);

/**
 * POST /api/legal-holds
 * Create a new legal hold policy for a file or folder (#99)
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { file_path, policy_name, lock_until, reason } = req.body;

    if (!file_path) {
      return res.status(400).json({ error: 'file_path is required' });
    }

    const hold = await createLegalHold(userId, { file_path, policy_name, lock_until, reason });
    res.status(201).json({ success: true, hold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/legal-holds
 * List all legal hold policies for current user (#99)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const holds = await getLegalHoldsByUser(userId);
    res.json({ holds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/legal-holds/check
 * Check if a specific file path is under active legal hold (#99)
 */
router.get('/check', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const targetPath = req.query.path;
    if (!targetPath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    const hold = await checkActiveLegalHold(userId, targetPath);
    res.json({ active: Boolean(hold), hold: hold || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/legal-holds/:id
 * Retrieve specific legal hold by ID (#99)
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const hold = await getLegalHoldById(req.params.id, userId);
    if (!hold) {
      return res.status(404).json({ error: 'Legal hold not found' });
    }
    res.json({ hold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/legal-holds/:id/release & DELETE /api/legal-holds/:id
 * Release a legal hold (#99)
 */
async function handleRelease(req, res) {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const released = await releaseLegalHold(req.params.id, userId);
    if (!released) {
      return res.status(404).json({ error: 'Legal hold not found or already released' });
    }
    res.json({ success: true, released: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.post('/:id/release', handleRelease);
router.delete('/:id', handleRelease);

module.exports = router;
