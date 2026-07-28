const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const webdavRouter = require('../routes/webdav');

describe('SFTP / WebDAV Server Proxy Gateway Protocol Support (#82)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-webdav-1';
  const plainAppPassword = 'fs_asp_test_webdav_pass_12345';
  let appPasswordId;

  before(async () => {
    dataDir = path.join(__dirname, 'data_webdav_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_webdav.db');
    await fs.mkdir(dataDir, { recursive: true });

    // Provision test files for user
    const userRoot = path.join(dataDir, 'users', userId);
    await fs.mkdir(path.join(userRoot, 'Documents'), { recursive: true });
    await fs.writeFile(path.join(userRoot, 'welcome.txt'), 'Hello WebDAV World');
    await fs.writeFile(path.join(userRoot, 'Documents', 'notes.txt'), 'Document note content');

    await db.initDb();

    // Create user with account password and app password
    const userPassHash = await bcrypt.hash('AccountPassword123!', 10);
    await db.upsertUser(userId, 'webdavuser', 'webdav@freeshard.local');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [userPassHash, userId]);

    const aspHash = await bcrypt.hash(plainAppPassword, 10);
    const res = await db.run(
      'INSERT INTO app_passwords (user_id, label, password_hash) VALUES (?, ?, ?)',
      [userId, 'Test Laptop WebDAV App Password', aspHash]
    );
    appPasswordId = res.lastID;

    app = express();
    app.use('/webdav', webdavRouter);

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
    if (server) server.close();
    await db.closeDb();
    try { await fs.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  function makeRequest(method, pathUrl, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathUrl, serverUrl);
      const reqOpts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers
      };

      const req = http.request(reqOpts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  function basicAuthHeader(username, password) {
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    return { 'Authorization': `Basic ${token}` };
  }

  test('Rejects unauthenticated requests with HTTP 401 and WWW-Authenticate header', async () => {
    const res = await makeRequest('PROPFIND', '/webdav/');
    assert.equal(res.status, 401);
    assert.ok(res.headers['www-authenticate']);
    assert.ok(res.headers['www-authenticate'].includes('Basic'));
  });

  test('Rejects invalid credentials with HTTP 401', async () => {
    const headers = basicAuthHeader('webdavuser', 'WrongPassword!');
    const res = await makeRequest('PROPFIND', '/webdav/', headers);
    assert.equal(res.status, 401);
  });

  test('Authenticates successfully with user account password', async () => {
    const headers = basicAuthHeader('webdavuser', 'AccountPassword123!');
    const res = await makeRequest('PROPFIND', '/webdav/', headers);
    assert.equal(res.status, 207);
    assert.ok(res.body.includes('<D:multistatus'));
  });

  test('Authenticates successfully with user app password', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const res = await makeRequest('PROPFIND', '/webdav/', headers);
    assert.equal(res.status, 207);
    assert.ok(res.body.includes('welcome.txt'));
  });

  test('PROPFIND returns directory listing in WebDAV Multi-Status XML', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const res = await makeRequest('PROPFIND', '/webdav/', headers);
    assert.equal(res.status, 207);
    assert.ok(res.body.includes('<D:multistatus'));
    assert.ok(res.body.includes('<D:displayname>welcome.txt</D:displayname>'));
    assert.ok(res.body.includes('<D:displayname>Documents</D:displayname>'));
  });

  test('PROPFIND with Depth: 0 returns only target resource metadata', async () => {
    const headers = { ...basicAuthHeader('webdavuser', plainAppPassword), 'Depth': '0' };
    const res = await makeRequest('PROPFIND', '/webdav/welcome.txt', headers);
    assert.equal(res.status, 207);
    assert.ok(res.body.includes('<D:displayname>welcome.txt</D:displayname>'));
    assert.ok(!res.body.includes('Documents'));
  });

  test('GET downloads file content accurately', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const res = await makeRequest('GET', '/webdav/welcome.txt', headers);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'Hello WebDAV World');
  });

  test('PUT creates a new file via WebDAV', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const uploadContent = 'Created via WebDAV PUT request';
    const putRes = await makeRequest('PUT', '/webdav/created_webdav.txt', headers, uploadContent);
    assert.equal(putRes.status, 201);

    const getRes = await makeRequest('GET', '/webdav/created_webdav.txt', headers);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body, uploadContent);
  });

  test('MKCOL creates a new directory', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const mkcolRes = await makeRequest('MKCOL', '/webdav/NewWebdavDir', headers);
    assert.equal(mkcolRes.status, 201);

    const propRes = await makeRequest('PROPFIND', '/webdav/NewWebdavDir', headers);
    assert.equal(propRes.status, 207);
    assert.ok(propRes.body.includes('<D:collection/>'));
  });

  test('DELETE removes file or directory', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const delRes = await makeRequest('DELETE', '/webdav/created_webdav.txt', headers);
    assert.equal(delRes.status, 204);

    const getRes = await makeRequest('GET', '/webdav/created_webdav.txt', headers);
    assert.equal(getRes.status, 404);
  });

  test('OPTIONS returns DAV protocol support capabilities', async () => {
    const headers = basicAuthHeader('webdavuser', plainAppPassword);
    const res = await makeRequest('OPTIONS', '/webdav/', headers);
    assert.equal(res.status, 200);
    assert.ok(res.headers['dav']);
    assert.ok(res.headers['allow']);
    assert.ok(res.headers['allow'].includes('PROPFIND'));
  });
});
