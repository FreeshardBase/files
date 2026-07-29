const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const db = require('../db');

router.use(requireAuth);
router.use(requireAdmin);

/**
 * GET /api/admin/audit-logs
 * List administrative audit log entries (#44)
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const logs = await db.getAdminAuditLogs(limit, offset);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/users
 * List users and their roles (#44)
 */
router.get('/users', async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 * Change a user's role (#44)
 */
router.patch('/users/:id/role', async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    const updatedUser = await db.updateUserRole(targetUserId, role);

    const details = JSON.stringify({ role });
    await db.logAdminAction(req.userId, 'role_change', targetUserId, details, req.ip || '127.0.0.1');

    res.json({ user: updatedUser });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
