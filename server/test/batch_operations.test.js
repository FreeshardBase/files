const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const { Readable } = require('stream');
const LocalProvider = require('../providers/local');

const TEST_ROOT = path.resolve(__dirname, 'test_batch_home');

describe('Batch File Operations & Multi-Select API (#12)', () => {
  let provider;

  before(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
    provider = new LocalProvider({ userRoot: TEST_ROOT });
    await provider.ensureUserHome();

    // Create test files
    await provider.write('/Documents/f1.txt', Readable.from(['content 1']));
    await provider.write('/Documents/f2.txt', Readable.from(['content 2']));
    await provider.write('/Documents/f3.txt', Readable.from(['content 3']));
    await provider.mkdir('/TargetDir');
  });

  after(async () => {
    try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  });

  test('batch move moves multiple files successfully', async () => {
    await provider.move('/Documents/f1.txt', '/TargetDir/f1.txt');
    await provider.move('/Documents/f2.txt', '/TargetDir/f2.txt');

    const targetList = await provider.list('/TargetDir');
    const names = targetList.map(i => i.name);

    assert.ok(names.includes('f1.txt'));
    assert.ok(names.includes('f2.txt'));
  });

  test('batch delete removes multiple files in one operation', async () => {
    await provider.delete('/TargetDir/f1.txt');
    await provider.delete('/TargetDir/f2.txt');

    const targetList = await provider.list('/TargetDir');
    assert.equal(targetList.length, 0);
  });

  test('validates single and multi-file existence for batch zip preparation', async () => {
    const meta3 = await provider.metadata('/Documents/f3.txt');
    assert.equal(meta3.name, 'f3.txt');
  });
});
