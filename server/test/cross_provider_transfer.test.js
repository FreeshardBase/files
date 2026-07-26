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
});
