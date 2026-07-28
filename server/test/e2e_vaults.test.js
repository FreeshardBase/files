const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');
const { webcrypto } = require('node:crypto');

const db = require('../db');
const vaultsRouter = require('../routes/vaults');

const cryptoApi = webcrypto || globalThis.crypto;

// Client-side WebCrypto AES-GCM-256 & PBKDF2 helpers for E2EE testing
async function deriveKey(passphrase, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await cryptoApi.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const salt = Buffer.from(saltHex, 'hex');
  return cryptoApi.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(key, plaintext) {
  const enc = new TextEncoder();
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const encrypted = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return JSON.stringify({
    iv: Buffer.from(iv).toString('hex'),
    ciphertext: Buffer.from(encrypted).toString('hex')
  });
}

async function decryptData(key, encryptedJson) {
  const { iv: ivHex, ciphertext: ciphertextHex } = JSON.parse(encryptedJson);
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decrypted = await cryptoApi.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

describe('Zero-Knowledge End-to-End Encryption Vaults (E2EE) (#75)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  const userId = 'user-e2e-vault-1';
  const userBId = 'user-e2e-vault-2';

  before(async () => {
    dataDir = path.join(__dirname, 'data_vaults_test');
    process.env.DATA_DIR = dataDir;
    process.env.DATABASE_PATH = path.join(dataDir, 'test_vaults.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'vaultuser1', 'vault1@freeshard.local');
    await db.upsertUser(userBId, 'vaultuser2', 'vault2@freeshard.local');

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Test session/auth setup
    app.use((req, res, next) => {
      const authHeader = req.headers['x-test-user'];
      if (authHeader === 'none') {
        req.session = {};
        return next();
      }
      const activeUser = authHeader || userId;
      req.session = { userId: activeUser, user: { id: activeUser } };
      next();
    });

    app.use('/api/vaults', vaultsRouter);

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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('DB Helpers: createVault, getVaultsByUser, and getVaultById', async () => {
    const salt = 'a1b2c3d4e5f67890a1b2c3d4e5f67890';
    const metadata = JSON.stringify({ iv: '123', ciphertext: '456' });
    
    const vault = await db.createVault(userId, 'My Secret Vault', salt, metadata);
    assert.ok(vault.id);
    assert.equal(vault.user_id, userId);
    assert.equal(vault.name, 'My Secret Vault');
    assert.equal(vault.salt, salt);
    assert.equal(vault.encrypted_metadata, metadata);

    const userVaults = await db.getVaultsByUser(userId);
    assert.ok(Array.isArray(userVaults));
    assert.ok(userVaults.some(v => v.id === vault.id));

    const foundVault = await db.getVaultById(vault.id, userId);
    assert.ok(foundVault);
    assert.equal(foundVault.name, 'My Secret Vault');

    const wrongUserVault = await db.getVaultById(vault.id, userBId);
    assert.equal(wrongUserVault, undefined);
  });

  test('API Endpoint: POST /api/vaults/create creates a new E2EE vault', async () => {
    const passphrase = 'SuperSecretMasterPassword123!';
    const saltHex = Buffer.from(cryptoApi.getRandomValues(new Uint8Array(16))).toString('hex');
    const key = await deriveKey(passphrase, saltHex);
    const plaintextMeta = JSON.stringify({ note: 'Personal Vault Keys', files: ['doc1.enc'] });
    const encryptedMeta = await encryptData(key, plaintextMeta);

    const res = await fetch(`${serverUrl}/api/vaults/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        name: 'Confidential Finance Vault',
        salt: saltHex,
        encrypted_metadata: encryptedMeta
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.vault.id);
    assert.equal(data.vault.name, 'Confidential Finance Vault');
    assert.equal(data.vault.salt, saltHex);
    assert.equal(data.vault.encrypted_metadata, encryptedMeta);
  });

  test('API Endpoint: POST /api/vaults/create validates required parameters', async () => {
    const res = await fetch(`${serverUrl}/api/vaults/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ name: 'Incomplete Vault' })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: POST /api/vaults/create requires authentication', async () => {
    const res = await fetch(`${serverUrl}/api/vaults/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'none' },
      body: JSON.stringify({
        name: 'Unauth Vault',
        salt: '1234',
        encrypted_metadata: 'abcd'
      })
    });

    assert.equal(res.status, 401);
  });

  test('API Endpoint: POST /api/vaults/unlock retrieves vault metadata for client decryption', async () => {
    const passphrase = 'UnlockPassword456!';
    const saltHex = Buffer.from(cryptoApi.getRandomValues(new Uint8Array(16))).toString('hex');
    const key = await deriveKey(passphrase, saltHex);
    const secretContent = 'TOP_SECRET_CREDENTIALS_123';
    const encryptedMeta = await encryptData(key, secretContent);

    // Create vault first
    const createRes = await fetch(`${serverUrl}/api/vaults/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({
        name: 'Unlock Test Vault',
        salt: saltHex,
        encrypted_metadata: encryptedMeta
      })
    });
    const { vault } = await createRes.json();

    // Unlock request
    const unlockRes = await fetch(`${serverUrl}/api/vaults/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userId },
      body: JSON.stringify({ vault_id: vault.id })
    });

    assert.equal(unlockRes.status, 200);
    const unlockData = await unlockRes.json();
    assert.equal(unlockData.success, true);
    assert.equal(unlockData.vault.id, vault.id);
    assert.equal(unlockData.vault.salt, saltHex);

    // Perform client-side WebCrypto decryption using retrieved vault salt & encrypted_metadata
    const derivedClientKey = await deriveKey(passphrase, unlockData.vault.salt);
    const decryptedPayload = await decryptData(derivedClientKey, unlockData.vault.encrypted_metadata);
    assert.equal(decryptedPayload, secretContent);
  });

  test('API Endpoint: POST /api/vaults/unlock enforces user isolation (404 on unowned vault)', async () => {
    const vault = await db.createVault(userId, 'Private Vault User A', 'salt123', 'meta123');

    // Attempt to unlock as User B
    const res = await fetch(`${serverUrl}/api/vaults/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': userBId },
      body: JSON.stringify({ vault_id: vault.id })
    });

    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
  });

  test('API Endpoint: GET /api/vaults lists user vaults', async () => {
    const res = await fetch(`${serverUrl}/api/vaults`, {
      headers: { 'x-test-user': userId }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.vaults));
    assert.ok(data.vaults.length >= 2);
  });
});
