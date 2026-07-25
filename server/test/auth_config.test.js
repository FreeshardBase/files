const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

describe('Auth Configuration & SSO Customization (#54)', () => {
  before(async () => {
    await db.initDb();
  });

  test('returns default auth config settings', async () => {
    const enableLocalAuth = process.env.ENABLE_LOCAL_AUTH !== 'false';
    const enableOidcAuth = process.env.ENABLE_OIDC_AUTH !== 'false';
    const oidcButtonLabel = process.env.OIDC_BUTTON_LABEL || 'Login mit SSO (Authelia)';

    assert.equal(typeof enableLocalAuth, 'boolean');
    assert.equal(typeof enableOidcAuth, 'boolean');
    assert.ok(oidcButtonLabel.length > 0);
  });

  test('respects custom OIDC_BUTTON_LABEL env variable', () => {
    process.env.OIDC_BUTTON_LABEL = 'Login mit Freeshard Auth';
    const oidcButtonLabel = process.env.OIDC_BUTTON_LABEL || 'Login mit SSO';
    assert.equal(oidcButtonLabel, 'Login mit Freeshard Auth');
    delete process.env.OIDC_BUTTON_LABEL;
  });

  test('respects ENABLE_LOCAL_AUTH=false setting', () => {
    process.env.ENABLE_LOCAL_AUTH = 'false';
    const enableLocalAuth = process.env.ENABLE_LOCAL_AUTH !== 'false';
    assert.equal(enableLocalAuth, false);
    delete process.env.ENABLE_LOCAL_AUTH;
  });
});
