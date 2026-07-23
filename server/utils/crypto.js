const crypto = require('crypto');

function getEncryptionKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY environment variable is missing');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). Got ${key.length} bytes.`);
  }
  return key;
}

/**
 * Encrypts plaintext string using AES-256-GCM
 * @param {string} plaintext 
 * @returns {{ iv: string, authTag: string, data: string }}
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('Plaintext must be a string');
  }
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('hex')
  };
}

/**
 * Decrypts ciphertext using AES-256-GCM
 * @param {{ iv: string, authTag: string, data: string }} encryptedObj 
 * @returns {string}
 */
function decrypt(encryptedObj) {
  if (!encryptedObj || !encryptedObj.iv || !encryptedObj.authTag || !encryptedObj.data) {
    throw new Error('Invalid encrypted object format. Required properties: iv, authTag, data');
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const authTag = Buffer.from(encryptedObj.authTag, 'hex');
  const encryptedData = Buffer.from(encryptedObj.data, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encrypt,
  decrypt,
  getEncryptionKey
};
