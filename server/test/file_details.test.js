const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs/promises');

const db = require('../db');
const LocalProvider = require('../providers/local');
const filesRouter = require('../routes/files');
const sharingRouter = require('../routes/sharing');

const TEST_ROOT = path.resolve(__dirname, 'test_file_details_user_home');
const originalFilesRoot = process.env.FILES_ROOT;

describe('Detailed File & Sharing Metadata Overview Modal (#52)', () => {
  let app;
  let server;
  let baseUrl;
  const owner = { id: 'user_details_owner_52', username: 'details_owner_52', displayName: 'Owner User 52' };
  const sharee = { id: 'user_details_sharee_52', username: 'details_sharee_52', displayName: 'Sharee User 52' };

  before(async () => {
    process.env.FILES_ROOT = TEST_ROOT;
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}

    const userHome = path.join(TEST_ROOT, owner.id);
    const lp = new LocalProvider({ userRoot: userHome });
    await lp.ensureUserHome();

    // Create a sample test file
    await fs.writeFile(path.join(userHome, 'Documents', 'test_metadata.pdf'), '%PDF-1.4 sample content');

    await db.initDb();
    await db.run('DELETE FROM file_shares WHERE owner_user_id = ?', [owner.id]);
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [owner.id]);
    await db.upsertUser(owner.id, owner.username, 'owner@example.com', 'local', null, owner.displayName);
    await db.upsertUser(sharee.id, sharee.username, 'sharee@example.com', 'local', null, sharee.displayName);

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = owner.id;
      req.userRoot = userHome;
      req.session = { user: { id: owner.id } };
      next();
    });

    app.use('/api/files/local', filesRouter);
    app.use('/api/shares', sharingRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (originalFilesRoot !== undefined) {
      process.env.FILES_ROOT = originalFilesRoot;
    } else {
      delete process.env.FILES_ROOT;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.run('DELETE FROM file_shares WHERE owner_user_id = ?', [owner.id]);
    await db.run('DELETE FROM public_shares WHERE user_id = ?', [owner.id]);
    await db.run('DELETE FROM users WHERE id IN (?, ?)', [owner.id, sharee.id]);
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  function makeRequest(method, pathUrl, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathUrl, baseUrl);
      const payloadString = body ? JSON.stringify(body) : '';
      const req = http.request(url, {
        method,
        headers: body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadString)
        } : {}
      }, (res) => {
        let resBody = '';
        res.on('data', chunk => resBody += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resBody); } catch (e) {}
          resolve({ status: res.statusCode, body: json || resBody });
        });
      });
      req.on('error', reject);
      if (body) req.write(payloadString);
      req.end();
    });
  }

  test('LocalProvider.metadata returns complete metadata including created and modified dates', async () => {
    const userHome = path.join(TEST_ROOT, owner.id);
    const lp = new LocalProvider({ userRoot: userHome });
    const meta = await lp.metadata('/Documents/test_metadata.pdf');

    assert.equal(meta.name, 'test_metadata.pdf');
    assert.equal(meta.path, '/Documents/test_metadata.pdf');
    assert.equal(meta.isDirectory, false);
    assert.equal(meta.mimeType, 'application/pdf');
    assert.ok(meta.size > 0);
    assert.ok(meta.created, 'metadata must include created timestamp');
    assert.ok(meta.modified, 'metadata must include modified timestamp');
  });

  test('GET /api/files/local/metadata returns metadata with required fields', async () => {
    const res = await makeRequest('GET', '/api/files/local/metadata?path=/Documents/test_metadata.pdf');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.metadata);
    assert.equal(res.body.metadata.name, 'test_metadata.pdf');
    assert.equal(res.body.metadata.mimeType, 'application/pdf');
    assert.equal(res.body.metadata.provider, 'local');
    assert.ok(res.body.metadata.created_at);
    assert.ok(res.body.metadata.updated_at);
  });

  test('GET /api/shares/overview retrieves file metadata and active shares', async () => {
    const filePath = '/Documents/test_metadata.pdf';

    // 1. Create internal share
    const internalRes = await makeRequest('POST', '/api/shares/internal', {
      sharee_username: sharee.username,
      file_path: filePath,
      read_write: 1
    });
    assert.equal(internalRes.status, 201);
    const internalShareId = internalRes.body.share.id;

    // 2. Create public share link
    const publicRes = await makeRequest('POST', '/api/shares/public', {
      file_path: filePath,
      label: 'PDF Link'
    });
    assert.equal(publicRes.status, 201);
    const publicShareId = publicRes.body.share.id;

    // 3. Fetch overview
    const overviewRes = await makeRequest('GET', `/api/shares/overview?path=${encodeURIComponent(filePath)}`);
    assert.equal(overviewRes.status, 200);
    assert.equal(overviewRes.body.file_path, filePath);
    assert.ok(Array.isArray(overviewRes.body.internal_shares));
    assert.equal(overviewRes.body.internal_shares.length, 1);
    assert.equal(overviewRes.body.internal_shares[0].sharee_username, sharee.username);

    assert.ok(Array.isArray(overviewRes.body.public_shares));
    assert.equal(overviewRes.body.public_shares.length, 1);
    assert.equal(overviewRes.body.public_shares[0].label, 'PDF Link');

    assert.ok(overviewRes.body.file_metadata);
    assert.equal(overviewRes.body.file_metadata.mimeType, 'application/pdf');

    // 4. Test inline revoking of internal share
    const deleteInternalRes = await makeRequest('DELETE', `/api/shares/internal/${internalShareId}`);
    assert.equal(deleteInternalRes.status, 200);
    assert.equal(deleteInternalRes.body.success, true);

    // 5. Test inline revoking of public share link
    const deletePublicRes = await makeRequest('DELETE', `/api/shares/public/${publicShareId}`);
    assert.equal(deletePublicRes.status, 200);
    assert.equal(deletePublicRes.body.success, true);

    // 6. Verify overview after revoking
    const updatedOverview = await makeRequest('GET', `/api/shares/overview?path=${encodeURIComponent(filePath)}`);
    assert.equal(updatedOverview.body.internal_shares.length, 0);
    assert.equal(updatedOverview.body.public_shares.length, 0);
  });

  test('index.html & filebrowser.js contain Details button in toolbar & context menu plus details modal fields', async () => {
    const indexHtml = await fs.readFile(path.join(__dirname, '../../public/index.html'), 'utf8');
    const filebrowserJs = await fs.readFile(path.join(__dirname, '../../public/js/filebrowser.js'), 'utf8');

    // Toolbar button
    assert.ok(indexHtml.includes('id="btnFileDetails"'), 'index.html must contain #btnFileDetails toolbar button');
    // Context menu item
    assert.ok(indexHtml.includes('id="ctxDetails"'), 'index.html must contain #ctxDetails context menu item');
    // Details Modal
    assert.ok(indexHtml.includes('id="modalFileDetails"'), 'index.html must contain #modalFileDetails element');

    // JS Event listeners & Modal logic
    assert.ok(filebrowserJs.includes('showFileDetailsModal'), 'filebrowser.js must define showFileDetailsModal method');
    assert.ok(filebrowserJs.includes('btnFileDetails'), 'filebrowser.js must reference btnFileDetails');
    assert.ok(filebrowserJs.includes('ctxDetails'), 'filebrowser.js must reference ctxDetails');
    assert.ok(filebrowserJs.includes('/api/shares/overview'), 'filebrowser.js must query /api/shares/overview');
    assert.ok(filebrowserJs.includes('btn-revoke-internal-share'), 'filebrowser.js must support revoking internal shares inline');
    assert.ok(filebrowserJs.includes('btn-revoke-public-link'), 'filebrowser.js must support revoking public share links inline');
  });
});
