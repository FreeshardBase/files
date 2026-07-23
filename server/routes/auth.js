const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Issuer, generators } = require('openid-client');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUserHome } = require('../middleware/isolation');

let oidcClient = null;

async function getOidcClient() {
  if (oidcClient) return oidcClient;

  const issuerUrl = process.env.OIDC_ISSUER_URL || 'https://auth.gryzia.de';
  const clientId = process.env.OIDC_CLIENT_ID || 'freeshard-files';
  const clientSecret = process.env.OIDC_CLIENT_SECRET || 'CHANGE_ME_TO_YOUR_AUTHELIA_SECRET';
  const redirectUri = process.env.OIDC_REDIRECT_URI || `${process.env.APP_URL || 'https://fs-files.gryzia.de'}/api/auth/callback`;

  try {
    const issuer = await Issuer.discover(issuerUrl);
    oidcClient = new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code']
    });
    return oidcClient;
  } catch (err) {
    console.warn('[OIDC] Discovery warning:', err.message);
    return null;
  }
}

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      authenticated: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        email: req.session.email || null
      }
    });
  }
  res.json({ authenticated: false });
});

// ── OIDC LOGIN ────────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  const authMethod = process.env.AUTH_METHOD || 'oidc';

  if (authMethod === 'local') {
    return res.redirect('/#/login');
  }

  try {
    const client = await getOidcClient();
    if (!client) {
      return res.status(500).json({ error: 'OIDC Provider unavailable' });
    }

    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();

    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.code_verifier = code_verifier;

    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge,
      code_challenge_method: 'S256'
    });

    res.redirect(authUrl);
  } catch (err) {
    console.error('[OIDC Login Error]', err);
    res.status(500).json({ error: 'OIDC redirect failed: ' + err.message });
  }
});

// ── OIDC CALLBACK ─────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  try {
    const client = await getOidcClient();
    if (!client) {
      return res.status(500).json({ error: 'OIDC Provider unavailable' });
    }

    const params = client.callbackParams(req);
    const state = req.session.oidcState;
    const nonce = req.session.oidcNonce;
    const code_verifier = req.session.code_verifier;

    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI || `${process.env.APP_URL || 'https://fs-files.gryzia.de'}/api/auth/callback`,
      params,
      { state, nonce, code_verifier }
    );

    const claims = tokenSet.claims();
    const userId = claims.sub;
    const username = claims.preferred_username || claims.name || claims.sub;
    const email = claims.email || null;

    // Just-In-Time User Provisioning in SQLite DB (Issue #2, #13)
    await db.upsertUser(userId, username, email, 'oidc');

    // Auto-provision user home directory structure
    const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
    await ensureUserHome(path.join(rootBase, userId));

    // Clear OIDC session temp state
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.code_verifier;

    // Establish authenticated session
    req.session.userId = userId;
    req.session.username = username;
    req.session.email = email;

    res.redirect('/#/files');
  } catch (err) {
    console.error('[OIDC Callback Error]', err);
    res.status(401).send(`Authentication failed: ${err.message}`);
  }
});

// ── OIDC BACK-CHANNEL LOGOUT 1.0 ──────────────────────────────────────────────
router.post('/backchannel-logout', express.urlencoded({ extended: true }), async (req, res) => {
  const logoutToken = req.body.logout_token;
  if (!logoutToken) return res.status(400).send('Missing logout_token');

  try {
    const client = await getOidcClient();
    if (!client) return res.status(500).send('OIDC client uninitialized');

    // Verify token claims & signature against IDP JWKS
    const claims = await client.decryptIdToken(logoutToken);

    if (!claims.sub && !claims.sid) {
      return res.status(400).send('logout_token must contain sub or sid');
    }
    if (claims.nonce) {
      return res.status(400).send('logout_token must NOT contain a nonce');
    }
    if (!claims.events || !claims.events['http://schemas.openid.net/event/backchannel-logout']) {
      return res.status(400).send('Invalid events claim');
    }

    // Clear matching session
    const { sub } = claims;
    if (sub) {
      await db.run('DELETE FROM users WHERE id = ?', [sub]);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Back-Channel Logout Error]', err.message);
    res.status(400).send('Invalid logout_token');
  }
});

// ── LOCAL AUTH (Fallback) ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.email = user.email;

    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();

    await db.upsertUser(userId, username, email || null, 'local');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

    const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
    await ensureUserHome(path.join(rootBase, userId));

    req.session.userId = userId;
    req.session.username = username;

    res.status(201).json({ success: true, user: { id: userId, username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  } else {
    res.json({ success: true });
  }
});

// ── APP PASSWORDS (ASPs for WebDAV Access #2, #21) ────────────────────────────
router.get('/app-passwords', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT id, label, created_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json({ appPasswords: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/app-passwords', requireAuth, async (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });

    // Generate random App-Specific Password (e.g. fs_asp_...)
    const plainPassword = 'fs_asp_' + crypto.randomBytes(16).toString('hex');
    const hash = await bcrypt.hash(plainPassword, 10);

    const result = await db.run(
      'INSERT INTO app_passwords (user_id, label, password_hash) VALUES (?, ?, ?)',
      [req.session.userId, label, hash]
    );

    res.status(201).json({
      id: result.lastID,
      label,
      password: plainPassword // Only shown ONCE on creation
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/app-passwords/:id', requireAuth, async (req, res) => {
  try {
    await db.run(
      'DELETE FROM app_passwords WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
