const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const ocrService = require('../utils/ocr_service');
const filesRouter = require('../routes/files');

describe('Optical Character Recognition (OCR) Text Parsing Service (#80)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-ocr';
  let userHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_ocr_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_ocr.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'ocruser', 'ocruser@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    await fs.mkdir(path.join(userHome, 'Documents'), { recursive: true });
    await fs.mkdir(path.join(userHome, 'Images'), { recursive: true });

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

  test('Extractor Helper: extracts text from PDF buffer', async () => {
    const pdfContent = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\nBT /F1 12 Tf (Invoice receipt details for client AcmeCorp) Tj ET\nendstream\nendobj\n%%EOF'
    );
    const extracted = ocrService.extractTextFromBuffer(pdfContent, '.pdf');
    assert.ok(extracted.includes('Invoice receipt details for client AcmeCorp'));
  });

  test('Extractor Helper: extracts text from Image buffer (PNG / JPEG)', async () => {
    // Simulated PNG buffer with tEXt metadata / embedded OCR content
    const pngBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('tEXtComment\0OCR_TEXT: Confidential Financial Report 2026')
    ]);
    const extracted = ocrService.extractTextFromBuffer(pngBuffer, '.png');
    assert.ok(extracted.includes('Confidential Financial Report 2026'));
  });

  test('Extractor Helper: handles unsupported file types gracefully', async () => {
    const binBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const extracted = ocrService.extractTextFromBuffer(binBuffer, '.exe');
    assert.strictEqual(extracted, '');
  });

  test('Search Indexer Integration: reindexUserFiles parses PDF and image files using OCR', async () => {
    const pdfPath = path.join(userHome, 'Documents', 'invoice.pdf');
    const imgPath = path.join(userHome, 'Images', 'scan.png');

    const pdfBuffer = Buffer.from(
      '%PDF-1.4\nstream\nBT (Project Alpha Budget Breakdown) Tj ET\nendstream\n%%EOF'
    );
    const imgBuffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('tEXtComment\0OCR_TEXT: System Architecture Diagram for Freeshard')
    ]);

    await fs.writeFile(pdfPath, pdfBuffer);
    await fs.writeFile(imgPath, imgBuffer);

    const indexedCount = await db.reindexUserFiles(userId, userHome);
    assert.ok(indexedCount >= 2);

    const pdfSearchResults = await db.searchFulltext(userId, 'Breakdown');
    assert.strictEqual(pdfSearchResults.length, 1);
    assert.strictEqual(pdfSearchResults[0].path, '/Documents/invoice.pdf');

    const imgSearchResults = await db.searchFulltext(userId, 'Architecture');
    assert.strictEqual(imgSearchResults.length, 1);
    assert.strictEqual(imgSearchResults[0].path, '/Images/scan.png');
  });

  test('API Endpoint: POST /api/files/ocr/extract returns parsed text for target file', async () => {
    const targetRelPath = '/Documents/receipt.pdf';
    const targetDiskPath = path.join(userHome, 'Documents', 'receipt.pdf');
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\nstream\nBT (Receipt #998822 Total Paid $450) Tj ET\nendstream\n%%EOF'
    );
    await fs.writeFile(targetDiskPath, pdfBuffer);

    const res = await fetch(`${serverUrl}/api/files/ocr/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetRelPath })
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.path, targetRelPath);
    assert.ok(body.text.includes('Receipt #998822'));
    assert.ok(body.word_count > 0);
  });

  test('API Endpoint: POST /api/files/ocr/extract handles non-existent file with 404', async () => {
    const res = await fetch(`${serverUrl}/api/files/ocr/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Documents/nonexistent.pdf' })
    });
    assert.strictEqual(res.status, 404);
  });
});
