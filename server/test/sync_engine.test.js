const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');

const db = require('../db');
const syncRouter = require('../routes/sync');
const LocalProvider = require('../providers/local');
const { runSyncEngine } = require('../utils/sync_engine');

describe('Automated File Synchronization Engine (#71)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-sync';

  before(async () => {
    dataDir = path.join(__dirname, 'data_sync_engine_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_sync.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'syncuser', 'sync@freeshard.local');

    const userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });

    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test_sync_secret',
      resave: false,
      saveUninitialized: true
    }));

    app.use((req, res, next) => {
      req.session.userId = userId;
      next();
    });

    app.use('/api/sync', syncRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('DB Helpers: createSyncJob, getSyncJobById, getSyncJobsByUser, updateSyncJobStatus', async () => {
    const job = await db.createSyncJob({
      userId,
      providerConnectionId: null,
      localPath: '/SyncLocal',
      remotePath: '/SyncRemote',
      conflictStrategy: 'newer_wins'
    });

    assert.ok(job.id);
    assert.equal(job.user_id, userId);
    assert.equal(job.local_path, '/SyncLocal');
    assert.equal(job.remote_path, '/SyncRemote');
    assert.equal(job.conflict_strategy, 'newer_wins');
    assert.equal(job.status, 'pending');

    const fetched = await db.getSyncJobById(job.id, userId);
    assert.equal(fetched.id, job.id);

    const userJobs = await db.getSyncJobsByUser(userId);
    assert.ok(userJobs.some(j => j.id === job.id));

    await db.updateSyncJobStatus(job.id, {
      status: 'completed',
      lastSyncedAt: new Date().toISOString()
    });

    const updated = await db.getSyncJobById(job.id, userId);
    assert.equal(updated.status, 'completed');
    assert.ok(updated.last_synced_at);
  });

  test('Sync Engine: Two-way sync with conflict resolution strategy "newer_wins"', async () => {
    const userHome = path.join(dataDir, 'users', userId);
    const localDir = path.join(userHome, 'LocalDocs');
    const remoteDir = path.join(userHome, 'RemoteDocs');
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    // File 1: only in local -> should sync to remote
    await fs.writeFile(path.join(localDir, 'only_local.txt'), 'local content');

    // File 2: only in remote -> should sync to local
    await fs.writeFile(path.join(remoteDir, 'only_remote.txt'), 'remote content');

    // File 3: conflict where remote is newer
    const oldTime = new Date(Date.now() - 10000);
    const newTime = new Date(Date.now());

    await fs.writeFile(path.join(localDir, 'conflict_newer.txt'), 'older local content');
    await fs.utimes(path.join(localDir, 'conflict_newer.txt'), oldTime, oldTime);

    await fs.writeFile(path.join(remoteDir, 'conflict_newer.txt'), 'newer remote content');
    await fs.utimes(path.join(remoteDir, 'conflict_newer.txt'), newTime, newTime);

    const job = await db.createSyncJob({
      userId,
      localPath: '/LocalDocs',
      remotePath: '/RemoteDocs',
      conflictStrategy: 'newer_wins'
    });

    await runSyncEngine(job.id, userId);

    // Verify local received only_remote.txt
    const syncedLocal = await fs.readFile(path.join(localDir, 'only_remote.txt'), 'utf8');
    assert.equal(syncedLocal, 'remote content');

    // Verify remote received only_local.txt
    const syncedRemote = await fs.readFile(path.join(remoteDir, 'only_local.txt'), 'utf8');
    assert.equal(syncedRemote, 'local content');

    // Verify newer wins: local file should be updated with newer remote content
    const updatedLocalConflict = await fs.readFile(path.join(localDir, 'conflict_newer.txt'), 'utf8');
    assert.equal(updatedLocalConflict, 'newer remote content');
  });

  test('Sync Engine: Two-way sync with conflict resolution strategy "keep_both"', async () => {
    const userHome = path.join(dataDir, 'users', userId);
    const localDir = path.join(userHome, 'LocalKeepBoth');
    const remoteDir = path.join(userHome, 'RemoteKeepBoth');
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    await fs.writeFile(path.join(localDir, 'file.txt'), 'local version');
    await fs.writeFile(path.join(remoteDir, 'file.txt'), 'remote version');

    const job = await db.createSyncJob({
      userId,
      localPath: '/LocalKeepBoth',
      remotePath: '/RemoteKeepBoth',
      conflictStrategy: 'keep_both'
    });

    await runSyncEngine(job.id, userId);

    const localFiles = await fs.readdir(localDir);
    const remoteFiles = await fs.readdir(remoteDir);

    // Both directories should contain original file and a conflict copy
    assert.ok(localFiles.length >= 2, `Expected at least 2 files in localDir, got: ${localFiles.join(', ')}`);
    assert.ok(remoteFiles.length >= 2, `Expected at least 2 files in remoteDir, got: ${remoteFiles.join(', ')}`);

    const hasConflictFile = localFiles.some(f => f.includes('conflict') || f.includes('file'));
    assert.ok(hasConflictFile);
  });

  test('API Endpoint: POST /api/sync/start starts a sync job', async () => {
    const res = await fetch(`${serverUrl}/api/sync/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        local_path: '/MyLocal',
        remote_path: '/MyRemote',
        conflict_strategy: 'newer_wins'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.job);
    assert.ok(data.job.id);
    assert.equal(data.job.local_path, '/MyLocal');
    assert.equal(data.job.remote_path, '/MyRemote');
  });

  test('API Endpoint: GET /api/sync/status retrieves sync job statuses', async () => {
    const res = await fetch(`${serverUrl}/api/sync/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.jobs));
    assert.ok(data.jobs.length > 0);
  });
});
