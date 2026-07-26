const { test, describe } = require('node:test');
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
});
