const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');
const express = require('express');
const http = require('http');
const filesRouter = require('../routes/files');
const LocalProvider = require('../providers/local');
const { buildGalleryItems, IMAGE_MIME_TYPES } = require('../utils/gallery');

const TEST_ROOT = path.resolve(__dirname, 'test_viewer_home');

describe('File Viewer & Media Previews (#11)', () => {
  let provider;

  before(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    provider = new LocalProvider({ userRoot: TEST_ROOT });
    await provider.ensureUserHome();
  });

  after(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('detects image MIME types correctly for preview stream', async () => {
    const pngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    await provider.write('/Documents/sample.png', Readable.from([pngContent]));

    const { mimeType } = await provider.read('/Documents/sample.png');
    assert.equal(mimeType, 'image/png');
  });

  test('detects PDF MIME type correctly for iframe viewer', async () => {
    const pdfContent = Buffer.from('%PDF-1.4 sample content');
    await provider.write('/Documents/sample.pdf', Readable.from([pdfContent]));

    const { mimeType } = await provider.read('/Documents/sample.pdf');
    assert.equal(mimeType, 'application/pdf');
  });

  test('detects video and audio MIME types for streaming players', async () => {
    await provider.write('/Documents/video.mp4', Readable.from([Buffer.from('mp4video')]));
    await provider.write('/Documents/audio.mp3', Readable.from([Buffer.from('mp3audio')]));

    const videoMeta = await provider.read('/Documents/video.mp4');
    const audioMeta = await provider.read('/Documents/audio.mp3');

    assert.equal(videoMeta.mimeType, 'video/mp4');
    assert.equal(audioMeta.mimeType, 'audio/mpeg');
  });

  test('detects source code and text MIME types for code previewer', async () => {
    await provider.write('/Documents/script.js', Readable.from([Buffer.from('console.log("hello");')]));
    await provider.write('/Documents/config.json', Readable.from([Buffer.from('{"key":"value"}')]));

    const jsMeta = await provider.read('/Documents/script.js');
    const jsonMeta = await provider.read('/Documents/config.json');

    assert.equal(jsMeta.mimeType, 'application/javascript');
    assert.equal(jsonMeta.mimeType, 'application/json');
  });
});

describe('Photo Gallery Mode (#23)', () => {
  const GALLERY_ROOT = path.resolve(__dirname, 'test_gallery_home');
  const USER_HOME = path.join(GALLERY_ROOT, 'gallery_user');
  let provider;

  let server;
  let baseUrl;
  const originalFilesRoot = process.env.FILES_ROOT;

  before(async () => {
    process.env.FILES_ROOT = GALLERY_ROOT;
    try { await fs.rm(GALLERY_ROOT, { recursive: true, force: true }); } catch {}
    provider = new LocalProvider({ userRoot: USER_HOME });
    await provider.ensureUserHome();

    // Seed: 3 images + 1 non-image in /Photos
    await provider.write('/Photos/beach.jpg',  Readable.from([Buffer.from('jpegsig')]));
    await provider.write('/Photos/sunset.png',  Readable.from([Buffer.from('pngsig')]));
    await provider.write('/Photos/avatar.gif',  Readable.from([Buffer.from('gifsig')]));
    await provider.write('/Photos/notes.txt',   Readable.from([Buffer.from('not an image')]));
    // Seed: /Documents has no images
    await provider.write('/Documents/report.pdf', Readable.from([Buffer.from('%PDF')]));

    const db = require('../db');
    await db.initDb();

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = 'gallery_user';
      req.userRoot = USER_HOME;
      req.session = { user: { id: 'gallery_user' } };
      next();
    });
    app.use('/api/files', filesRouter);

    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    process.env.FILES_ROOT = originalFilesRoot;
    if (server) await new Promise((res) => server.close(res));
    try { await fs.rm(GALLERY_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('IMAGE_MIME_TYPES includes common web image types', () => {
    const expected = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic'];
    for (const mime of expected) {
      assert.ok(IMAGE_MIME_TYPES.has(mime), `Expected IMAGE_MIME_TYPES to contain ${mime}`);
    }
  });

  test('buildGalleryItems returns only image files, filtering non-images', async () => {
    const items = await buildGalleryItems(provider, '/Photos');

    const names = items.map(i => i.name);
    assert.ok(names.includes('beach.jpg'),  'beach.jpg should be in gallery');
    assert.ok(names.includes('sunset.png'), 'sunset.png should be in gallery');
    assert.ok(names.includes('avatar.gif'), 'avatar.gif should be in gallery');
    assert.ok(!names.includes('notes.txt'), 'notes.txt must be excluded from gallery');
    assert.equal(items.length, 3, 'exactly 3 image files expected');
  });

  test('buildGalleryItems items contain lightbox-ready metadata fields', async () => {
    const items = await buildGalleryItems(provider, '/Photos');
    for (const item of items) {
      assert.ok(typeof item.name       === 'string', 'name must be string');
      assert.ok(typeof item.path       === 'string', 'path must be string');
      assert.ok(typeof item.mimeType   === 'string', 'mimeType must be string');
      assert.ok(typeof item.size       === 'number', 'size must be number');
      assert.ok(typeof item.modified   === 'string', 'modified must be ISO string');
      assert.ok(typeof item.thumbnailUrl === 'string', 'thumbnailUrl must be string');
      assert.ok(item.thumbnailUrl.startsWith('/api/files/read?path='), `thumbnailUrl must be a valid read URL, got: ${item.thumbnailUrl}`);
    }
  });

  test('buildGalleryItems sorts images alphabetically by name', async () => {
    const items = await buildGalleryItems(provider, '/Photos');
    const names = items.map(i => i.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted, 'gallery items must be sorted alphabetically');
  });

  test('buildGalleryItems returns empty array for folder containing no images', async () => {
    const items = await buildGalleryItems(provider, '/Documents');
    assert.equal(items.length, 0, 'no images in /Documents — should return empty array');
  });

  test('buildGalleryItems throws on path traversal attempt', async () => {
    await assert.rejects(
      () => buildGalleryItems(provider, '/Photos/../../../etc'),
      (err) => {
        assert.ok(err.message.includes('traversal') || err.message.includes('blocked') || err.code === 'ENOENT' || err.message.includes('outside'),
          `Expected traversal error, got: ${err.message}`);
        return true;
      }
    );
  });

  test('GET /api/files/gallery endpoint returns gallery payload for image folder', async () => {
    const res = await fetch(`${baseUrl}/api/files/gallery?path=/Photos`);
    const data = await res.json();
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.success, true);
    assert.equal(data.total, 3);
    assert.equal(data.items.length, 3);
    assert.ok(data.items.some(i => i.name === 'beach.jpg'));
  });
});

describe('Client-Side PDF Tools (#38)', () => {
  const PDF_ROOT = path.resolve(__dirname, 'test_pdf_home');
  const USER_HOME = path.join(PDF_ROOT, 'pdf_user');
  let provider;
  let server;
  let baseUrl;
  const originalFilesRoot = process.env.FILES_ROOT;

  const pdfTools = require('../utils/pdf_tools');

  before(async () => {
    process.env.FILES_ROOT = PDF_ROOT;
    try { await fs.rm(PDF_ROOT, { recursive: true, force: true }); } catch {}
    provider = new LocalProvider({ userRoot: USER_HOME });
    await provider.ensureUserHome();

    // Create sample PDF files
    const multiPagePdf = Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Count 2 /Kids [ 3 0 R 4 0 R ] >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>\nendobj\n' +
      '4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>\nendobj\n' +
      '5 0 obj\nstream\n(Page 1 content)\nendstream\nendobj\n' +
      '6 0 obj\nstream\n(Page 2 content)\nendstream\nendobj\n' +
      '%%EOF'
    );

    const doc1 = Buffer.from('%PDF-1.4\n3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n%%EOF');
    const doc2 = Buffer.from('%PDF-1.4\n3 0 obj\n<< /Type /Page /Contents 5 0 R >>\nendobj\n%%EOF');

    await provider.write('/Documents/sample_multipage.pdf', Readable.from([multiPagePdf]));
    await provider.write('/Documents/doc1.pdf', Readable.from([doc1]));
    await provider.write('/Documents/doc2.pdf', Readable.from([doc2]));

    const db = require('../db');
    await db.initDb();
    await db.upsertUser('pdf_user', 'PDF User', 'pdf@test.com');

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.userId = 'pdf_user';
      req.userRoot = USER_HOME;
      req.session = { user: { id: 'pdf_user' } };
      next();
    });
    app.use('/api/files', filesRouter);

    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    process.env.FILES_ROOT = originalFilesRoot;
    if (server) await new Promise((res) => server.close(res));
    try { await fs.rm(PDF_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('getPdfPageCount extracts accurate page count', () => {
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Type /Page >>\nendobj\n%%EOF'
    );
    assert.equal(pdfTools.getPdfPageCount(pdfBuf), 2);
  });

  test('rotatePdfPages rotates PDF pages correctly', () => {
    const pdfBuf = Buffer.from('%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
    const rotated = pdfTools.rotatePdfPages(pdfBuf, { angle: 90 });
    const str = rotated.toString('latin1');
    assert.ok(str.includes('/Rotate 90'), 'Rotated PDF buffer must contain /Rotate 90');
  });

  test('splitPdfPages splits multi-page PDF into separate PDF buffers', () => {
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n4 0 obj\n<< /Type /Page >>\nendobj\n%%EOF'
    );
    const split = pdfTools.splitPdfPages(pdfBuf, { ranges: [[1], [2]] });
    assert.equal(split.length, 2);
    assert.ok(split[0].toString('latin1').includes('%PDF-1.4'));
    assert.ok(split[1].toString('latin1').includes('%PDF-1.4'));
  });

  test('mergePdfBuffers merges multiple PDF buffers into single combined PDF', () => {
    const buf1 = Buffer.from('%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
    const buf2 = Buffer.from('%PDF-1.4\n4 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
    const merged = pdfTools.mergePdfBuffers([buf1, buf2]);
    assert.equal(pdfTools.getPdfPageCount(merged), 2);
  });

  test('POST /api/files/pdf/rotate rotates specified PDF file', async () => {
    const res = await fetch(`${baseUrl}/api/files/pdf/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Documents/sample_multipage.pdf', angle: 90 })
    });
    const data = await res.json();
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data.success, true);

    const { stream } = await provider.read('/Documents/sample_multipage.pdf');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const updated = Buffer.concat(chunks).toString('latin1');
    assert.ok(updated.includes('/Rotate 90'));
  });

  test('POST /api/files/pdf/split splits specified PDF into output files', async () => {
    const res = await fetch(`${baseUrl}/api/files/pdf/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/Documents/sample_multipage.pdf',
        ranges: [[1], [2]]
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.createdFiles.length, 2);

    for (const file of data.createdFiles) {
      const { stream } = await provider.read(file);
      assert.ok(stream, `File ${file} should exist`);
    }
  });

  test('POST /api/files/pdf/merge merges specified PDF files into target file', async () => {
    const res = await fetch(`${baseUrl}/api/files/pdf/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/Documents/doc1.pdf', '/Documents/doc2.pdf'],
        targetPath: '/Documents/merged_docs.pdf'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);

    const { stream } = await provider.read('/Documents/merged_docs.pdf');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const mergedContent = Buffer.concat(chunks);
    assert.equal(pdfTools.getPdfPageCount(mergedContent), 2);
  });

  test('POST /api/files/pdf/rotate blocks path traversal attempts', async () => {
    const res = await fetch(`${baseUrl}/api/files/pdf/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Documents/../../etc/passwd', angle: 90 })
    });
    assert.equal(res.status, 403);
  });
});


