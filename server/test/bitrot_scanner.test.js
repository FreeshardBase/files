const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const {
  calculateFileHash,
  registerFileChecksum,
  verifyFileIntegrity,
  runIntegrityScan,
  getCorruptedFiles,
  bitrotScannerRouter
} = require('../utils/bitrot_scanner');

describe('File Integrity Checker & Bit-Rot Scanner (#87)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-bitrot';
  let userHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_bitrot_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_bitrot.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'bitrotuser', 'bitrotuser@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const activeUser = req.headers['x-test-user'] || userId;
      req.session = { user: { id: activeUser, username: activeUser } };
      req.userId = activeUser;
      req.userRoot = userHome;
      next();
    });

    app.use('/api/integrity', bitrotScannerRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('calculateFileHash computes SHA-256 hash correctly', async () => {
    const filePath = path.join(userHome, 'test1.txt');
    await fs.writeFile(filePath, 'Hello Freeshard Bit-Rot Test');
    const hash = await calculateFileHash(filePath);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64); // SHA-256 hex string length
  });

  test('registerFileChecksum registers file SHA-256 hash into SQLite file_checksums table', async () => {
    const filePath = path.join(userHome, 'test1.txt');
    const res = await registerFileChecksum(filePath);
    assert.strictEqual(res.filePath, filePath);
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.checksum);

    const record = await db.getFileChecksum(filePath);
    assert.ok(record);
    assert.strictEqual(record.checksum, res.checksum);
    assert.strictEqual(record.status, 'ok');
  });

  test('verifyFileIntegrity verifies unmodified file as ok', async () => {
    const filePath = path.join(userHome, 'test1.txt');
    const verification = await verifyFileIntegrity(filePath);
    assert.strictEqual(verification.status, 'ok');
    assert.strictEqual(verification.filePath, filePath);
  });

  test('verifyFileIntegrity detects bit-rot (silent data corruption) and logs corrupted path', async () => {
    const filePath = path.join(userHome, 'corrupted.txt');
    const originalContent = 'Original pristine document content';
    await fs.writeFile(filePath, originalContent);
    await registerFileChecksum(filePath);

    // Simulate bit rot by altering 1 byte in the file
    const corruptedContent = 'Original pristine documEnt content';
    await fs.writeFile(filePath, corruptedContent);

    const result = await verifyFileIntegrity(filePath);
    assert.strictEqual(result.status, 'corrupted');
    assert.ok(result.error.includes('Bit-rot detected'));
    assert.notStrictEqual(result.expectedHash, result.actualHash);

    const corruptedList = await db.getCorruptedFiles();
    assert.ok(corruptedList.some(item => item.file_path === filePath));
  });

  test('verifyFileIntegrity handles missing file on disk', async () => {
    const filePath = path.join(userHome, 'missing.txt');
    await fs.writeFile(filePath, 'Will be deleted');
    await registerFileChecksum(filePath);
    await fs.unlink(filePath);

    const result = await verifyFileIntegrity(filePath);
    assert.strictEqual(result.status, 'missing');
    assert.ok(result.error);

    const record = await db.getFileChecksum(filePath);
    assert.strictEqual(record.status, 'missing');
  });

  test('runIntegrityScan scans all tracked files in directory', async () => {
    const fileA = path.join(userHome, 'batchA.txt');
    const fileB = path.join(userHome, 'batchB.txt');
    await fs.writeFile(fileA, 'Batch Content A');
    await fs.writeFile(fileB, 'Batch Content B');
    await registerFileChecksum(fileA);
    await registerFileChecksum(fileB);

    // Corrupt fileB
    await fs.writeFile(fileB, 'Batch Content B Corrupted');

    const report = await runIntegrityScan(userHome);
    assert.ok(report.total >= 2);
    assert.ok(report.ok >= 1);
    assert.ok(report.corrupted.length >= 1);
    assert.ok(report.corrupted.some(c => c.file_path === fileB));
  });

  test('API Endpoint: POST /api/integrity/register registers a file', async () => {
    const filePath = path.join(userHome, 'api_test.txt');
    await fs.writeFile(filePath, 'API Registration Test');

    const res = await fetch(`${serverUrl}/api/integrity/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.record.status, 'ok');
  });

  test('API Endpoint: POST /api/integrity/verify checks single file status', async () => {
    const filePath = path.join(userHome, 'api_test.txt');

    const res = await fetch(`${serverUrl}/api/integrity/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.result.status, 'ok');
  });

  test('API Endpoint: GET /api/integrity/corrupted returns list of corrupted files', async () => {
    const res = await fetch(`${serverUrl}/api/integrity/corrupted`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.corruptedFiles));
    assert.ok(body.corruptedFiles.length >= 1);
  });

  test('API Endpoint: POST /api/integrity/scan triggers full directory scan', async () => {
    const res = await fetch(`${serverUrl}/api/integrity/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDir: userHome })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(body.report.total > 0);
  });
});
