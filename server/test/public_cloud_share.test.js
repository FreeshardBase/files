const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { run, get, all, initDb, createPublicShare, getPublicShareByToken } = require('../db');
const { Readable } = require('stream');

describe('Cloud Provider Public Link Sharing & Media Previews (#15, #56, #PUBLIC-CLOUD-FIX)', () => {
  const userId = 'user_cloud_share_test';
  let connectionId;
  let publicToken;

  before(async () => {
    process.env.DATABASE_PATH = ':memory:';
    await initDb();
    await run("INSERT OR IGNORE INTO users (id, username, email) VALUES (?, ?, ?)", [userId, 'cloud_sharer', 'sharer@test.com']);
    
    // Create a mock Dropbox provider connection
    const res = await run(
      "INSERT INTO provider_connections (user_id, provider_type, display_name, credentials_encrypted, iv, auth_tag, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [userId, 'dropbox', 'Dropbox Work Account', 'enc_data', 'iv', 'tag']
    );
    connectionId = res.lastID;
  });

  test('creates a public share link bound to a Cloud Provider connection', async () => {
    const token = 'token_dropbox_photo_999';
    const filePath = '/Photos/Kaoma - Lambada.jpg';

    const share = await createPublicShare(
      userId,
      token,
      filePath,
      0, // isDirectory
      null, // passwordHash
      null, // expiresAt
      null, // maxDownloads
      'Lambada Photo',
      'dropbox',
      connectionId
    );

    assert.ok(share);
    assert.equal(share.token, token);
    assert.equal(share.provider_type, 'dropbox');
    assert.equal(share.provider_connection_id, connectionId);
    publicToken = token;
  });

  test('retrieves public share by token with cloud provider metadata intact', async () => {
    const share = await getPublicShareByToken(publicToken);
    assert.ok(share);
    assert.equal(share.user_id, userId);
    assert.equal(share.provider_type, 'dropbox');
    assert.equal(share.provider_connection_id, connectionId);
    assert.equal(share.file_path, '/Photos/Kaoma - Lambada.jpg');
  });

  test('resolves provider instance and streams cloud file without ENOENT local filesystem errors', async () => {
    const share = await getPublicShareByToken(publicToken);
    const DropboxProvider = require('../providers/dropbox');

    const sampleImageBuffer = Buffer.from('MOCK_JPEG_IMAGE_BINARY_DATA');

    const mockProvider = new DropboxProvider({ accessToken: 'mock_token' });
    mockProvider.read = async (path) => {
      assert.equal(path, '/Photos/Kaoma - Lambada.jpg');
      return {
        stream: Readable.from([sampleImageBuffer]),
        size: sampleImageBuffer.length,
        mimeType: 'image/jpeg'
      };
    };

    const { stream, size, mimeType } = await mockProvider.read(share.file_path);
    assert.equal(size, sampleImageBuffer.length);
    assert.equal(mimeType, 'image/jpeg');

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const finalBuffer = Buffer.concat(chunks);
    assert.equal(finalBuffer.toString('utf8'), sampleImageBuffer.toString('utf8'));
  });
});
