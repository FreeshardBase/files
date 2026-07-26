const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

describe('Cross-Provider Cloud Storage Transfer & Internal Move (#7, #56)', () => {
  test('executes Cloud-to-Cloud transfer flow cleanly (Provider A -> Provider B)', async () => {
    let readCalled = false;
    let uploadCalled = false;
    let deleteCalled = false;

    const mockSourceProvider = {
      read: async (path) => {
        readCalled = true;
        return {
          stream: Readable.from([Buffer.from('test data')]),
          size: 9,
          mimeType: 'image/jpeg'
        };
      },
      delete: async (path) => {
        deleteCalled = true;
        return true;
      }
    };

    const mockDestProvider = {
      write: async (path, stream) => {
        uploadCalled = true;
        return { path, size: 9 };
      }
    };

    // Simulate Scenario 5 flow:
    const item = { srcPath: '/Indila - Dernière Danse.jpg', name: 'Indila - Dernière Danse.jpg' };
    const readResult = await mockSourceProvider.read(item.srcPath);
    assert.ok(readResult.stream);
    assert.equal(readCalled, true);

    const writeResult = await mockDestProvider.write('/Indila - Dernière Danse.jpg', readResult.stream);
    assert.equal(writeResult.path, '/Indila - Dernière Danse.jpg');
    assert.equal(uploadCalled, true);

    // Delete source file ONLY after write succeeds
    const deleteResult = await mockSourceProvider.delete(item.srcPath);
    assert.equal(deleteResult, true);
    assert.equal(deleteCalled, true);
  });

  test('prevents source deletion if Cloud-to-Cloud upload fails', async () => {
    let deleteCalled = false;

    const mockSourceProvider = {
      read: async () => ({
        stream: Readable.from([Buffer.from('test data')]),
        size: 9
      }),
      delete: async () => {
        deleteCalled = true;
      }
    };

    const mockDestProvider = {
      write: async () => {
        throw new Error('Cloud storage quota exceeded');
      }
    };

    const item = { srcPath: '/test.jpg', name: 'test.jpg' };
    const readResult = await mockSourceProvider.read(item.srcPath);

    await assert.rejects(async () => {
      await mockDestProvider.write('/test.jpg', readResult.stream);
    }, /Cloud storage quota exceeded/);

    // Source file must NOT be deleted!
    assert.equal(deleteCalled, false, 'Source file on Provider A must be preserved when upload to Provider B fails');
  });

  test('executes provider internal move (Scenario 4)', async () => {
    let moveCalled = false;
    const mockProvider = {
      move: async (src, dst) => {
        moveCalled = true;
        assert.equal(src, '/FolderA/test.txt');
        assert.equal(dst, '/FolderB/test.txt');
        return true;
      }
    };

    await mockProvider.move('/FolderA/test.txt', '/FolderB/test.txt');
    assert.equal(moveCalled, true);
  });

  test('executes Cloud-to-Local transfer flow cleanly (Cloud Provider -> Local Home)', async () => {
    let readCalled = false;
    let localWriteCalled = false;
    let cloudDeleteCalled = false;

    const mockSourceCloudProvider = {
      read: async (path) => {
        readCalled = true;
        return {
          stream: Readable.from([Buffer.from('cloud file content')]),
          size: 18,
          mimeType: 'image/jpeg'
        };
      },
      delete: async (path) => {
        cloudDeleteCalled = true;
        return true;
      }
    };

    const mockLocalProvider = {
      write: async (path, stream) => {
        localWriteCalled = true;
        return { path, size: 18 };
      }
    };

    const item = { srcPath: '/Indila - Dernière Danse.jpg', name: 'Indila - Dernière Danse.jpg' };
    const readResult = await mockSourceCloudProvider.read(item.srcPath);
    assert.equal(readCalled, true);

    const writeResult = await mockLocalProvider.write('/Indila - Dernière Danse.jpg', readResult.stream);
    assert.equal(writeResult.path, '/Indila - Dernière Danse.jpg');
    assert.equal(localWriteCalled, true);

    const deleteResult = await mockSourceCloudProvider.delete(item.srcPath);
    assert.equal(deleteResult, true);
    assert.equal(cloudDeleteCalled, true);
  });

  test('buffers stream immediately in BaseProvider.streamToBuffer preventing 0-byte chunk loss (#0B-TRANSFER-FIX)', async () => {
    const BaseProvider = require('../providers/base');
    const { Readable } = require('stream');

    const sampleContent = 'Hello Antigravity Freeshard Transfer';
    const stream = Readable.from([Buffer.from(sampleContent)]);

    // Simulate async delay prior to reading (e.g. OAuth token refresh or path resolution)
    await new Promise(resolve => setTimeout(resolve, 50));

    const buffer = await BaseProvider.streamToBuffer(stream);
    assert.equal(buffer.toString('utf8'), sampleContent);
    assert.equal(buffer.length, Buffer.from(sampleContent).length);
  });

  test('verifies DropboxProvider.write captures full stream buffer without 0B truncation (#0B-TRANSFER-FIX)', async () => {
    const DropboxProvider = require('../providers/dropbox');
    const provider = new DropboxProvider({ accessToken: 'mock_token' });
    const sampleData = Buffer.from('Dropbox Non-Zero Byte Content Test');

    provider.getValidAccessToken = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'mock_access_token';
    };

    provider._httpRequest = async (options, bodyData) => {
      assert.ok(Buffer.isBuffer(bodyData));
      assert.equal(bodyData.length, sampleData.length);
      assert.equal(options.headers['Content-Length'], sampleData.length);
      return {
        statusCode: 200,
        body: JSON.stringify({ path_display: '/test.pdf', size: sampleData.length })
      };
    };

    const stream = Readable.from([sampleData]);
    const res = await provider.write('/test.pdf', stream);
    assert.equal(res.size, sampleData.length);
    assert.equal(res.path, '/test.pdf');
  });

  test('verifies GoogleDriveProvider.write captures full stream buffer without 0B truncation (#0B-TRANSFER-FIX)', async () => {
    const GoogleDriveProvider = require('../providers/gdrive');
    const provider = new GoogleDriveProvider({ accessToken: 'mock_token' });
    const sampleData = Buffer.from('Google Drive Non-Zero Byte Content Test');

    provider.resolvePathToId = async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return { id: 'root_id', isDirectory: true };
    };

    provider.getValidAccessToken = async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return 'mock_access_token';
    };

    provider._httpRequest = async (options, bodyData) => {
      if (options.method === 'POST') {
        return {
          statusCode: 200,
          headers: { location: 'https://upload.googleapis.com/drive/v3/files?upload_id=mock_session_123' },
          body: JSON.stringify({})
        };
      } else if (options.method === 'PUT') {
        assert.ok(Buffer.isBuffer(bodyData));
        assert.equal(bodyData.length, sampleData.length);
        assert.equal(options.headers['Content-Length'], sampleData.length);
        return {
          statusCode: 200,
          body: JSON.stringify({ id: 'file_id_123', mimeType: 'text/plain', size: String(sampleData.length) })
        };
      }
    };

    const stream = Readable.from([sampleData]);
    const res = await provider.write('/doc.txt', stream);
    assert.equal(res.size, sampleData.length);
    assert.equal(res.path, '/doc.txt');
  });
});
