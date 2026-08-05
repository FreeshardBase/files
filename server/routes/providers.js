const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const Busboy = require('busboy');
const { requireAuth } = require('../middleware/auth');
const { addProviderConnection, getProviderConnections, run, get, all } = require('../db');
const GoogleDriveProvider = require('../providers/gdrive');
const DropboxProvider = require('../providers/dropbox');
const S3Provider = require('../providers/s3');
const MOVEitProvider = require('../providers/MOVEitProvider');
const { decodeUtf8Filename } = require('../utils/utf8');

// ── PUBLIC PROVIDER WEBHOOK ENDPOINTS (#57) ───────────────────────────────────

/**
 * GET /api/providers/dropbox/webhook
 * Verification endpoint for Dropbox webhook challenge (#57)
 */
router.get('/dropbox/webhook', (req, res) => {
  const challenge = req.query.challenge;
  if (challenge) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(challenge);
  }
  return res.status(400).send('Missing challenge parameter');
});

/**
 * POST /api/providers/dropbox/webhook
 * Inbound webhook delta notification receiver from Dropbox (#57)
 */
router.post('/dropbox/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-dropbox-signature'];
    const secret = process.env.DROPBOX_CLIENT_SECRET;

    if (signature && secret) {
      const isValid = DropboxProvider.verifyWebhookSignature(signature, req.body, secret);
      if (!isValid) {
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }
    }

    res.status(200).json({ success: true, processed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requireAuth);

/**
 * Helper to construct redirect URI for Google Drive
 */
function getRedirectUri(req) {
  if (process.env.GDRIVE_REDIRECT_URI) return process.env.GDRIVE_REDIRECT_URI;
  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'fs-files.gryzia.de';
  return `${protocol}://${host}/api/providers/gdrive/callback`;
}

/**
 * Helper to get initialized Provider instance from connection ID (#7, #56)
 */
async function getProviderInstanceForUser(connectionId, userId) {
  const connections = await getProviderConnections(userId);
  const conn = connections.find(c => c.id === parseInt(connectionId, 10));
  if (!conn) {
    throw new Error(`Provider connection #${connectionId} not found or permission denied`);
  }

  if (conn.provider_type === 'gdrive') {
    return { provider: new GoogleDriveProvider(conn.credentials), connection: conn };
  } else if (conn.provider_type === 'dropbox') {
    return { provider: new DropboxProvider(conn.credentials), connection: conn };
  } else if (conn.provider_type === 's3') {
    return { provider: new S3Provider(conn.credentials), connection: conn };
  } else if (conn.provider_type === 'moveit') {
    return { provider: new MOVEitProvider(conn.credentials), connection: conn };
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
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email');

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

    // Fetch account email to support multiple Google Drive accounts per user
    let accountEmail = null;
    try {
      const userInfoRes = await new Promise((resolve) => {
        https.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { 'Authorization': `Bearer ${tokens.access_token}` }
        }, (resStream) => {
          let b = '';
          resStream.on('data', c => b += c);
          resStream.on('end', () => resolve(b));
        }).on('error', () => resolve(null));
      });
      if (userInfoRes) {
        const uInfo = JSON.parse(userInfoRes);
        accountEmail = uInfo.email;
      }
    } catch (e) {}

    const displayName = accountEmail ? `Google Drive (${accountEmail})` : 'Google Drive';

    const existingConnections = await getProviderConnections(userId);
    const existingGdrive = existingConnections.find(c =>
      c.provider_type === 'gdrive' &&
      (accountEmail ? (c.credentials && c.credentials.accountEmail === accountEmail) : true)
    );

    const refreshToken = tokens.refresh_token || (existingGdrive && existingGdrive.credentials ? existingGdrive.credentials.refreshToken : null);

    const credentials = {
      clientId,
      clientSecret,
      refreshToken,
      accessToken: tokens.access_token,
      accountEmail
    };

    let connId;
    if (existingGdrive) {
      connId = existingGdrive.id;
      const { encrypt } = require('../utils/crypto');
      const { iv, authTag, data: encryptedData } = encrypt(JSON.stringify(credentials));
      await run(
        'UPDATE provider_connections SET display_name = ?, credentials_encrypted = ?, iv = ?, auth_tag = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [displayName, encryptedData, iv, authTag, existingGdrive.id]
      );
    } else {
      connId = await addProviderConnection(userId, 'gdrive', displayName, credentials);
    }

    res.redirect(`/?gdrive_connected=true&connection_id=${connId}`);
  } catch (err) {
    res.status(500).send(`OAuth Callback Error: ${err.message}`);
  }
});

/**
 * GET /api/providers/dropbox/auth
 * Initiates standard 1-click Dropbox OAuth 2.0 Authorization Flow (#56)
 */
router.get('/dropbox/auth', (req, res) => {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send('Dropbox OAuth App Key not configured on server. Please set DROPBOX_CLIENT_ID in environment.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  if (!req.session.oauthStates) req.session.oauthStates = {};
  req.session.oauthStates[state] = true;

  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'fs-files.gryzia.de';
  const redirectUri = `${protocol}://${host}/api/providers/dropbox/callback`;

  const authUrl = `https://www.dropbox.com/oauth2/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&token_access_type=offline` +
    `&state=${state}`;

  res.redirect(authUrl);
});

/**
 * GET /api/providers/dropbox/callback
 * Handles OAuth 2.0 authorization code callback from Dropbox (#56)
 */
router.get('/dropbox/callback', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Dropbox OAuth Authorization Denied: ${error}`);
    }

    if (!code) {
      return res.status(400).send('Missing authorization code from Dropbox OAuth.');
    }

    if (!req.session.oauthStates || !req.session.oauthStates[state]) {
      return res.status(403).send('Invalid OAuth state parameter.');
    }
    delete req.session.oauthStates[state];

    const clientId = process.env.DROPBOX_CLIENT_ID;
    const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'fs-files.gryzia.de';
    const redirectUri = `${protocol}://${host}/api/providers/dropbox/callback`;

    const postData = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const tokenRes = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: 'api.dropboxapi.com',
        path: '/oauth2/token',
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
      return res.status(400).send(`Failed to exchange Dropbox OAuth code: ${tokens.error_description || tokenRes.body}`);
    }

    // Fetch account email to support multiple Dropbox accounts per user
    let accountEmail = null;
    try {
      const dbxUserRes = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.dropboxapi.com',
          path: '/2/users/get_current_account',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json'
          }
        }, (resStream) => {
          let b = '';
          resStream.on('data', c => b += c);
          resStream.on('end', () => resolve(b));
        });
        req.on('error', () => resolve(null));
        req.write('null');
        req.end();
      });
      if (dbxUserRes) {
        const uInfo = JSON.parse(dbxUserRes);
        accountEmail = uInfo.email;
      }
    } catch (e) {}

    const displayName = accountEmail ? `Dropbox (${accountEmail})` : 'Dropbox';

    const existingConnections = await getProviderConnections(userId);
    const existingDropbox = existingConnections.find(c =>
      c.provider_type === 'dropbox' &&
      (accountEmail ? (c.credentials && c.credentials.accountEmail === accountEmail) : true)
    );

    const refreshToken = tokens.refresh_token || (existingDropbox && existingDropbox.credentials ? existingDropbox.credentials.refreshToken : null);

    const credentials = {
      clientId,
      clientSecret,
      refreshToken,
      accessToken: tokens.access_token,
      accountEmail
    };

    let connId;
    if (existingDropbox) {
      connId = existingDropbox.id;
      const { encrypt } = require('../utils/crypto');
      const { iv, authTag, data: encryptedData } = encrypt(JSON.stringify(credentials));
      await run(
        'UPDATE provider_connections SET display_name = ?, credentials_encrypted = ?, iv = ?, auth_tag = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [displayName, encryptedData, iv, authTag, existingDropbox.id]
      );
    } else {
      connId = await addProviderConnection(userId, 'dropbox', displayName, credentials);
    }

    res.redirect(`/?dropbox_connected=true&connection_id=${connId}`);
  } catch (err) {
    res.status(500).send(`Dropbox OAuth Callback Error: ${err.message}`);
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
 * POST /api/providers/s3/connect (#73, #9)
 */
router.post('/s3/connect', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { display_name, endpoint, bucket, access_key, secret_key } = req.body;

    if (!display_name || !bucket || !access_key || !secret_key) {
      return res.status(400).json({ error: 'display_name, bucket, access_key, and secret_key are required' });
    }

    const credentials = {
      endpoint: endpoint || null,
      bucket,
      accessKeyId: access_key,
      secretAccessKey: secret_key
    };

    const connectionId = await addProviderConnection(userId, 's3', display_name, credentials);
    res.status(201).json({ success: true, connectionId, display_name, provider_type: 's3' });
  } catch (err) {
    res.status(400).json({ error: `S3 connection failed: ${err.message}` });
  }
});

/**
 * POST /api/providers/moveit/connect (#73, #70)
 */
router.post('/moveit/connect', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { display_name, host, username, password } = req.body;

    if (!display_name || !host || !username || !password) {
      return res.status(400).json({ error: 'display_name, host, username, and password are required' });
    }

    const credentials = {
      host,
      username,
      password
    };

    const connectionId = await addProviderConnection(userId, 'moveit', display_name, credentials);
    res.status(201).json({ success: true, connectionId, display_name, provider_type: 'moveit' });
  } catch (err) {
    res.status(400).json({ error: `MOVEit connection failed: ${err.message}` });
  }
});

/**
 * GET /api/providers/connections
 * List all active provider connections for the user (#3, #7, #56)
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
 * GET /api/providers/quota
 * Fetch storage usage & quota for all active cloud providers (#63)
 */
router.get('/quota', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connections = await getProviderConnections(userId);

    const quotas = await Promise.all(connections.map(async (conn) => {
      try {
        const { provider } = await getProviderInstanceForUser(conn.id, userId);
        const q = await provider.getQuota();
        return {
          connectionId: conn.id,
          provider_type: conn.provider_type,
          display_name: conn.display_name,
          used: q.used,
          total: q.total,
          percent: q.total ? Math.min(100, Math.round((q.used / q.total) * 100)) : null
        };
      } catch (e) {
        return {
          connectionId: conn.id,
          provider_type: conn.provider_type,
          display_name: conn.display_name,
          error: e.message,
          used: 0,
          total: null,
          percent: null
        };
      }
    }));

    res.json({ success: true, quotas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/providers/:id/quota
 * Fetch storage usage & quota for specific provider connection ID (#63)
 */
router.get('/:id/quota', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const { provider, connection } = await getProviderInstanceForUser(connId, userId);
    const q = await provider.getQuota();

    res.json({
      success: true,
      connectionId: connection.id,
      provider_type: connection.provider_type,
      display_name: connection.display_name,
      used: q.used,
      total: q.total,
      percent: q.total ? Math.min(100, Math.round((q.used / q.total) * 100)) : null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Helper to purge expired orphaned shares older than PROVIDER_SHARE_RETENTION_DAYS (#58)
 */
async function cleanupExpiredOrphanedShares() {
  const retentionDays = parseInt(process.env.PROVIDER_SHARE_RETENTION_DAYS || '90', 10);
  try {
    await run(`DELETE FROM file_shares WHERE status = 'orphaned' AND unlinked_at < datetime('now', '-' || ? || ' days')`, [retentionDays]);
    await run(`DELETE FROM public_shares WHERE status = 'orphaned' AND unlinked_at < datetime('now', '-' || ? || ' days')`, [retentionDays]);
  } catch (err) {
    console.warn('Failed to cleanup expired orphaned shares:', err.message);
  }
}

/**
 * DELETE /api/providers/:id
 * Truly unlinks/deletes a provider connection, while retaining shares as 'orphaned' for X days (#58)
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const connId = parseInt(req.params.id, 10);
    if (isNaN(connId)) {
      return res.status(400).json({ error: 'Invalid provider connection ID' });
    }

    const conn = await get('SELECT id, provider_type FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);
    if (!conn) {
      return res.status(404).json({ error: `Provider connection #${connId} not found or permission denied` });
    }

    // Mark associated shares as orphaned with timestamp so they can be restored upon re-linking within X days (#58)
    await run(
      "UPDATE file_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND owner_user_id = ?",
      [connId, userId]
    );
    await run(
      "UPDATE public_shares SET status = 'orphaned', provider_connection_id = NULL, unlinked_at = datetime('now') WHERE provider_connection_id = ? AND user_id = ?",
      [connId, userId]
    );

    // Truly delete the connection record
    await run('DELETE FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);

    await cleanupExpiredOrphanedShares();

    res.json({ success: true, unlinked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/providers/:id/reconcile-shares
 * Retrieve list of orphaned shares for a newly connected provider within retention window (#58)
 */
router.get('/:id/reconcile-shares', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const retentionDays = parseInt(process.env.PROVIDER_SHARE_RETENTION_DAYS || '90', 10);

    await cleanupExpiredOrphanedShares();

    const conn = await get('SELECT provider_type FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);
    if (!conn) {
      return res.status(404).json({ error: 'Provider connection not found' });
    }

    const internalShares = await all(
      `SELECT fs.id, fs.file_path, fs.is_directory, fs.read_write, fs.unlinked_at, u.username as sharee_username, u.display_name as sharee_display_name
       FROM file_shares fs
       JOIN users u ON fs.sharee_user_id = u.id
       WHERE fs.owner_user_id = ? AND fs.provider_type = ? AND fs.status = 'orphaned'
         AND fs.unlinked_at >= datetime('now', '-' || ? || ' days')`,
      [userId, conn.provider_type, retentionDays]
    );

    const publicShares = await all(
      `SELECT id, token, label, file_path, is_directory, permission_mode, download_count, unlinked_at
       FROM public_shares
       WHERE user_id = ? AND provider_type = ? AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-' || ? || ' days')`,
      [userId, conn.provider_type, retentionDays]
    );

    res.json({ connectionId: connId, retentionDays, internalShares, publicShares });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/providers/:id/reconcile-shares/restore
 * Restore orphaned shares binding them to the new provider connection (#58)
 */
router.post('/:id/reconcile-shares/restore', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const retentionDays = parseInt(process.env.PROVIDER_SHARE_RETENTION_DAYS || '90', 10);

    const conn = await get('SELECT provider_type FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);
    if (!conn) {
      return res.status(404).json({ error: 'Provider connection not found' });
    }

    await run(
      `UPDATE file_shares SET status = 'active', provider_connection_id = ?, unlinked_at = NULL
       WHERE owner_user_id = ? AND provider_type = ? AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-' || ? || ' days')`,
      [connId, userId, conn.provider_type, retentionDays]
    );

    await run(
      `UPDATE public_shares SET status = 'active', provider_connection_id = ?, unlinked_at = NULL
       WHERE user_id = ? AND provider_type = ? AND status = 'orphaned'
         AND unlinked_at >= datetime('now', '-' || ? || ' days')`,
      [connId, userId, conn.provider_type, retentionDays]
    );

    res.json({ success: true, restored: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/providers/:id/reconcile-shares/discard
 * Discard/delete orphaned shares for a provider type (#58)
 */
router.post('/:id/reconcile-shares/discard', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;

    const conn = await get('SELECT provider_type FROM provider_connections WHERE id = ? AND user_id = ?', [connId, userId]);
    if (!conn) {
      return res.status(404).json({ error: 'Provider connection not found' });
    }

    await run("DELETE FROM file_shares WHERE owner_user_id = ? AND provider_type = ? AND status = 'orphaned'", [userId, conn.provider_type]);
    await run("DELETE FROM public_shares WHERE user_id = ? AND provider_type = ? AND status = 'orphaned'", [userId, conn.provider_type]);

    res.json({ success: true, discarded: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROVIDER FILE PROXY ENDPOINTS (#7, #56) ──────────────────────────────────

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
    let targetPath = req.query.path || '/';
    let uploadPromise = null;
    let uploadError = null;

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'path' && val) targetPath = val;
    });

    busboy.on('file', (fieldname, fileStream, filenameObj, encoding, mimetype) => {
      const rawFilename = typeof filenameObj === 'object' ? filenameObj.filename : filenameObj;
      const filename = decodeUtf8Filename(rawFilename);
      const fullPath = targetPath === '/' ? `/${filename}` : `${targetPath.replace(/\/+$/, '')}/${filename}`;

      uploadPromise = provider.write(fullPath, fileStream, { mimeType: mimetype }).catch(err => {
        uploadError = err;
      });
    });

    busboy.on('finish', async () => {
      try {
        if (uploadPromise) {
          const uploadedFile = await uploadPromise;
          if (uploadError) throw uploadError;
          return res.status(201).json({ success: true, file: uploadedFile });
        }
        return res.status(400).json({ error: 'No file uploaded in request' });
      } catch (err) {
        if (!res.headersSent) {
          return res.status(500).json({ error: err.message || 'Cloud upload failed' });
        }
      }
    });

    busboy.on('error', (err) => {
      if (!res.headersSent) {
        return res.status(500).json({ error: err.message });
      }
    });

    req.pipe(busboy);
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});

/**
 * POST /api/providers/:id/move
 */
router.post('/:id/move', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const { src, dst } = req.body;
    if (!src || !dst) return res.status(400).json({ error: 'src and dst are required' });

    const { provider } = await getProviderInstanceForUser(connId, userId);
    await provider.move(src, dst);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/providers/:id/mkdir
 */
router.post('/:id/mkdir', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const connId = req.params.id;
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });

    const { provider } = await getProviderInstanceForUser(connId, userId);
    await provider.mkdir(dirPath);
    res.status(201).json({ success: true, path: dirPath });
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
