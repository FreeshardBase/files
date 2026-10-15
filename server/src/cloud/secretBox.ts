import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM with the key from config (FILES_ENCRYPTION_KEY, HKDF-derived). The sealed form is
// `v1.<iv>.<tag>.<ciphertext>` in base64url. `context` is authenticated but not stored (the row a secret belongs to),
// so a ciphertext copied into another row does not open there either.
const VERSION = 'v1';

export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  // eslint-disable-next-line no-restricted-syntax -- a token of a few hundred bytes, not a file body
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Throws when the value was changed, belongs to another context or was sealed with another key. Never returns garbage. */
export function open(key: Buffer, sealed: string, context: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error(`sealed secret for ${context} has an unknown format`);
  const [, iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer, Buffer];
  if (iv.length !== 12 || tag.length !== 16) throw new Error(`sealed secret for ${context} has an unknown format`);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  try {
    // eslint-disable-next-line no-restricted-syntax -- a token of a few hundred bytes, not a file body
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new Error(`sealed secret for ${context} failed authentication (tampered, or another key)`, { cause: err });
  }
}
