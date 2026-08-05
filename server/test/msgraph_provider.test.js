const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const BaseProvider = require('../providers/base');
const OneDriveProvider = require('../providers/onedrive');
const SharePointProvider = require('../providers/sharepoint');

describe('Microsoft Graph OneDriveProvider (#82)', () => {
  const credentials = {
    clientId: 'ms-client-id-123',
    clientSecret: 'ms-client-secret-456',
    refreshToken: 'ms-refresh-token-789',
    accessToken: 'ms-access-token-000'
  };

  test('inherits from BaseProvider contract', () => {
    const provider = new OneDriveProvider(credentials);
    assert.ok(provider instanceof BaseProvider);
    assert.equal(provider.clientId, credentials.clientId);
    assert.equal(provider.clientSecret, credentials.clientSecret);
    assert.equal(provider.refreshToken, credentials.refreshToken);
  });

  test('formats metadata objects accurately for OneDrive items', async () => {
    const provider = new OneDriveProvider(credentials);
    provider.getValidAccessToken = async () => 'mock-access-token';
    provider._graphApi = async (apiPath) => {
      if (apiPath.includes('/root:/Documents/presentation.pptx:')) {
        return {
          id: 'drive_item_111',
          name: 'presentation.pptx',
          size: 2097152,
          lastModifiedDateTime: '2026-08-01T12:00:00Z',
          file: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
        };
      }
    };

    const meta = await provider.metadata('/Documents/presentation.pptx');
    assert.equal(meta.name, 'presentation.pptx');
    assert.equal(meta.path, '/Documents/presentation.pptx');
    assert.equal(meta.isDirectory, false);
    assert.equal(meta.size, 2097152);
    assert.equal(meta.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  test('list returns formatted array of OneDrive items', async () => {
    const provider = new OneDriveProvider(credentials);
    provider.getValidAccessToken = async () => 'mock-access-token';
    provider._graphApi = async (apiPath) => {
      if (apiPath.includes('/children')) {
        return {
          value: [
            { id: '1', name: 'FolderA', folder: { childCount: 2 }, size: 0, lastModifiedDateTime: '2026-08-01T10:00:00Z' },
            { id: '2', name: 'FileB.docx', file: { mimeType: 'application/docx' }, size: 1024, lastModifiedDateTime: '2026-08-01T11:00:00Z' }
          ]
        };
      }
    };

    const items = await provider.list('/');
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'FolderA');
    assert.equal(items[0].isDirectory, true);
    assert.equal(items[1].name, 'FileB.docx');
    assert.equal(items[1].isDirectory, false);
    assert.equal(items[1].size, 1024);
  });

  test('getQuota retrieves OneDrive storage usage and capacity', async () => {
    const provider = new OneDriveProvider(credentials);
    provider.getValidAccessToken = async () => 'mock-access-token';
    provider._graphApi = async (apiPath) => {
      if (apiPath === '/me/drive') {
        return {
          quota: {
            used: 5368709120,
            total: 107374182400
          }
        };
      }
    };

    const quota = await provider.getQuota();
    assert.equal(quota.used, 5368709120);
    assert.equal(quota.total, 107374182400);
  });
});

describe('Microsoft Graph SharePointProvider (#82)', () => {
  const credentials = {
    clientId: 'ms-client-id-123',
    clientSecret: 'ms-client-secret-456',
    refreshToken: 'ms-refresh-token-789',
    siteId: 'contoso.sharepoint.com,site-guid,web-guid',
    driveId: 'b!drive_guid_123'
  };

  test('inherits from BaseProvider contract and targets site/drive', () => {
    const provider = new SharePointProvider(credentials);
    assert.ok(provider instanceof BaseProvider);
    assert.equal(provider.siteId, credentials.siteId);
    assert.equal(provider.driveId, credentials.driveId);
  });

  test('formats metadata objects accurately for SharePoint document library items', async () => {
    const provider = new SharePointProvider(credentials);
    provider.getValidAccessToken = async () => 'mock-access-token';
    provider._graphApi = async (apiPath) => {
      if (apiPath.includes('/drives/b!drive_guid_123/root:/Projects/spec.pdf:')) {
        return {
          id: 'sp_item_555',
          name: 'spec.pdf',
          size: 40960,
          lastModifiedDateTime: '2026-08-02T14:00:00Z',
          file: { mimeType: 'application/pdf' }
        };
      }
    };

    const meta = await provider.metadata('/Projects/spec.pdf');
    assert.equal(meta.name, 'spec.pdf');
    assert.equal(meta.path, '/Projects/spec.pdf');
    assert.equal(meta.isDirectory, false);
    assert.equal(meta.size, 40960);
  });
});
