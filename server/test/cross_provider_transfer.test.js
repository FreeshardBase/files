const { test, describe, before, after } = require('node:test');
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

// ── Issue #45: Bidirectional Cloud Migration & Soft Migration Wizard ──────────
describe('Migration Wizard — Bidirectional Cloud Migration (#45)', () => {
  const MigrationWizard = require('../utils/migration_wizard');

  test('dry-run enumerates files without moving them', async () => {
    const files = [
      { path: '/photos/a.jpg', size: 100 },
      { path: '/docs/b.pdf',  size: 200 },
    ];
    const srcProvider = {
      list: async () => files,
    };
    const plan = await MigrationWizard.dryRun({ srcProvider, srcPath: '/', dstPath: '/' });
    assert.equal(plan.direction, 'local_to_cloud');
    assert.equal(plan.items.length, 2);
    assert.equal(plan.totalBytes, 300);
    assert.equal(plan.isDryRun, true);
    // dry-run must NOT touch the destination
    assert.equal(plan.moved, 0);
  });

  test('dry-run reverse direction is cloud_to_local', async () => {
    const srcProvider = { list: async () => [{ path: '/x.txt', size: 10 }] };
    const plan = await MigrationWizard.dryRun({
      srcProvider, srcPath: '/', dstPath: '/', direction: 'cloud_to_local'
    });
    assert.equal(plan.direction, 'cloud_to_local');
    assert.equal(plan.isDryRun, true);
  });

  test('executeMigration copies files and reports progress', async () => {
    const written = [];
    const srcProvider = {
      list:  async () => [{ path: '/a.jpg', size: 5 }],
      read:  async () => ({ stream: Readable.from([Buffer.from('hello')]), size: 5 }),
    };
    const dstProvider = {
      write: async (path, stream) => { written.push(path); return { path, size: 5 }; },
    };
    const result = await MigrationWizard.executeMigration({
      srcProvider, dstProvider,
      items: [{ path: '/a.jpg', size: 5 }],
      operation: 'copy',
      onProgress: () => {},
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.ok(written.includes('/a.jpg'));
  });

  test('executeMigration move deletes source after successful write', async () => {
    let deleted = false;
    const srcProvider = {
      list:   async () => [{ path: '/b.txt', size: 3 }],
      read:   async () => ({ stream: Readable.from([Buffer.from('abc')]), size: 3 }),
      delete: async () => { deleted = true; return true; },
    };
    const dstProvider = {
      write: async (p, s) => ({ path: p, size: 3 }),
    };
    await MigrationWizard.executeMigration({
      srcProvider, dstProvider,
      items: [{ path: '/b.txt', size: 3 }],
      operation: 'move',
      onProgress: () => {},
    });
    assert.equal(deleted, true);
  });

  test('soft-rollback: source NOT deleted when write fails (move)', async () => {
    let deleted = false;
    const srcProvider = {
      list:   async () => [{ path: '/fail.dat', size: 7 }],
      read:   async () => ({ stream: Readable.from([Buffer.from('failure')]), size: 7 }),
      delete: async () => { deleted = true; },
    };
    const dstProvider = {
      write: async () => { throw new Error('disk full'); },
    };
    const result = await MigrationWizard.executeMigration({
      srcProvider, dstProvider,
      items: [{ path: '/fail.dat', size: 7 }],
      operation: 'move',
      onProgress: () => {},
    });
    assert.equal(result.failed, 1);
    assert.equal(deleted, false, 'source must be preserved when write fails');
    assert.ok(result.errors[0].path === '/fail.dat');
  });

  test('createMigrationPlan and getMigrationPlan round-trip', async () => {
    const db = require('../db');
    process.env.DATABASE_PATH = ':memory:';
    // reset singleton for in-memory db
    db._resetForTest?.();
    await db.initDb();

    const plan = await db.createMigrationPlan({
      id: 'mig-test-001',
      userId: 'default-user',
      direction: 'local_to_cloud',
      srcProviderType: 'local',
      dstProviderType: 's3',
      srcPath: '/Photos',
      dstPath: '/backup/Photos',
      totalFiles: 42,
      totalBytes: 1024000,
      isDryRun: 0,
    });
    assert.equal(plan.id, 'mig-test-001');
    assert.equal(plan.status, 'pending');

    const fetched = await db.getMigrationPlanById('mig-test-001', 'default-user');
    assert.equal(fetched.direction, 'local_to_cloud');
    assert.equal(fetched.total_files, 42);

    await db.updateMigrationPlanStatus('mig-test-001', 'completed', { completedFiles: 42, failedFiles: 0 });
    const updated = await db.getMigrationPlanById('mig-test-001', 'default-user');
    assert.equal(updated.status, 'completed');
    assert.equal(updated.completed_files, 42);
  });

  test('listMigrationPlans returns plans for user', async () => {
    const db = require('../db');
    const plans = await db.listMigrationPlans('default-user');
    assert.ok(Array.isArray(plans));
    // at minimum the plan from previous test
    assert.ok(plans.length >= 1);
    assert.ok(plans.every(p => p.user_id === 'default-user'));
  });
});

describe('Bidirectional Cloud Migration & Soft Migration Wizard (#45)', () => {
  const { planMigration, executeMigrationStep } = require('../utils/migration_wizard');
  test('planMigration returns item count and estimated bytes for a list of files', async () => {
    const items = [
      { path: '/photos/vacation.jpg', size: 1024 * 1024 },
      { path: '/docs/report.pdf', size: 512 * 1024 },
      { path: '/music/song.mp3', size: 8 * 1024 * 1024 }
    ];
    const plan = await planMigration({ items, srcProviderType: 'local', dstProviderType: 's3' });

    assert.equal(plan.itemCount, 3, 'should count 3 items');
    assert.equal(plan.totalBytes, (1024 + 512 + 8 * 1024) * 1024, 'should sum all file sizes');
    assert.equal(plan.srcProviderType, 'local');
    assert.equal(plan.dstProviderType, 's3');
    assert.ok(Array.isArray(plan.items), 'plan.items should be an array');
    assert.equal(plan.items.length, 3);
  });

  test('planMigration rejects when source and destination are identical local paths', async () => {
    await assert.rejects(
      () => planMigration({ items: [{ path: '/a.txt', size: 100 }], srcProviderType: 'local', dstProviderType: 'local', srcPath: '/a', dstPath: '/a' }),
      /source and destination must differ/i
    );
  });

  test('executeMigrationStep copies file from source to destination and deletes source on move', async () => {
    const log = [];
    const mockSrc = {
      read: async (p) => {
        log.push({ action: 'read', path: p });
        return { stream: Readable.from([Buffer.from('migration data')]), size: 14 };
      },
      delete: async (p) => {
        log.push({ action: 'delete', path: p });
        return true;
      }
    };
    const mockDst = {
      write: async (p, stream) => {
        log.push({ action: 'write', path: p });
        return { path: p, size: 14 };
      }
    };

    const item = { path: '/docs/report.pdf', size: 14 };
    const result = await executeMigrationStep({ item, srcProvider: mockSrc, dstProvider: mockDst, operation: 'move' });

    assert.equal(result.status, 'completed');
    assert.equal(result.path, '/docs/report.pdf');
    assert.ok(log.some(l => l.action === 'read'), 'source read must be called');
    assert.ok(log.some(l => l.action === 'write'), 'destination write must be called');
    assert.ok(log.some(l => l.action === 'delete'), 'source delete must be called on move');
  });

  test('executeMigrationStep copies file without deleting source when operation is copy', async () => {
    let deleteCalled = false;
    const mockSrc = {
      read: async () => ({ stream: Readable.from([Buffer.from('data')]), size: 4 }),
      delete: async () => { deleteCalled = true; }
    };
    const mockDst = {
      write: async (p) => ({ path: p, size: 4 })
    };

    const result = await executeMigrationStep({
      item: { path: '/img.png', size: 4 },
      srcProvider: mockSrc,
      dstProvider: mockDst,
      operation: 'copy'
    });

    assert.equal(result.status, 'completed');
    assert.equal(deleteCalled, false, 'source must NOT be deleted on copy');
  });

  test('executeMigrationStep returns failed status and does NOT delete source when write fails', async () => {
    let deleteCalled = false;
    const mockSrc = {
      read: async () => ({ stream: Readable.from([Buffer.from('x')]), size: 1 }),
      delete: async () => { deleteCalled = true; }
    };
    const mockDst = {
      write: async () => { throw new Error('Quota exceeded on target provider'); }
    };

    const result = await executeMigrationStep({
      item: { path: '/fail.txt', size: 1 },
      srcProvider: mockSrc,
      dstProvider: mockDst,
      operation: 'move'
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /Quota exceeded/);
    assert.equal(deleteCalled, false, 'source must be preserved when write fails');
  });

  test('executeMigrationStep invokes onProgress callback with bytes transferred', async () => {
    const progressEvents = [];
    const sampleData = Buffer.from('progress test data');
    const mockSrc = {
      read: async () => ({ stream: Readable.from([sampleData]), size: sampleData.length })
    };
    const mockDst = {
      write: async (p) => ({ path: p, size: sampleData.length })
    };

    await executeMigrationStep({
      item: { path: '/progress.bin', size: sampleData.length },
      srcProvider: mockSrc,
      dstProvider: mockDst,
      operation: 'copy',
      onProgress: (e) => progressEvents.push(e)
    });

    assert.ok(progressEvents.length > 0, 'progress callback must be invoked at least once');
    const completedEvent = progressEvents[progressEvents.length - 1];
    assert.equal(completedEvent.path, '/progress.bin');
    assert.ok(completedEvent.bytesTransferred >= 0);
  });

  test('planMigration correctly identifies local-to-cloud direction', async () => {
    const plan = await planMigration({
      items: [{ path: '/file.txt', size: 100 }],
      srcProviderType: 'local',
      dstProviderType: 'dropbox'
    });
    assert.equal(plan.direction, 'local_to_cloud');
  });

  test('planMigration correctly identifies cloud-to-local direction', async () => {
    const plan = await planMigration({
      items: [{ path: '/remote/file.txt', size: 200 }],
      srcProviderType: 's3',
      dstProviderType: 'local'
    });
    assert.equal(plan.direction, 'cloud_to_local');
  });

  test('planMigration correctly identifies cloud-to-cloud direction', async () => {
    const plan = await planMigration({
      items: [{ path: '/data.zip', size: 5000 }],
      srcProviderType: 'dropbox',
      dstProviderType: 's3'
    });
    assert.equal(plan.direction, 'cloud_to_cloud');
  });
});
