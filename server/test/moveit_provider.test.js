const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const BaseProvider = require('../providers/base');
const MOVEitProvider = require('../providers/MOVEitProvider');
const { providers, getProvider } = require('../providers/index');

describe('MOVEitProvider & Provider Factory Integration (#70)', () => {
  test('MOVEitProvider inherits from BaseProvider', () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    assert.ok(provider instanceof BaseProvider);
    assert.equal(provider.host, 'moveit.example.com');
  });

  test('Provider factory in index.js registers moveit provider', () => {
    assert.ok(providers.moveit);
    assert.equal(providers.moveit, MOVEitProvider);

    const instance = getProvider('moveit', { host: 'moveit.example.com', accessToken: 'mock_token' });
    assert.ok(instance instanceof MOVEitProvider);
  });

  test('OAuth 2.0 token refresh requests valid access token', async () => {
    const provider = new MOVEitProvider({
      host: 'moveit.example.com',
      clientId: 'moveit_client',
      clientSecret: 'moveit_secret',
      refreshToken: 'valid_refresh_token'
    });

    provider._httpRequest = async (options, bodyData) => {
      assert.equal(options.hostname, 'moveit.example.com');
      assert.equal(options.path, '/api/v1/token');
      assert.equal(options.method, 'POST');
      assert.ok(bodyData.includes('grant_type=refresh_token'));
      return {
        statusCode: 200,
        body: JSON.stringify({ access_token: 'new_access_token', expires_in: 3600 })
      };
    };

    const token = await provider.getValidAccessToken(true);
    assert.equal(token, 'new_access_token');
    assert.equal(provider.accessToken, 'new_access_token');
  });

  test('list returns normalized item entries', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/folders/root/items');
      return {
        items: [
          { id: '101', name: 'Reports', isDirectory: true, size: 0, modified: '2026-07-28T10:00:00Z', mimeType: null },
          { id: '102', name: 'doc.pdf', isDirectory: false, size: 1024, modified: '2026-07-28T11:00:00Z', mimeType: 'application/pdf' }
        ]
      };
    };

    const items = await provider.list('/');
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'Reports');
    assert.equal(items[0].isDirectory, true);
    assert.equal(items[1].name, 'doc.pdf');
    assert.equal(items[1].size, 1024);
  });

  test('read fetches file stream and size', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._httpRequest = async (options) => {
      assert.equal(options.path, '/api/v1/files/file_123/download');
      return {
        statusCode: 200,
        headers: { 'content-length': '12', 'content-type': 'text/plain' },
        buffer: Buffer.from('hello moveit')
      };
    };

    const res = await provider.read('/file_123');
    assert.ok(res.stream);
    assert.equal(res.size, 12);
    const content = await BaseProvider.streamToBuffer(res.stream);
    assert.equal(content.toString('utf8'), 'hello moveit');
  });

  test('write buffers stream data and creates file', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    let uploadedBuffer = null;

    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/folders/root/files');
      assert.equal(options.method, 'POST');
      uploadedBuffer = options.body;
      return { id: 'file_999', name: 'test.txt', size: 14 };
    };

    const stream = Readable.from([Buffer.from('stream payload')]);
    const result = await provider.write('/test.txt', stream);
    assert.equal(result.size, 14);
    assert.ok(uploadedBuffer);
    assert.equal(uploadedBuffer.toString('utf8'), 'stream payload');
  });

  test('delete removes file or folder', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/files/file_123');
      assert.equal(options.method, 'DELETE');
      return { success: true };
    };

    const deleted = await provider.delete('/file_123');
    assert.equal(deleted, true);
  });

  test('mkdir creates subfolder', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/folders');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.name, 'NewFolder');
      return { id: 'folder_456', name: 'NewFolder', isDirectory: true };
    };

    const success = await provider.mkdir('/NewFolder');
    assert.equal(success, true);
  });

  test('move renames or relocates file', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/files/file_123/move');
      assert.equal(options.method, 'POST');
      return { success: true };
    };

    const moved = await provider.move('/file_123', '/archive/file_123');
    assert.equal(moved, true);
  });

  test('copy duplicates file', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path, options) => {
      assert.equal(path, '/api/v1/files/file_123/copy');
      assert.equal(options.method, 'POST');
      return { success: true };
    };

    const copied = await provider.copy('/file_123', '/copy_file_123');
    assert.equal(copied, true);
  });

  test('getQuota retrieves storage capacity', async () => {
    const provider = new MOVEitProvider({ host: 'moveit.example.com', accessToken: 'mock_token' });
    provider._moveitApi = async (path) => {
      assert.equal(path, '/api/v1/users/self');
      return { quotaBytes: 10737418240, usedBytes: 2147483648 };
    };

    const quota = await provider.getQuota();
    assert.equal(quota.total, 10737418240);
    assert.equal(quota.used, 2147483648);
  });
});
