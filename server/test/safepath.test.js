const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { safePath, toRelativePath } = require('../utils/safepath');
const { ensureUserHome, validateUserIsolation } = require('../middleware/isolation');
const { encrypt, decrypt, getEncryptionKey } = require('../utils/crypto');

const USER_ROOT = path.resolve('/tmp/freeshard_test_user_home');

describe('Path Traversal Guard: safePath() (#4, #13, Risk 2)', () => {
  test('resolves valid relative paths correctly', () => {
    assert.equal(safePath(USER_ROOT, '/'), USER_ROOT);
    assert.equal(safePath(USER_ROOT, ''), USER_ROOT);
    assert.equal(safePath(USER_ROOT, 'Documents'), path.join(USER_ROOT, 'Documents'));
    assert.equal(safePath(USER_ROOT, '/Documents/file.txt'), path.join(USER_ROOT, 'Documents', 'file.txt'));
    assert.equal(safePath(USER_ROOT, 'Pictures/2026/photo.jpg'), path.join(USER_ROOT, 'Pictures', '2026', 'photo.jpg'));
  });

  test('blocks simple directory traversal attempts (../)', () => {
    assert.throws(() => safePath(USER_ROOT, '../'), /path escapes user root/);
    assert.throws(() => safePath(USER_ROOT, '../../etc/passwd'), /path escapes user root/);
    assert.throws(() => safePath(USER_ROOT, 'Documents/../../..'), /path escapes user root/);
  });

  test('blocks URL-encoded traversal payloads (%2f, %2e)', () => {
    assert.throws(() => safePath(USER_ROOT, '..%2f'), /path escapes user root/);
    assert.throws(() => safePath(USER_ROOT, '..%2f..%2fetc%2fpasswd'), /path escapes user root/);
    assert.throws(() => safePath(USER_ROOT, '%2e%2e%2f%2e%2e%2fetc%2fpasswd'), /path escapes user root/);
  });

  test('blocks double URL-encoded traversal payloads (%252f)', () => {
    assert.throws(() => safePath(USER_ROOT, '..%252f..%252fetc%252fpasswd'), /path escapes user root/);
  });

  test('blocks null byte injection (%00, \\0)', () => {
    assert.throws(() => safePath(USER_ROOT, 'file.txt\0.jpg'), /null byte/);
    assert.throws(() => safePath(USER_ROOT, 'file.txt%00.jpg'), /null byte/);
  });

  test('blocks Windows-style backslash traversal', () => {
    assert.throws(() => safePath(USER_ROOT, '..\\..\\etc\\passwd'), /path escapes user root/);
    assert.throws(() => safePath(USER_ROOT, 'Documents\\..\\..\\'), /path escapes user root/);
  });

  test('blocks multi-dot and redundant slash tricks (....//)', () => {
    assert.throws(() => safePath(USER_ROOT, '....//....//etc/passwd'), /path escapes user root/);
  });

  test('blocks non-string arguments', () => {
    assert.throws(() => safePath(USER_ROOT, null), /must be a string/);
    assert.throws(() => safePath(USER_ROOT, undefined), /must be a string/);
    assert.throws(() => safePath(USER_ROOT, 123), /must be a string/);
  });

  test('formats toRelativePath correctly', () => {
    assert.equal(toRelativePath(USER_ROOT, USER_ROOT), '/');
    assert.equal(toRelativePath(USER_ROOT, path.join(USER_ROOT, 'Documents')), '/Documents');
    assert.equal(toRelativePath(USER_ROOT, path.join(USER_ROOT, 'Pictures', 'cat.jpg')), '/Pictures/cat.jpg');
  });

  test('rejects toRelativePath for outside paths', () => {
    assert.throws(() => toRelativePath(USER_ROOT, '/etc/passwd'), /outside user root/);
  });
});

describe('User Home Isolation Guard (#24)', () => {
  const testIsoRoot = path.resolve('/tmp/freeshard_isolation_test');

  after(async () => {
    await fs.rm(testIsoRoot, { recursive: true, force: true });
  });

  test('ensureUserHome creates required directory structure', async () => {
    const userDir = path.join(testIsoRoot, 'user_a');
    await ensureUserHome(userDir);
    const docs = await fs.stat(path.join(userDir, 'Documents'));
    const pics = await fs.stat(path.join(userDir, 'Pictures'));
    assert.ok(docs.isDirectory());
    assert.ok(pics.isDirectory());
  });

  test('validateUserIsolation populates req context and enforces boundary', async () => {
    const req = {
      userId: 'user_b',
      method: 'GET',
      query: { path: '/Documents/report.pdf' },
      headers: {}
    };
    const res = { status: () => res, json: () => res };
    let nextCalled = false;
    await validateUserIsolation(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled);
    assert.ok(req.userRoot.includes('user_b'));
    assert.equal(req.resolvedPath, path.join(req.userRoot, 'Documents', 'report.pdf'));
  });

  test('validateUserIsolation rejects traversal attempt with HTTP 403', async () => {
    const req = {
      userId: 'user_c',
      method: 'GET',
      query: { path: '../../etc/passwd' },
      headers: {}
    };
    let statusCode = null;
    let jsonBody = null;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: (body) => { jsonBody = body; return res; }
    };
    await validateUserIsolation(req, res, () => {});

    assert.equal(statusCode, 403);
    assert.ok(jsonBody.error.includes('Path traversal blocked'));
  });

  test('prevents cross-user root path escaping', () => {
    const userARoot = path.join(testIsoRoot, 'user_alpha');
    const userBRoot = path.join(testIsoRoot, 'user_beta');
    const targetInB = path.join(userBRoot, 'secret.txt');

    assert.throws(() => safePath(userARoot, path.relative(userARoot, targetInB)), /path escapes user root/);
  });
});

describe('Encryption Invariants Guard (#24)', () => {
  const originalEnvKey = process.env.ENCRYPTION_KEY;

  before(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  after(() => {
    process.env.ENCRYPTION_KEY = originalEnvKey;
  });

  test('requires valid 32-byte (64 hex char) ENCRYPTION_KEY', () => {
    const key = getEncryptionKey();
    assert.equal(key.length, 32);
  });

  test('throws error if ENCRYPTION_KEY is missing or invalid length', () => {
    const backup = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    assert.throws(() => getEncryptionKey(), /ENCRYPTION_KEY environment variable is missing/);

    process.env.ENCRYPTION_KEY = 'invalidkey';
    assert.throws(() => getEncryptionKey(), /ENCRYPTION_KEY must be exactly 32 bytes/);

    process.env.ENCRYPTION_KEY = backup;
  });

  test('encrypts and decrypts string content using AES-256-GCM', () => {
    const plaintext = 'Sensitive User Payload 2026';
    const encrypted = encrypt(plaintext);

    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);
    assert.ok(encrypted.data);
    assert.notEqual(encrypted.data, plaintext);

    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, plaintext);
  });

  test('detects ciphertext tampering and fails decryption', () => {
    const encrypted = encrypt('Tamper test data');
    const lastChar = encrypted.data.slice(-1);
    const tamperedData = encrypted.data.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    assert.throws(() => decrypt({ ...encrypted, data: tamperedData }));
  });

  test('rejects non-string plaintext during encryption', () => {
    assert.throws(() => encrypt(12345), /Plaintext must be a string/);
    assert.throws(() => encrypt(null), /Plaintext must be a string/);
  });
});

