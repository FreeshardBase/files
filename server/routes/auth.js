const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Issuer, generators, custom } = require('openid-client');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureUserHome } = require('../middleware/isolation');

// Increase HTTP timeout for OIDC discovery / metadata requests (default 3500ms is too strict)
custom.setHttpOptionsDefaults({ timeout: 15000 });

let oidcClient = null;
let oidcDiscoveryPromise = null;

async function getOidcClient() {
  if (oidcClient) return oidcClient;
  if (oidcDiscoveryPromise) return oidcDiscoveryPromise;

  const issuerUrl = process.env.OIDC_ISSUER_URL || 'https://auth.gryzia.de';
  const clientId = process.env.OIDC_CLIENT_ID || 'freeshard-files';
  const clientSecret = process.env.OIDC_CLIENT_SECRET || 'CHANGE_ME_TO_YOUR_AUTHELIA_SECRET';
  const redirectUri = process.env.OIDC_REDIRECT_URI || `${process.env.APP_URL || 'https://fs-files.gryzia.de'}/api/auth/callback`;
  const tokenAuthMethod = process.env.OIDC_TOKEN_AUTH_METHOD || 'client_secret_basic';

  oidcDiscoveryPromise = (async () => {
    try {
      const issuer = await Issuer.discover(issuerUrl);
      oidcClient = new issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: tokenAuthMethod
      });
      return oidcClient;
    } catch (err) {
      console.warn('[OIDC] Discovery error:', err.message);
      oidcDiscoveryPromise = null;
      return null;
    }
  })();

  return oidcDiscoveryPromise;
}

// ── GET /api/auth/config (Public auth UI config #2, #54, #55) ─────────────────
router.get('/config', (req, res) => {
  const enableLocalAuth = process.env.ENABLE_LOCAL_AUTH !== 'false';
  const enableOidcAuth = process.env.ENABLE_OIDC_AUTH !== 'false';
  const enableAutoOidcAuth = process.env.AUTO_OIDC_LOGIN === 'true';
  const oidcButtonLabel = process.env.OIDC_BUTTON_LABEL || 'Login mit SSO (Authelia)';

  res.json({
    enableLocalAuth,
    enableOidcAuth,
    enableAutoOidcAuth,
    oidcButtonLabel
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  if (process.env.E2E_TEST === 'true' && (!req.session || !req.session.userId)) {
    try {
      let user = await db.get('SELECT * FROM users WHERE username = ?', ['default-user']);
      if (!user) {
        user = await db.upsertUser('default-user', 'default-user', 'default@freeshard.local');
      }
      if (req.session) {
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.displayName = user.display_name || user.username;
      }
    } catch (e2eErr) {
      console.warn('[E2E Auth Bypass Error]', e2eErr.message);
    }
  }

  if (req.session && req.session.userId) {
    try {
      const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
      const username = user?.username || req.session.username || 'User';
      const displayName = user?.display_name || username;

      return res.json({
        authenticated: true,
        user: {
          id: req.session.userId,
          username,
          displayName,
          email: user?.email || req.session.email || null,
          avatarUrl: user?.avatar_url || req.session.avatarUrl || null,
          preferredLocale: user?.preferred_locale || null,
          preferredViewMode: user?.preferred_view_mode || 'grid',
          preferredClickMode: user?.preferred_click_mode || 'double',
          preferredTheme: user?.preferred_theme || 'dark'
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ authenticated: false });
});

// ── PATCH /api/users/me (Update User Profile #25, #33, #48, #49, #68) ───────────────────────
router.patch('/users/me', requireAuth, async (req, res) => {
  try {
    const { displayName, preferredLocale, preferredViewMode, preferredClickMode, preferredTheme, avatarUrl } = req.body;
    const userId = req.session.userId;

    if (displayName !== undefined) {
      await db.run('UPDATE users SET display_name = ? WHERE id = ?', [displayName, userId]);
      req.session.displayName = displayName;
    }

    if (avatarUrl !== undefined) {
      await db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, userId]);
      req.session.avatarUrl = avatarUrl;
    }

    if (preferredLocale !== undefined) {
      if (!['en', 'de'].includes(preferredLocale)) {
        return res.status(400).json({ error: `Invalid locale "${preferredLocale}": must be one of "en", "de"` });
      }
      await db.run('UPDATE users SET preferred_locale = ? WHERE id = ?', [preferredLocale, userId]);
      req.session.preferredLocale = preferredLocale;
    }

    if (preferredTheme !== undefined) {
      if (!['dark', 'light', 'system'].includes(preferredTheme)) {
        return res.status(400).json({ error: `Invalid theme "${preferredTheme}": must be one of "dark", "light", "system"` });
      }
      await db.run('UPDATE users SET preferred_theme = ? WHERE id = ?', [preferredTheme, userId]);
      req.session.preferredTheme = preferredTheme;
    }

    if (preferredViewMode !== undefined && ['grid', 'list'].includes(preferredViewMode)) {
      await db.run('UPDATE users SET preferred_view_mode = ? WHERE id = ?', [preferredViewMode, userId]);
      req.session.preferredViewMode = preferredViewMode;
    }

    if (preferredClickMode !== undefined && ['double', 'single'].includes(preferredClickMode)) {
      await db.updateUserClickMode(userId, preferredClickMode);
      req.session.preferredClickMode = preferredClickMode;
    }

    const updatedUser = await db.get('SELECT id, username, display_name, email, avatar_url, preferred_locale, preferred_view_mode, preferred_click_mode, preferred_theme FROM users WHERE id = ?', [userId]);
    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        list[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('='));
      }
    });
  }
  return list;
}

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

    const isSecure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    const oidcCookieVal = encodeURIComponent(JSON.stringify({ state, nonce, code_verifier }));
    res.setHeader('Set-Cookie', [
      `fs_oidc_state=${oidcCookieVal}; Path=/; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=600`
    ]);

    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge,
      code_challenge_method: 'S256'
    });

    req.session.save((saveErr) => {
      if (saveErr) console.error('[OIDC Login Session Save Error]', saveErr);
      res.redirect(authUrl);
    });
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
    const cookies = parseCookies(req);

    let state = req.session ? req.session.oidcState : undefined;
    let nonce = req.session ? req.session.oidcNonce : undefined;
    let code_verifier = req.session ? req.session.code_verifier : undefined;

    if (!state && cookies.fs_oidc_state) {
      try {
        const parsed = JSON.parse(cookies.fs_oidc_state);
        state = parsed.state;
        nonce = parsed.nonce;
        code_verifier = parsed.code_verifier;
      } catch (cookieErr) {
        console.warn('[OIDC Cookie Parse Warning]', cookieErr.message);
      }
    }

    if (!state && req.query.state) {
      state = req.query.state;
    }

    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI || `${process.env.APP_URL || 'https://fs-files.gryzia.de'}/api/auth/callback`,
      params,
      { state, nonce, code_verifier }
    );

    // Query UserInfo endpoint to fetch profile claims (preferred_username, name, email) (#48)
    let userinfo = {};
    if (tokenSet.access_token) {
      try {
        userinfo = await client.userinfo(tokenSet.access_token);
      } catch (uiErr) {
        console.warn('[OIDC UserInfo Warning]', uiErr.message);
      }
    }

    const claims = { ...tokenSet.claims(), ...userinfo };
    const userId = claims.sub;
    
    // Human-Centric Naming Fallback Hierarchy (#48)
    const displayName = claims.name || claims.preferred_username || claims.username || null;
    const username = claims.preferred_username || claims.username || (claims.email ? claims.email.split('@')[0] : null) || claims.sub;
    const email = claims.email || null;
    const avatarUrl = claims.picture || claims.avatar_url || claims.avatar || null;

    // Just-In-Time User Provisioning in SQLite DB (#2, #13, #48, #49)
    await db.upsertUser(userId, username, email, 'oidc', null, displayName, null, null, avatarUrl);

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
    req.session.displayName = displayName || username;
    req.session.email = email;
    req.session.avatarUrl = avatarUrl;

    req.session.save((saveErr) => {
      if (saveErr) console.error('[OIDC Session Save Error]', saveErr);
      res.redirect('/#/files');
    });
  } catch (err) {
    console.error('[OIDC Callback Error]', err);
    res.redirect(`/#/login?error=${encodeURIComponent(err.message)}`);
  }
});

// ── OIDC BACK-CHANNEL LOGOUT 1.0 ──────────────────────────────────────────────
router.post('/backchannel-logout', express.urlencoded({ extended: true }), async (req, res) => {
  const logoutToken = req.body.logout_token;
  if (!logoutToken) return res.status(400).send('Missing logout_token');

  try {
    const client = await getOidcClient();
    if (!client) return res.status(500).send('OIDC client uninitialized');

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
  if (process.env.ENABLE_LOCAL_AUTH === 'false') {
    return res.status(403).json({ error: 'Local authentication is disabled' });
  }

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
    req.session.displayName = user.display_name || user.username;
    req.session.email = user.email;

    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name || user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/register', async (req, res) => {
  if (process.env.ENABLE_LOCAL_AUTH === 'false') {
    return res.status(403).json({ error: 'Local authentication is disabled' });
  }

  const { username, password, email, displayName } = req.body;
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

    await db.upsertUser(userId, username, email || null, 'local', null, displayName || username);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);

    const rootBase = process.env.FILES_ROOT || path.join(__dirname, '..', '..', 'data', 'users');
    await ensureUserHome(path.join(rootBase, userId));

    req.session.userId = userId;
    req.session.username = username;
    req.session.displayName = displayName || username;

    res.status(201).json({ success: true, user: { id: userId, username, displayName: displayName || username } });
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

    const plainPassword = 'fs_asp_' + crypto.randomBytes(16).toString('hex');
    const hash = await bcrypt.hash(plainPassword, 10);

    const result = await db.run(
      'INSERT INTO app_passwords (user_id, label, password_hash) VALUES (?, ?, ?)',
      [req.session.userId, label, hash]
    );

    res.status(201).json({
      id: result.lastID,
      label,
      password: plainPassword
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
