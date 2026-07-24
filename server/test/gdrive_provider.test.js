const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const BaseProvider = require('../providers/base');
const GoogleDriveProvider = require('../providers/gdrive');

describe('GoogleDriveProvider & Multi-Cloud Storage Contract (#7)', () => {
  const sampleConfig = {
    clientId: 'mock_client_id_123',
    clientSecret: 'mock_client_secret_456',
    refreshToken: 'mock_refresh_token_789',
    accessToken: 'mock_access_token_000',
    rootFolderId: 'root_folder_id_xyz'
  };

  test('inherits from BaseProvider contract', () => {
    const provider = new GoogleDriveProvider(sampleConfig);
    assert.ok(provider instanceof BaseProvider);
  });

  test('initializes pathCache with root folder mapping', () => {
    const provider = new GoogleDriveProvider(sampleConfig);
    assert.equal(provider.rootFolderId, 'root_folder_id_xyz');
    
    const rootInfo = provider.pathCache.get('/');
    assert.ok(rootInfo);
    assert.equal(rootInfo.id, 'root_folder_id_xyz');
    assert.equal(rootInfo.isDirectory, true);
  });

  test('resolves root path immediately from cache', async () => {
    const provider = new GoogleDriveProvider(sampleConfig);
    const resolved = await provider.resolvePathToId('/');
    assert.equal(resolved.id, 'root_folder_id_xyz');
    assert.equal(resolved.isDirectory, true);
  });

  test('formats metadata objects accurately for Google Drive items', async () => {
    const provider = new GoogleDriveProvider(sampleConfig);
    provider.pathCache.set('/TestDoc.pdf', {
      id: 'file_id_999',
      isDirectory: false,
      mimeType: 'application/pdf',
      size: 102450,
      modified: '2026-07-24T10:00:00.000Z'
    });

    const meta = await provider.metadata('/TestDoc.pdf');
    assert.equal(meta.name, 'TestDoc.pdf');
    assert.equal(meta.path, '/TestDoc.pdf');
    assert.equal(meta.isDirectory, false);
    assert.equal(meta.size, 102450);
    assert.equal(meta.mimeType, 'application/pdf');
  });
});
