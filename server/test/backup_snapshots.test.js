const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const backupsRouter = require('../routes/backups');

describe('Automated Scheduled Storage Backup & Disaster Recovery Snapshots (#83)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-backup-1';
  const userBId = 'user-backup-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_backups_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_backups.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'backupuser1', 'backup1@freeshard.local');
    await db.upsertUser(userBId, 'backupuser2', 'backup2@freeshard.local');

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const authHeader = req.headers['x-test-user'];
      if (authHeader === 'none') {
        req.session = {};
        return next();
      }
      const activeUser = authHeader || userId;
      req.session = { userId: activeUser, user: { id: activeUser } };
      next();
    });

    app.use('/api/backups', backupsRouter);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
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

  test('DB Helpers: createBackupJob, getBackupJobsByUser, getBackupJobById, updateBackupJobStatus', async () => {
    const job = await db.createBackupJob(userId, {
      name: 'System Snapshot',
      schedule: 'weekly',
      targetPath: '/Projects',
      encrypted: true
    });
    assert.ok(job);
    assert.equal(job.user_id, userId);
    assert.equal(job.name, 'System Snapshot');
    assert.equal(job.schedule, 'weekly');
    assert.equal(job.target_path, '/Projects');
    assert.equal(job.encrypted, 1);
    assert.equal(job.status, 'pending');

    const jobs = await db.getBackupJobsByUser(userId);
    assert.ok(Array.isArray(jobs));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, 'System Snapshot');

    const fetched = await db.getBackupJobById(job.id, userId);
    assert.ok(fetched);
    assert.equal(fetched.id, job.id);

    const updated = await db.updateBackupJobStatus(job.id, 'completed', {
      lastRunAt: new Date().toISOString(),
      backupFilePath: '/backups/snapshot-001.zip',
      fileSize: 1024567
    });
    assert.ok(updated);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.backup_file_path, '/backups/snapshot-001.zip');
    assert.equal(updated.file_size, 1024567);
  });

  test('API Endpoint: POST /api/backups/create creates a backup job', async () => {
    const res = await fetch(`${serverUrl}/api/backups/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        name: 'Daily Cloud Backup',
        schedule: 'daily',
        target_path: '/Documents',
        encrypted: true
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.backup || data.job);
    const job = data.backup || data.job;
    assert.equal(job.name, 'Daily Cloud Backup');
    assert.equal(job.target_path, '/Documents');
  });

  test('API Endpoint: POST /api/backups/create requires name', async () => {
    const res = await fetch(`${serverUrl}/api/backups/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        target_path: '/Documents'
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: GET /api/backups/list retrieves user backup jobs with isolation', async () => {
    // Create backup job for User B
    await fetch(`${serverUrl}/api/backups/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userBId },
      body: JSON.stringify({
        name: 'User B Vault Backup',
        schedule: 'monthly',
        target_path: '/Vault'
      })
    });

    const resUserA = await fetch(`${serverUrl}/api/backups/list`, {
      headers: { 'x-test-user': userId }
    });
    assert.equal(resUserA.status, 200);
    const dataUserA = await resUserA.json();
    const listA = dataUserA.backups || dataUserA.jobs;
    assert.ok(Array.isArray(listA));
    assert.ok(listA.every(j => j.user_id === userId));

    const resUserB = await fetch(`${serverUrl}/api/backups/list`, {
      headers: { 'x-test-user': userBId }
    });
    assert.equal(resUserB.status, 200);
    const dataUserB = await resUserB.json();
    const listB = dataUserB.backups || dataUserB.jobs;
    assert.ok(Array.isArray(listB));
    assert.equal(listB.length, 1);
    assert.equal(listB[0].name, 'User B Vault Backup');
  });

  test('API Endpoint: Rejects unauthenticated requests', async () => {
    const res = await fetch(`${serverUrl}/api/backups/list`, {
      headers: { 'x-test-user': 'none' }
    });
    assert.equal(res.status, 401);
  });
});
