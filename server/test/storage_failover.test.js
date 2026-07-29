const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const express = require('express');
const LocalProvider = require('../providers/local');
const FailoverProvider = require('../providers/failover');
const storageRouter = require('../routes/storage');

describe('High-Availability Storage Node Failover & Redundancy Gateway (#98)', () => {
  let tmpDir;
  let primaryPath;
  let secondaryPath;
  let primaryProvider;
  let secondaryProvider;
  let failoverProvider;
  let app;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freeshard-ha-test-'));
    primaryPath = path.join(tmpDir, 'primary');
    secondaryPath = path.join(tmpDir, 'secondary');

    await fs.mkdir(primaryPath, { recursive: true });
    await fs.mkdir(secondaryPath, { recursive: true });

    primaryProvider = new LocalProvider({ userRoot: primaryPath });
    secondaryProvider = new LocalProvider({ userRoot: secondaryPath });
    await primaryProvider.ensureUserHome();
    await secondaryProvider.ensureUserHome();

    failoverProvider = new FailoverProvider({
      primaryProvider,
      secondaryProvider
    });

    app = express();
    app.use(express.json());
    app.use('/api/storage', storageRouter(failoverProvider));

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('Primary provider operates normally when healthy', async () => {
    const stream = require('stream').Readable.from(['hello primary']);
    await failoverProvider.write('/test.txt', stream);

    const metadata = await failoverProvider.metadata('/test.txt');
    assert.equal(metadata.name, 'test.txt');

    const health = await failoverProvider.checkHealth();
    assert.equal(health.activeNode, 'primary');
    assert.equal(health.primary.status, 'online');
    assert.equal(health.secondary.status, 'online');
    assert.equal(health.status, 'ok');
  });

  test('Automatically fails over to secondary node on primary I/O error', async () => {
    // Write sample file to secondary
    const secStream = require('stream').Readable.from(['hello secondary']);
    await secondaryProvider.write('/sec.txt', secStream);

    // Simulate primary failure by mocking list failure
    primaryProvider.list = async () => {
      const err = new Error('EIO: i/o error, read failed');
      err.code = 'EIO';
      throw err;
    };

    const items = await failoverProvider.list('/');
    assert.ok(Array.isArray(items));
    assert.ok(items.some(i => i.name === 'sec.txt'));

    const health = await failoverProvider.checkHealth();
    assert.equal(health.activeNode, 'secondary');
    assert.equal(health.primary.status, 'offline');
    assert.equal(health.secondary.status, 'online');
    assert.equal(health.status, 'degraded');
  });

  test('GET /api/storage/health returns health status of storage cluster', async () => {
    const res = await fetch(`${baseUrl}/api/storage/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.activeNode, 'primary');
    assert.equal(body.primary.status, 'online');
    assert.equal(body.secondary.status, 'online');
  });

  test('Re-evaluates health when primary recovers', async () => {
    // Break primary
    primaryProvider.list = async () => {
      const err = new Error('Primary node down');
      err.code = 'ENOENT';
      throw err;
    };

    try {
      await failoverProvider.list('/');
    } catch {}

    let health = await failoverProvider.checkHealth();
    assert.equal(health.activeNode, 'secondary');

    // Restore primary
    primaryProvider.list = (new LocalProvider({ userRoot: primaryPath })).list.bind(new LocalProvider({ userRoot: primaryPath }));
    
    // Probe health
    await failoverProvider.probeHealth();
    health = await failoverProvider.checkHealth();
    assert.equal(health.activeNode, 'primary');
    assert.equal(health.status, 'ok');
  });
});
