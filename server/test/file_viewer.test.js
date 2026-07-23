const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');
const LocalProvider = require('../providers/local');

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
