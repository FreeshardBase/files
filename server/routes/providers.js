const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { addProviderConnection, getProviderConnections, run } = require('../db');
const GoogleDriveProvider = require('../providers/gdrive');

router.use(requireAuth);

/**
 * POST /api/providers/gdrive/connect
 * Register & encrypt a Google Drive connection for the logged-in user (#3, #7)
 */
router.post('/gdrive/connect', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { display_name, client_id, client_secret, refresh_token } = req.body;

    if (!display_name || !refresh_token) {
      return res.status(400).json({ error: 'display_name and refresh_token are required' });
    }

    const credentials = {
      clientId: client_id || process.env.GDRIVE_CLIENT_ID,
      clientSecret: client_secret || process.env.GDRIVE_CLIENT_SECRET,
      refreshToken: refresh_token
    };

    // Verify credentials by creating a provider instance and requesting an access token
    const testProvider = new GoogleDriveProvider(credentials);
    await testProvider.getValidAccessToken();

    const connectionId = await addProviderConnection(userId, 'gdrive', display_name, credentials);
    res.status(201).json({ success: true, connectionId, display_name, provider_type: 'gdrive' });
  } catch (err) {
    res.status(400).json({ error: `Google Drive connection failed: ${err.message}` });
  }
});

/**
 * GET /api/providers/connections
 * List all active provider connections for the user (#3, #7)
 */
router.get('/connections', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connections = await getProviderConnections(userId);

    const safeConnections = connections.map(conn => ({
      id: conn.id,
      provider_type: conn.provider_type,
      display_name: conn.display_name,
      sync_mode: conn.sync_mode,
      enabled: conn.enabled,
      created_at: conn.created_at
    }));

    res.json({ connections: safeConnections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/providers/connections/:id
 * Remove a provider connection
 */
router.delete('/connections/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;

    await run('DELETE FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
