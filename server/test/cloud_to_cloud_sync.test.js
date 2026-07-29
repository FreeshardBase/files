process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable } = require('stream');
const db = require('../db');
const cloudSyncRouter = require('../routes/cloud_sync');
const { runCloudSyncEngine } = require('../utils/cloud_to_cloud_sync');

// Dummy provider for testing streaming transfers
class MockStorageProvider {
  constructor(initialFiles = {}) {
    this.files = new Map(Object.entries(initialFiles));
  }

  async list(dirPath) {
    const items = [];
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    for (const [filePath, fileData] of this.files.entries()) {
      if (filePath.startsWith(prefix) || dirPath === '/') {
        items.push({
          name: filePath.split('/').pop(),
          path: filePath,
          isDirectory: false,
          size: fileData.content.length,
          modified: new Date().toISOString(),
          mimeType: fileData.mimeType || 'text/plain'
        });
      }
    }
    return items;
  }

  async read(filePath) {
    const file = this.files.get(filePath);
    if (!file) throw new Error(`File not found: ${filePath}`);
    const stream = Readable.from([Buffer.from(file.content)]);
    return { stream, size: file.content.length, mimeType: file.mimeType || 'text/plain' };
  }

  async write(filePath, dataStream, options = {}) {
    const chunks = [];
    for await (const chunk of dataStream) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    this.files.set(filePath, { content, mimeType: options.mimeType || 'text/plain' });
    return { path: filePath, size: content.length };
  }
}

test.before(async () => {
  await db.initDb();
  await db.upsertUser('test-user-c2c', 'c2c_user', 'c2c@example.com');
});

test('Issue #93: Database CRUD operations for cloud_sync_jobs', async () => {
  const conn1 = await db.addProviderConnection('test-user-c2c', 'gdrive', 'Drive 1', { apiKey: 'key1' });
  const conn2 = await db.addProviderConnection('test-user-c2c', 'dropbox', 'Dropbox 1', { token: 'tok1' });

  const job = await db.createCloudSyncJob('test-user-c2c', {
    name: 'Backup GDrive to Dropbox',
    src_connection_id: conn1,
    src_path: '/documents/file1.txt',
    dst_connection_id: conn2,
    dst_path: '/backups/file1.txt',
    schedule: 'daily'
  });

  assert.ok(job.id, 'Job should have an ID');
  assert.equal(job.name, 'Backup GDrive to Dropbox');
  assert.equal(job.status, 'pending');
  assert.equal(job.src_connection_id, conn1);
  assert.equal(job.dst_connection_id, conn2);

  const userJobs = await db.getCloudSyncJobsByUser('test-user-c2c');
  assert.ok(userJobs.some(j => j.id === job.id), 'Job should be returned in list');

  const fetched = await db.getCloudSyncJobById('test-user-c2c', job.id);
  assert.equal(fetched.id, job.id);

  const updated = await db.updateCloudSyncJob('test-user-c2c', job.id, { status: 'completed', transferred_files: 1, transferred_bytes: 120 });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.transferred_files, 1);
  assert.equal(updated.transferred_bytes, 120);

  const deleted = await db.deleteCloudSyncJob('test-user-c2c', job.id);
  assert.equal(deleted, true);
});

test('Issue #93: Direct stream transfer execution between cloud providers', async () => {
  const srcProvider = new MockStorageProvider({
    '/report.pdf': { content: 'PDF_BINARY_CONTENT_12345', mimeType: 'application/pdf' }
  });
  const dstProvider = new MockStorageProvider();

  const conn1 = await db.addProviderConnection('test-user-c2c', 'gdrive', 'Source Drive', { key: 'a' });
  const conn2 = await db.addProviderConnection('test-user-c2c', 'dropbox', 'Dest Dropbox', { key: 'b' });

  const job = await db.createCloudSyncJob('test-user-c2c', {
    name: 'Direct Stream Sync Test',
    src_connection_id: conn1,
    src_path: '/report.pdf',
    dst_connection_id: conn2,
    dst_path: '/sync/report.pdf',
    schedule: 'manual'
  });

  const resultJob = await runCloudSyncEngine(job.id, 'test-user-c2c', { srcProvider, dstProvider });

  assert.equal(resultJob.status, 'completed');
  assert.equal(resultJob.transferred_files, 1);
  assert.equal(resultJob.transferred_bytes, 'PDF_BINARY_CONTENT_12345'.length);

  const written = dstProvider.files.get('/sync/report.pdf');
  assert.ok(written, 'Destination provider should have received file');
  assert.equal(written.content, 'PDF_BINARY_CONTENT_12345');
});

test('Issue #93: Cloud Sync HTTP API Endpoints (/api/cloud-sync/jobs)', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.userId = 'test-user-c2c';
    next();
  });
  app.use('/api/cloud-sync', cloudSyncRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const conn1 = await db.addProviderConnection('test-user-c2c', 'gdrive', 'Drive API', { key: '1' });
    const conn2 = await db.addProviderConnection('test-user-c2c', 'dropbox', 'Dropbox API', { key: '2' });

    // Create job via API
    const createRes = await fetch(`${baseUrl}/api/cloud-sync/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'API Sync Job',
        src_connection_id: conn1,
        src_path: '/data.json',
        dst_connection_id: conn2,
        dst_path: '/backup/data.json',
        schedule: 'weekly'
      })
    });
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    assert.ok(createData.job.id);
    const jobId = createData.job.id;

    // Get jobs list
    const listRes = await fetch(`${baseUrl}/api/cloud-sync/jobs`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.jobs));
    assert.ok(listData.jobs.some(j => j.id === jobId));

    // Get single job detail
    const detailRes = await fetch(`${baseUrl}/api/cloud-sync/jobs/${jobId}`);
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json();
    assert.equal(detailData.job.id, jobId);

    // Delete job via API
    const deleteRes = await fetch(`${baseUrl}/api/cloud-sync/jobs/${jobId}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 200);

    const getDeleted = await fetch(`${baseUrl}/api/cloud-sync/jobs/${jobId}`);
    assert.equal(getDeleted.status, 404);
  } finally {
    server.close();
  }
});
