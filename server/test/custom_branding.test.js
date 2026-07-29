const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const db = require('../db');
const settingsRouter = require('../routes/settings');
const publicShareRouter = require('../routes/public_share');

async function setupApp() {
  await db.initDb();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test_branding_secret',
    resave: false,
    saveUninitialized: true
  }));

  // Mock auth middleware
  app.use((req, res, next) => {
    const authHeader = req.headers['x-test-user'];
    if (authHeader) {
      req.session = req.session || {};
      req.session.userId = authHeader;
      req.session.user = { id: authHeader, username: authHeader };
    }
    next();
  });

  app.use('/api/settings', settingsRouter);
  app.use('/s', publicShareRouter);
  return app;
}

test('Custom Branding: Unauthenticated access to /api/settings/branding returns 401', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const resGet = await fetch(`http://localhost:${port}/api/settings/branding`);
    assert.equal(resGet.status, 401);

    const resPost = await fetch(`http://localhost:${port}/api/settings/branding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary_color: '#ff0000' })
    });
    assert.equal(resPost.status, 401);
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Custom Branding: DB helper operations (getUserBranding, setUserBranding, deleteUserBranding)', async (t) => {
  await db.initDb();
  const userId = 'user_brand_db_test';
  await db.upsertUser(userId, 'brand_user', 'brand@example.com');

  try {
    // Default initial branding should be empty/default values
    const initial = await db.getUserBranding(userId);
    assert.ok(initial);
    assert.equal(initial.user_id, userId);
    assert.equal(initial.logo_url, null);

    // Update user branding
    const updated = await db.setUserBranding(userId, {
      logo_url: 'https://example.com/logo.png',
      primary_color: '#3b82f6',
      welcome_message: 'Welcome to Acme Portal',
      custom_domain: 'files.acme.com'
    });

    assert.equal(updated.user_id, userId);
    assert.equal(updated.logo_url, 'https://example.com/logo.png');
    assert.equal(updated.primary_color, '#3b82f6');
    assert.equal(updated.welcome_message, 'Welcome to Acme Portal');
    assert.equal(updated.custom_domain, 'files.acme.com');

    // Retrieve saved branding
    const retrieved = await db.getUserBranding(userId);
    assert.equal(retrieved.logo_url, 'https://example.com/logo.png');

    // Delete custom branding
    const deleted = await db.deleteUserBranding(userId);
    assert.equal(deleted, true);

    const afterDelete = await db.getUserBranding(userId);
    assert.equal(afterDelete.logo_url, null);
    assert.equal(afterDelete.primary_color, null);
  } finally {
    await db.closeDb();
  }
});

test('Custom Branding: GET & POST /api/settings/branding endpoints', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_brand_api_1';

  try {
    await db.upsertUser(userId, 'brand_api_user');
    await db.deleteUserBranding(userId);

    // GET initial settings
    const resGet1 = await fetch(`http://localhost:${port}/api/settings/branding`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resGet1.status, 200);
    const bodyGet1 = await resGet1.json();
    assert.equal(bodyGet1.success, true);
    assert.equal(bodyGet1.branding.logo_url, null);

    // POST update settings
    const resPost = await fetch(`http://localhost:${port}/api/settings/branding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': userId
      },
      body: JSON.stringify({
        logo_url: 'https://cdn.example.com/custom-logo.svg',
        primary_color: '#8b5cf6',
        welcome_message: 'Custom Freeshard Share',
        custom_domain: 'share.mysite.org'
      })
    });
    assert.equal(resPost.status, 200);
    const bodyPost = await resPost.json();
    assert.equal(bodyPost.success, true);
    assert.equal(bodyPost.branding.primary_color, '#8b5cf6');
    assert.equal(bodyPost.branding.custom_domain, 'share.mysite.org');

    // GET updated settings
    const resGet2 = await fetch(`http://localhost:${port}/api/settings/branding`, {
      headers: { 'x-test-user': userId }
    });
    const bodyGet2 = await resGet2.json();
    assert.equal(bodyGet2.branding.welcome_message, 'Custom Freeshard Share');
  } finally {
    server.close();
    await db.closeDb();
  }
});

test('Custom Branding: Public share link renders owner custom branding in HTML and JSON', async (t) => {
  const app = await setupApp();
  const server = app.listen(0);
  const port = server.address().port;
  const userId = 'user_brand_public';
  const token = 'brand_share_token_' + Date.now();

  try {
    await db.upsertUser(userId, 'brand_owner');
    await db.setUserBranding(userId, {
      logo_url: 'https://brand.local/logo.png',
      primary_color: '#10b981',
      welcome_message: 'Welcome to Secure Downloads',
      custom_domain: 'dl.brand.local'
    });

    await db.createPublicShare(userId, token, '/documents/report.pdf', 0);

    // HTML view test
    const resHtml = await fetch(`http://localhost:${port}/s/${token}`);
    assert.equal(resHtml.status, 200);
    const htmlText = await resHtml.text();
    assert.ok(htmlText.includes('#10b981'), 'HTML contains primary color');
    assert.ok(htmlText.includes('https://brand.local/logo.png'), 'HTML contains custom logo');
    assert.ok(htmlText.includes('Welcome to Secure Downloads'), 'HTML contains welcome message');

    // JSON view test
    const resJson = await fetch(`http://localhost:${port}/s/${token}`, {
      headers: { 'Accept': 'application/json' }
    });
    assert.equal(resJson.status, 200);
    const jsonBody = await resJson.json();
    assert.ok(jsonBody.branding);
    assert.equal(jsonBody.branding.primary_color, '#10b981');
    assert.equal(jsonBody.branding.logo_url, 'https://brand.local/logo.png');
    assert.equal(jsonBody.branding.welcome_message, 'Welcome to Secure Downloads');
    assert.equal(jsonBody.branding.custom_domain, 'dl.brand.local');
  } finally {
    server.close();
    await db.closeDb();
  }
});
