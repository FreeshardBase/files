const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const BaseProvider = require('../providers/base');
const DropboxProvider = require('../providers/dropbox');

describe('DropboxProvider & Multi-Cloud Storage Contract (#56)', () => {
  const credentials = {
    clientId: 'dropbox-app-key-123',
    clientSecret: 'dropbox-secret-456',
    refreshToken: 'dropbox-refresh-token-789'
  };

  test('inherits from BaseProvider contract', () => {
    const provider = new DropboxProvider(credentials);
    assert.ok(provider instanceof BaseProvider);
    assert.equal(provider.clientId, credentials.clientId);
    assert.equal(provider.clientSecret, credentials.clientSecret);
    assert.equal(provider.refreshToken, credentials.refreshToken);
  });

  test('formats metadata objects accurately for Dropbox items', async () => {
    const provider = new DropboxProvider(credentials);
    provider.getValidAccessToken = async () => 'mock-access-token';
    provider._dropboxRpcApi = async (apiPath) => {
      if (apiPath === '/files/get_metadata') {
        return {
          body: JSON.stringify({
            '.tag': 'file',
            name: 'report.pdf',
            path_display: '/Documents/report.pdf',
            size: 1048576,
            server_modified: '2026-07-25T16:00:00Z'
          })
        };
      }
    };

    const meta = await provider.metadata('/Documents/report.pdf');
    assert.equal(meta.name, 'report.pdf');
    assert.equal(meta.path, '/Documents/report.pdf');
    assert.equal(meta.isDirectory, false);
    assert.equal(meta.size, 1048576);
  });

  test('formats Dropbox-API-Arg with unicode escape sequences for RFC 5987 compliance', () => {
    const provider = new DropboxProvider(credentials);
    const formatted = provider._formatApiArg({ path: '/Indira/Cover (Español).jpg', mode: 'overwrite' });
    assert.ok(!/[\u007f-\uffff]/.test(formatted), 'Header must contain zero unescaped non-ASCII characters');
    assert.ok(formatted.includes('\\u00f1'), 'Spanish ñ must be escaped to \\u00f1');
  });

  describe('Dropbox Webhooks & Delta Sync (#57)', () => {
    test('getLatestCursor retrieves cursor from Dropbox API', async () => {
      const provider = new DropboxProvider(credentials);
      provider.getValidAccessToken = async () => 'mock-access-token';
      provider._dropboxRpcApi = async (apiPath, body) => {
        assert.equal(apiPath, '/files/list_folder/get_latest_cursor');
        assert.equal(body.path, '/Folder');
        return {
          body: JSON.stringify({ cursor: 'cursor_abc123_latest' })
        };
      };

      const result = await provider.getLatestCursor('/Folder');
      assert.equal(result.cursor, 'cursor_abc123_latest');
    });

    test('listFolderContinue returns delta changes and new cursor', async () => {
      const provider = new DropboxProvider(credentials);
      provider.getValidAccessToken = async () => 'mock-access-token';
      provider._dropboxRpcApi = async (apiPath, body) => {
        assert.equal(apiPath, '/files/list_folder/continue');
        assert.equal(body.cursor, 'cursor_abc123');
        return {
          body: JSON.stringify({
            cursor: 'cursor_def456',
            has_more: false,
            entries: [
              { '.tag': 'file', name: 'new.pdf', path_display: '/new.pdf', size: 500, server_modified: '2026-07-29T10:00:00Z' },
              { '.tag': 'deleted', path_display: '/old.txt' }
            ]
          })
        };
      };

      const delta = await provider.listFolderContinue('cursor_abc123');
      assert.equal(delta.cursor, 'cursor_def456');
      assert.equal(delta.hasMore, false);
      assert.equal(delta.entries.length, 2);
      assert.equal(delta.entries[0].name, 'new.pdf');
      assert.equal(delta.entries[1].deleted, true);
    });

    test('fetchDelta paginating through multiple pages until has_more is false', async () => {
      const provider = new DropboxProvider(credentials);
      provider.getValidAccessToken = async () => 'mock-access-token';
      let callCount = 0;
      provider.listFolderContinue = async (cursor) => {
        callCount++;
        if (callCount === 1) {
          return {
            cursor: 'cursor_page2',
            hasMore: true,
            entries: [{ name: 'file1.txt', path: '/file1.txt', isDirectory: false }]
          };
        }
        return {
          cursor: 'cursor_final',
          hasMore: false,
          entries: [{ name: 'file2.txt', path: '/file2.txt', isDirectory: false }]
        };
      };

      const res = await provider.fetchDelta('cursor_page1');
      assert.equal(res.cursor, 'cursor_final');
      assert.equal(res.entries.length, 2);
      assert.equal(res.entries[0].name, 'file1.txt');
      assert.equal(res.entries[1].name, 'file2.txt');
    });

    test('verifyWebhookSignature validates HMAC-SHA256 signature', () => {
      const crypto = require('crypto');
      const secret = 'my-dropbox-app-secret';
      const body = JSON.stringify({ list_folder: { accounts: ['dbid:123'] } });
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const isValid = DropboxProvider.verifyWebhookSignature(hmac, body, secret);
      assert.equal(isValid, true);

      const isInvalid = DropboxProvider.verifyWebhookSignature('invalid_sig', body, secret);
      assert.equal(isInvalid, false);
    });
  });

  describe('Dropbox Webhook HTTP API Endpoints (#57)', () => {
    let server;
    let baseUrl;

    before(async () => {
      const express = require('express');
      const providersRouter = require('../routes/providers');
      const app = express();
      app.use(express.json());
      app.use('/api/providers', providersRouter);
      await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        await new Promise(resolve => server.close(resolve));
      }
    });

    test('GET /api/providers/dropbox/webhook echoes back challenge query parameter', async () => {
      const res = await fetch(`${baseUrl}/api/providers/dropbox/webhook?challenge=test_challenge_xyz_999`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(text, 'test_challenge_xyz_999');
    });

    test('POST /api/providers/dropbox/webhook accepts delta notification payload', async () => {
      const crypto = require('crypto');
      const secret = process.env.DROPBOX_CLIENT_SECRET || 'dropbox-secret-456';
      const payload = {
        list_folder: {
          accounts: ['dbid:AAB1234567890']
        },
        users: ['dbid:AAB1234567890']
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const res = await fetch(`${baseUrl}/api/providers/dropbox/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dropbox-Signature': signature
        },
        body: rawBody
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });
  });
});

