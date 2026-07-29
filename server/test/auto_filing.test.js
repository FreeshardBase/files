const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const fs = require('fs/promises');
const path = require('path');
const db = require('../db');
const autoFilingRouter = require('../routes/auto_filing');
const { evaluateRules, processAutoFiling } = require('../utils/auto_filing');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'test_autofiling_' + Date.now());
process.env.DATA_DIR = DATA_DIR;
process.env.DATABASE_PATH = path.join(DATA_DIR, 'files.db');

let server;
let baseUrl;
const TEST_USER = {
  id: 'user_autofiling_101',
  username: 'autofiler',
  email: 'autofiler@example.com'
};

async function makeRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || data });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await db.initDb();
  await db.upsertUser(TEST_USER.id, TEST_USER.username, TEST_USER.email);

  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, res, next) => {
    req.userId = TEST_USER.id;
    req.session = req.session || {};
    req.session.userId = TEST_USER.id;
    next();
  });
  app.use('/api/auto-filing', autoFilingRouter);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) server.close();
  await db.closeDb();
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  const rules = await db.getFilingRulesByUser(TEST_USER.id);
  for (const rule of rules) {
    await db.deleteFilingRule(TEST_USER.id, rule.id);
  }
});

test('Auto-Filing: Create, List, and Delete filing rules via API', async () => {
  // Create rule
  const createRes = await makeRequest('POST', '/api/auto-filing/rules', {
    name: 'Sort PDFs',
    condition_type: 'extension',
    condition_value: 'pdf',
    target_folder: '/Documents/PDFs',
    priority: 10
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.success, true);
  assert.ok(createRes.body.rule.id);
  assert.equal(createRes.body.rule.target_folder, '/Documents/PDFs');

  const ruleId = createRes.body.rule.id;

  // List rules
  const listRes = await makeRequest('GET', '/api/auto-filing/rules');
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.rules.length, 1);
  assert.equal(listRes.body.rules[0].name, 'Sort PDFs');

  // Delete rule
  const delRes = await makeRequest('DELETE', `/api/auto-filing/rules/${ruleId}`);
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.success, true);

  // List after delete
  const listAfter = await makeRequest('GET', '/api/auto-filing/rules');
  assert.equal(listAfter.body.rules.length, 0);
});

test('Auto-Filing: Validation when creating rule', async () => {
  const badRes = await makeRequest('POST', '/api/auto-filing/rules', {
    condition_type: 'extension'
    // missing condition_value & target_folder
  });
  assert.equal(badRes.status, 400);
});

test('Auto-Filing: Extension matching evaluation', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Images Rule',
    condition_type: 'extension',
    condition_value: 'png',
    target_folder: '/Pictures'
  });

  const match = await evaluateRules(TEST_USER.id, 'photo.PNG');
  assert.ok(match);
  assert.equal(match.target_folder, '/Pictures');

  const noMatch = await evaluateRules(TEST_USER.id, 'document.docx');
  assert.equal(noMatch, null);
});

test('Auto-Filing: Keyword matching evaluation', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Invoices',
    condition_type: 'keyword',
    condition_value: 'invoice',
    target_folder: '/Finance/Invoices'
  });

  const match = await evaluateRules(TEST_USER.id, 'July_Invoice_2026.pdf');
  assert.ok(match);
  assert.equal(match.target_folder, '/Finance/Invoices');
});

test('Auto-Filing: MIME type matching evaluation', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Audio Files',
    condition_type: 'mime_type',
    condition_value: 'audio/*',
    target_folder: '/Music'
  });

  const match = await evaluateRules(TEST_USER.id, 'song.mp3', 'audio/mpeg');
  assert.ok(match);
  assert.equal(match.target_folder, '/Music');
});

test('Auto-Filing: Regex matching evaluation', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Year Reports',
    condition_type: 'regex',
    condition_value: '^report_\\d{4}\\.txt$',
    target_folder: '/Reports'
  });

  const match = await evaluateRules(TEST_USER.id, 'report_2026.txt');
  assert.ok(match);
  assert.equal(match.target_folder, '/Reports');

  const noMatch = await evaluateRules(TEST_USER.id, 'report_abc.txt');
  assert.equal(noMatch, null);
});

test('Auto-Filing: Priority order evaluation', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Low Priority PDF',
    condition_type: 'extension',
    condition_value: 'pdf',
    target_folder: '/GeneralPDFs',
    priority: 1
  });

  await db.createFilingRule(TEST_USER.id, {
    name: 'High Priority Invoice PDF',
    condition_type: 'keyword',
    condition_value: 'invoice',
    target_folder: '/Invoices',
    priority: 10
  });

  const match = await evaluateRules(TEST_USER.id, 'invoice_march.pdf');
  assert.ok(match);
  assert.equal(match.target_folder, '/Invoices');
});

test('Auto-Filing: File relocation processor', async () => {
  const userDir = path.join(DATA_DIR, 'users', TEST_USER.id, 'files');
  await fs.mkdir(userDir, { recursive: true });

  const sourcePath = '/incoming_tax.pdf';
  const sourceDisk = path.join(userDir, 'incoming_tax.pdf');
  await fs.writeFile(sourceDisk, 'tax report content');

  await db.createFilingRule(TEST_USER.id, {
    name: 'Tax Rules',
    condition_type: 'keyword',
    condition_value: 'tax',
    target_folder: '/Taxes/2026'
  });

  const result = await processAutoFiling(TEST_USER.id, sourcePath);
  assert.equal(result.filed, true);
  assert.equal(result.destinationPath, '/Taxes/2026/incoming_tax.pdf');

  const destDisk = path.join(userDir, 'Taxes', '2026', 'incoming_tax.pdf');
  const exists = await fs.stat(destDisk).then(() => true).catch(() => false);
  assert.equal(exists, true);
});

test('Auto-Filing: API process endpoint moves file', async () => {
  const userDir = path.join(DATA_DIR, 'users', TEST_USER.id, 'files');
  await fs.mkdir(userDir, { recursive: true });

  const fileDisk = path.join(userDir, 'scan_receipt.jpg');
  await fs.writeFile(fileDisk, 'receipt image data');

  await db.createFilingRule(TEST_USER.id, {
    name: 'Receipts',
    condition_type: 'keyword',
    condition_value: 'receipt',
    target_folder: '/Receipts'
  });

  const res = await makeRequest('POST', '/api/auto-filing/process', {
    filePath: '/scan_receipt.jpg'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.filed, true);
  assert.equal(res.body.destinationPath, '/Receipts/scan_receipt.jpg');
});

test('Auto-Filing: Inactive rule ignored', async () => {
  await db.createFilingRule(TEST_USER.id, {
    name: 'Disabled Rule',
    condition_type: 'extension',
    condition_value: 'txt',
    target_folder: '/Text',
    is_active: 0
  });

  const match = await evaluateRules(TEST_USER.id, 'test.txt');
  assert.equal(match, null);
});
