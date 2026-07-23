const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { safePath, toRelativePath } = require('../utils/safepath');

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
