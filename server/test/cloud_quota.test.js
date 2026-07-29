const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BaseProvider = require('../providers/base');
const GoogleDriveProvider = require('../providers/gdrive');
const DropboxProvider = require('../providers/dropbox');
const LocalProvider = require('../providers/local');

describe('Cloud Storage Quota & Capacity Usage Indicators (#63)', () => {

  test('BaseProvider defines getQuota method contract', async () => {
    const provider = new BaseProvider();
    assert.equal(typeof provider.getQuota, 'function');
    await assert.rejects(async () => {
      await provider.getQuota();
    }, /getQuota\(\) must be implemented/);
  });

  test('GoogleDriveProvider.getQuota fetches storageQuota from Drive API', async () => {
    const gdrive = new GoogleDriveProvider({
      clientId: 'mock_client_id',
      clientSecret: 'mock_secret',
      refreshToken: 'mock_token'
    });

    // Mock _driveApi
    gdrive._driveApi = async (apiPath) => {
      assert.equal(apiPath, '/about?fields=storageQuota');
      return {
        body: JSON.stringify({
          storageQuota: {
            usage: '1073741824',
            limit: '16106127360'
          }
        })
      };
    };

    const quota = await gdrive.getQuota();
    assert.deepEqual(quota, {
      used: 1073741824,
      total: 16106127360
    });
  });

  test('DropboxProvider.getQuota fetches space usage from Dropbox API', async () => {
    const dropbox = new DropboxProvider({
      clientId: 'mock_client_id',
      clientSecret: 'mock_secret',
      refreshToken: 'mock_token'
    });

    // Mock _dropboxRpcApi
    dropbox._dropboxRpcApi = async (apiPath, bodyObj) => {
      assert.equal(apiPath, '/users/get_space_usage');
      return {
        body: JSON.stringify({
          used: 524288000,
          allocation: {
            '.tag': 'individual',
            allocated: 21474836480
          }
        })
      };
    };

    const quota = await dropbox.getQuota();
    assert.deepEqual(quota, {
      used: 524288000,
      total: 21474836480
    });
  });

  test('LocalProvider.getQuota calculates local directory storage usage', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'tmp_quota_test_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), Buffer.alloc(2048));
      const local = new LocalProvider({ userRoot: tmpDir });

      const quota = await local.getQuota(10485760);
      assert.equal(quota.used, 2048);
      assert.equal(quota.total, 10485760);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('filebrowser.js and app.css contain sidebar quota indicator markup & styles', () => {
    const filebrowserJs = fs.readFileSync(path.join(__dirname, '../../public/js/filebrowser.js'), 'utf8');
    const appCss = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8');

    assert.ok(filebrowserJs.includes('sidebar-quota-bar') || filebrowserJs.includes('quota-progress-bar'), 'filebrowser.js must include quota progress bar elements');
    assert.ok(filebrowserJs.includes('sidebar-quota-text') || filebrowserJs.includes('quota-text'), 'filebrowser.js must include quota text elements');
    assert.ok(appCss.includes('.sidebar-quota-bar') || appCss.includes('.quota-progress-bar'), 'app.css must define progress bar styles');
  });

});

describe('Storage Analytics Dashboard (#30)', () => {
  const { getStorageAnalytics } = require('../utils/storage_analytics');
  const express = require('express');
  const storageRouter = require('../routes/storage');

  test('getStorageAnalytics categorizes files by type and extension', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'tmp_analytics_test_' + Date.now());
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });

    try {
      fs.writeFileSync(path.join(tmpDir, 'photo.jpg'), Buffer.alloc(1024));
      fs.writeFileSync(path.join(tmpDir, 'doc.pdf'), Buffer.alloc(2048));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'script.js'), Buffer.alloc(512));

      const analytics = await getStorageAnalytics(tmpDir, 'user-analytics-test');
      assert.equal(analytics.totalFiles, 3);
      assert.equal(analytics.totalUsed, 3584);
      assert.equal(analytics.byFileType.images.count, 1);
      assert.equal(analytics.byFileType.images.bytes, 1024);
      assert.equal(analytics.byFileType.documents.count, 1);
      assert.equal(analytics.byFileType.documents.bytes, 2048);
      assert.equal(analytics.byFileType.code.count, 1);
      assert.equal(analytics.byFileType.code.bytes, 512);
      assert.ok(analytics.byExtension['.jpg']);
      assert.equal(analytics.byExtension['.jpg'].bytes, 1024);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('API Endpoint: GET /api/storage/analytics returns breakdown per provider and file type', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/storage', storageRouter);

    const server = app.listen(0);
    const port = server.address().port;
    const url = `http://localhost:${port}/api/storage/analytics`;

    try {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data);
      assert.ok(typeof data.totalUsed === 'number');
      assert.ok(typeof data.totalFiles === 'number');
      assert.ok(data.byFileType);
      assert.ok(data.providers);
      assert.ok(data.providers.local);
    } finally {
      server.close();
    }
  });
});

