const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// Set test encryption key (64 hex chars = 32 bytes)
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encrypt, decrypt, getEncryptionKey } = require('../utils/crypto');

describe('AES-256-GCM Credential Encryption (#3)', () => {
  test('validates 32-byte key correctly', () => {
    const key = getEncryptionKey();
    assert.equal(key.length, 32);
  });

  test('rejects missing or invalid key length', () => {
    const original = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'shortkey';
    assert.throws(() => getEncryptionKey(), /must be exactly 32 bytes/);
    process.env.ENCRYPTION_KEY = original;
  });

  test('encrypts and decrypts string payload correctly', () => {
    const secretPayload = JSON.stringify({ access_token: 'ya29.test-token', refresh_token: '1//0g-test' });
    const encrypted = encrypt(secretPayload);

    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);
    assert.ok(encrypted.data);

    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, secretPayload);
  });

  test('generates unique IV for each encryption operation', () => {
    const text = 'same-secret-data';
    const enc1 = encrypt(text);
    const enc2 = encrypt(text);

    assert.notEqual(enc1.iv, enc2.iv);
    assert.notEqual(enc1.data, enc2.data);
  });

  test('fails decryption if auth tag is tampered with', () => {
    const encrypted = encrypt('sensitive-data');
    // Tamper with auth tag
    const tamperedTag = encrypted.authTag.replace(/0/g, '1');
    const tamperedObj = { ...encrypted, authTag: tamperedTag };

    assert.throws(() => decrypt(tamperedObj));
  });

  test('fails decryption if ciphertext is tampered with', () => {
    const encrypted = encrypt('sensitive-data');
    // Tamper with data
    const tamperedData = encrypted.data.replace(/a/g, 'b');
    const tamperedObj = { ...encrypted, data: tamperedData };

    assert.throws(() => decrypt(tamperedObj));
  });
});
