const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const Busboy = require('busboy');
const { requireAuth } = require('../middleware/auth');
const { addProviderConnection, getProviderConnections, run } = require('../db');
const GoogleDriveProvider = require('../providers/gdrive');

router.use(requireAuth);

/**
 * Helper to construct redirect URI
 */
function getRedirectUri(req) {
  if (process.env.GDRIVE_REDIRECT_URI) return process.env.GDRIVE_REDIRECT_URI;
  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'fs-files.gryzia.de';
  return `${protocol}://${host}/api/providers/gdrive/callback`;
}

/**
 * Helper to get initialized GoogleDriveProvider instance from connection ID
 */
async function getProviderInstanceForUser(connectionId, userId) {
  const connections = await getProviderConnections(userId);
  const conn = connections.find(c => c.id === parseInt(connectionId, 10));
  if (!conn) {
    throw new Error(`Provider connection #${connectionId} not found or permission denied`);
  }

  if (conn.provider_type === 'gdrive') {
    return { provider: new GoogleDriveProvider(conn.credentials), connection: conn };
  }

  throw new Error(`Provider type "${conn.provider_type}" not supported`);
}

/**
 * GET /api/providers/gdrive/auth
 * Initiates standard 1-click Google OAuth 2.0 Authorization Flow (#7)
 */
router.get('/gdrive/auth', (req, res) => {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send('Google OAuth Client ID not configured on server. Please set GDRIVE_CLIENT_ID in environment.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  if (!req.session.oauthStates) req.session.oauthStates = {};
  req.session.oauthStates[state] = true;

  const redirectUri = getRedirectUri(req);
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${state}`;

  res.redirect(authUrl);
});

/**
 * GET /api/providers/gdrive/callback
 * Handles OAuth 2.0 authorization code callback from Google (#7)
 */
router.get('/gdrive/callback', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Google OAuth Authorization Denied: ${error}`);
    }

    if (!code) {
      return res.status(400).send('Missing authorization code from Google OAuth.');
    }

    if (!req.session.oauthStates || !req.session.oauthStates[state]) {
      return res.status(403).send('Invalid OAuth state parameter.');
    }
    delete req.session.oauthStates[state];

    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const redirectUri = getRedirectUri(req);

    // Exchange authorization code for tokens
    const postData = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const tokenRes = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (resStream) => {
        let body = '';
        resStream.on('data', chunk => body += chunk);
        resStream.on('end', () => resolve({ statusCode: resStream.statusCode, body }));
      });
      request.on('error', reject);
      request.write(postData);
      request.end();
    });

    const tokens = JSON.parse(tokenRes.body);
    if (!tokens.refresh_token && !tokens.access_token) {
      return res.status(400).send(`Failed to exchange Google OAuth code: ${tokens.error_description || tokenRes.body}`);
    }

    const credentials = {
      clientId,
      clientSecret,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token
    };

    await addProviderConnection(userId, 'gdrive', 'Google Drive', credentials);

    // Redirect user back to dashboard with success message
    res.redirect('/?gdrive_connected=true');
  } catch (err) {
    res.status(500).send(`OAuth Callback Error: ${err.message}`);
  }
});

/**
 * POST /api/providers/gdrive/connect
 * Manual/Direct credential connection endpoint (#3, #7)
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

// ── PROVIDER FILE PROXY ENDPOINTS (#7) ───────────────────────────────────────

/**
 * GET /api/providers/:id/list?path=/
 */
router.get('/:id/list', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const requestedPath = req.query.path || '/';

    const { provider } = await getProviderInstanceForUser(connId, userId);
    const items = await provider.list(requestedPath);
    res.json({ path: requestedPath, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/providers/:id/read?path=...
 */
router.get('/:id/read', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'path parameter is required' });

    const { provider } = await getProviderInstanceForUser(connId, userId);
    const { stream, size, mimeType } = await provider.read(requestedPath);

    const baseName = path.basename(requestedPath);
    const encodedName = encodeURIComponent(baseName).replace(/['()]/g, escape).replace(/\*/g, '%2A');

    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    if (size) res.setHeader('Content-Length', size);
    res.setHeader('Content-Disposition', `inline; filename="${baseName}"; filename*=UTF-8''${encodedName}`);

    stream.pipe(res);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /api/providers/:id/upload
 */
router.post('/:id/upload', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const { provider } = await getProviderInstanceForUser(connId, userId);

    const busboy = Busboy({ headers: req.headers });
    let targetPath = '/';
    let uploadedFile = null;

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'path') targetPath = val;
    });

    busboy.on('file', async (fieldname, fileStream, filenameObj, encoding, mimetype) => {
      const filename = typeof filenameObj === 'object' ? filenameObj.filename : filenameObj;
      const fullPath = targetPath === '/' ? `/${filename}` : `${targetPath.replace(/\/+$/, '')}/${filename}`;
      try {
        uploadedFile = await provider.write(fullPath, fileStream, { mimeType: mimetype });
      } catch (err) {
        busboy.emit('error', err);
      }
    });

    busboy.on('finish', () => {
      res.status(201).json({ success: true, file: uploadedFile });
    });

    busboy.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });

    req.pipe(busboy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/providers/:id/delete?path=...
 */
router.delete('/:id/delete', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const targetPath = req.query.path;

    const { provider } = await getProviderInstanceForUser(connId, userId);
    await provider.delete(targetPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
