const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');
const LocalProvider = require('../providers/local');
const BaseProvider = require('../providers/base');

const TEST_ROOT = path.resolve(__dirname, 'test_user_home');

describe('LocalProvider & BaseProvider Contract (#4)', () => {
  let provider;

  before(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    provider = new LocalProvider({ userRoot: TEST_ROOT });
    await provider.ensureUserHome();
  });

  after(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('inherits from BaseProvider', () => {
    assert.ok(provider instanceof BaseProvider);
  });

  test('ensureUserHome creates home, Documents, and Pictures directories', async () => {
    const list = await provider.list('/');
    const names = list.map(item => item.name);
    assert.ok(names.includes('Documents'));
    assert.ok(names.includes('Pictures'));
  });

  test('mkdir creates a new folder', async () => {
    await provider.mkdir('/Projects');
    const meta = await provider.metadata('/Projects');
    assert.equal(meta.name, 'Projects');
    assert.equal(meta.isDirectory, true);
  });

  test('write performs atomic file creation via stream', async () => {
    const content = 'Hello FreeShard Files LocalProvider!';
    const stream = Readable.from([Buffer.from(content)]);
    
    const result = await provider.write('/Documents/hello.txt', stream);
    assert.equal(result.path, '/Documents/hello.txt');

    const meta = await provider.metadata('/Documents/hello.txt');
    assert.equal(meta.size, Buffer.byteLength(content));
    assert.equal(meta.mimeType, 'text/plain');
  });

  test('handles UTF-8 filenames with special characters (Spanish ñ, German Umlauts)', async () => {
    const filename = '/Documents/Español_ñ_ö_ä_ü.txt';
    const content = 'UTF-8 Content Test';
    const stream = Readable.from([Buffer.from(content)]);

    const result = await provider.write(filename, stream);
    assert.equal(path.basename(result.path), 'Español_ñ_ö_ä_ü.txt');

    const list = await provider.list('/Documents');
    const match = list.find(item => item.name === 'Español_ñ_ö_ä_ü.txt');
    assert.ok(match);
  });

  test('read returns a readable stream with size and mimeType', async () => {
    const { stream, size, mimeType } = await provider.read('/Documents/hello.txt');
    assert.equal(mimeType, 'text/plain');
    assert.ok(size > 0);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const readText = Buffer.concat(chunks).toString('utf8');
    assert.equal(readText, 'Hello FreeShard Files LocalProvider!');
  });

  test('copy duplicates a file', async () => {
    await provider.copy('/Documents/hello.txt', '/Documents/hello_copy.txt');
    const meta = await provider.metadata('/Documents/hello_copy.txt');
    assert.equal(meta.name, 'hello_copy.txt');
  });

  test('move renames a file', async () => {
    await provider.move('/Documents/hello_copy.txt', '/Documents/hello_moved.txt');
    const meta = await provider.metadata('/Documents/hello_moved.txt');
    assert.equal(meta.name, 'hello_moved.txt');

    await assert.rejects(async () => {
      await provider.metadata('/Documents/hello_copy.txt');
    });
  });

  test('search finds files by name', async () => {
    const results = await provider.search('moved');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'hello_moved.txt');
  });

  test('delete removes a file', async () => {
    await provider.delete('/Documents/hello_moved.txt');
    await assert.rejects(async () => {
      await provider.metadata('/Documents/hello_moved.txt');
    });
  });

  test('blocks path traversal via LocalProvider API', async () => {
    await assert.rejects(async () => {
      await provider.list('../../etc');
    }, /path escapes user root/);

    await assert.rejects(async () => {
      await provider.read('../../../etc/passwd');
    }, /path escapes user root/);
  });
});
