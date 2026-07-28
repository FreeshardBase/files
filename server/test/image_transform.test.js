const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const session = require('express-session');

const db = require('../db');
const filesRouter = require('../routes/files');
const {
  parseBase64Image,
  createTestBmp,
  rotateBmp90,
  flipBmp,
  cropBmp,
  transformImageBuffer
} = require('../utils/image_transform');

describe('Advanced In-Browser Image Editing & Manipulation (#73)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-image';
  let userHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_image_transform_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_image_transform.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'imageuser', 'imageuser@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(userHome, { recursive: true });

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    app.use((req, res, next) => {
      req.session = { user: { id: userId, username: 'imageuser' } };
      req.userId = userId;
      req.userRoot = userHome;
      next();
    });

    app.use('/api/files/local', filesRouter);
    app.use('/api/files', filesRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Unit: parseBase64Image parses data URL and raw base64 strings', () => {
    const rawStr = 'SGVsbG8gV29ybGQ=';
    const parsedRaw = parseBase64Image(rawStr);
    assert.strictEqual(parsedRaw.buffer.toString(), 'Hello World');

    const dataUrl = 'data:image/png;base64,SGVsbG8gV29ybGQ=';
    const parsedUrl = parseBase64Image(dataUrl);
    assert.strictEqual(parsedUrl.contentType, 'image/png');
    assert.strictEqual(parsedUrl.buffer.toString(), 'Hello World');
  });

  test('Unit: BMP operations (Rotate 90°, Flip, Crop)', () => {
    const bmp = createTestBmp(10, 20, { r: 255, g: 0, b: 0 });
    assert.strictEqual(bmp.readInt32LE(18), 10);
    assert.strictEqual(bmp.readInt32LE(22), 20);

    const rotated = rotateBmp90(bmp);
    assert.strictEqual(rotated.readInt32LE(18), 20);
    assert.strictEqual(rotated.readInt32LE(22), 10);

    const flippedH = flipBmp(bmp, 'horizontal');
    assert.strictEqual(flippedH.readInt32LE(18), 10);
    assert.strictEqual(flippedH.readInt32LE(22), 20);

    const cropped = cropBmp(bmp, 0, 0, 4, 8);
    assert.strictEqual(cropped.readInt32LE(18), 4);
    assert.strictEqual(cropped.readInt32LE(22), 8);
  });

  test('POST /api/files/image/transform saves base64 imageData', async () => {
    const targetFile = 'test_canvas.png';
    const initialBuf = Buffer.from('initial image content');
    await fs.writeFile(path.join(userHome, targetFile), initialBuf);

    const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const res = await fetch(`${serverUrl}/api/files/image/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `/${targetFile}`,
        imageData: sampleBase64
      })
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.path, `/${targetFile}`);

    const savedBuf = await fs.readFile(path.join(userHome, targetFile));
    assert.strictEqual(savedBuf.length > 0, true);
    assert.notStrictEqual(savedBuf.toString(), initialBuf.toString());
  });

  test('POST /api/files/image/transform applies server-side operations (Rotate, Flip, Crop) to BMP file', async () => {
    const targetBmpFile = 'photo.bmp';
    const bmpBuf = createTestBmp(12, 24, { r: 0, g: 255, b: 0 });
    await fs.writeFile(path.join(userHome, targetBmpFile), bmpBuf);

    const res = await fetch(`${serverUrl}/api/files/image/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: `/${targetBmpFile}`,
        operations: [
          { type: 'rotate', angle: 90 },
          { type: 'crop', x: 0, y: 0, width: 6, height: 4 }
        ]
      })
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    const transformedDiskBuf = await fs.readFile(path.join(userHome, targetBmpFile));
    assert.strictEqual(transformedDiskBuf.readInt32LE(18), 6);
    assert.strictEqual(transformedDiskBuf.readInt32LE(22), 4);
  });

  test('POST /api/files/image/transform handles validation & path traversal security', async () => {
    // Missing path
    const resNoPath = await fetch(`${serverUrl}/api/files/image/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: 'data:image/png;base64,AAAA' })
    });
    assert.strictEqual(resNoPath.status, 400);

    // Non-existent file without imageData
    const res404 = await fetch(`${serverUrl}/api/files/image/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nonexistent_image.png', rotate: 90 })
    });
    assert.strictEqual(res404.status, 404);

    // Path traversal block
    const resTraversal = await fetch(`${serverUrl}/api/files/image/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/../../etc/passwd', imageData: 'data:image/png;base64,AAAA' })
    });
    assert.strictEqual(resTraversal.status, 403);
  });
});
