const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseDeviceType } = require('../utils/security_sessions');

// GET /api/security/sessions - List active user sessions
router.get('/sessions', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sessions = await db.getSecuritySessionsByUser(userId);
    const currentSessionId = req.sessionID || req.session?.id || req.headers['x-session-id'];

    const formattedSessions = sessions.map(sess => ({
      ...sess,
      is_current: sess.id === currentSessionId
    }));

    res.json({
      success: true,
      sessions: formattedSessions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/security/sessions/:id - Revoke specific session
router.delete('/sessions/:id', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.params;

  try {
    const existing = await db.getSecuritySessionById(userId, id);
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await db.deleteSecuritySession(userId, id);

    // Instant revocation if target is current session
    const currentSessionId = req.sessionID || req.session?.id || req.headers['x-session-id'];
    if (id === currentSessionId && req.session) {
      req.session.destroy();
    }

    res.json({
      success: true,
      message: 'Session revoked successfully',
      revokedSessionId: id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/security/sessions - Revoke all other sessions
router.delete('/sessions', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const currentSessionId = req.sessionID || req.session?.id || req.headers['x-session-id'] || '';
    const count = await db.revokeAllOtherSessions(userId, currentSessionId);

    res.json({
      success: true,
      message: 'All other sessions revoked successfully',
      revokedCount: count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
