const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const db = require('../db');

describe('Internal File & Folder Sharing (#14, #45 Invariant)', () => {
  const userA = { id: 'user_owner_1', username: 'alice', displayName: 'Alice' };
  const userB = { id: 'user_sharee_2', username: 'bob', displayName: 'Bob' };

  before(async () => {
    await db.initDb();
    await db.upsertUser(userA.id, userA.username, 'alice@example.com', 'local', null, userA.displayName);
    await db.upsertUser(userB.id, userB.username, 'bob@example.com', 'local', null, userB.displayName);
  });

  after(async () => {
    await db.run('DELETE FROM file_shares');
    await db.run('DELETE FROM public_shares');
    await db.run('DELETE FROM users WHERE id IN (?, ?)', [userA.id, userB.id]);
  });

  test('creates internal file share and lists for sharee', async () => {
    const share = await db.createFileShare(userA.id, userB.id, '/Documents/Report.pdf', 'local', 0, 1);
    assert.ok(share.id);
    assert.equal(share.file_path, '/Documents/Report.pdf');
    assert.equal(share.read_write, 1);

    const shareeList = await db.getFileSharesForSharee(userB.id);
    assert.ok(shareeList.length >= 1);
    const match = shareeList.find(s => s.id === share.id);
    assert.ok(match);
    assert.equal(match.owner_username, 'alice');
  });

  test('lists created shares for owner', async () => {
    const ownerList = await db.getFileSharesByOwner(userA.id);
    assert.ok(ownerList.length >= 1);
    const match = ownerList.find(s => s.file_path === '/Documents/Report.pdf');
    assert.ok(match);
    assert.equal(match.sharee_username, 'bob');
  });

  test('preserves share links on file/folder move (path cascading invariant #14, #45)', async () => {
    // Share a folder and a file inside it
    const folderShare = await db.createFileShare(userA.id, userB.id, '/Projects/Alpha', 'local', 1, 0);
    const subfileShare = await db.createFileShare(userA.id, userB.id, '/Projects/Alpha/doc.txt', 'local', 0, 0);

    // Move /Projects/Alpha to /Archive/Projects/Alpha
    await db.updateSharePathsOnMove(userA.id, '/Projects/Alpha', '/Archive/Projects/Alpha');

    const updatedOwnerShares = await db.getFileSharesByOwner(userA.id);
    
    const updatedFolder = updatedOwnerShares.find(s => s.id === folderShare.id);
    const updatedSubfile = updatedOwnerShares.find(s => s.id === subfileShare.id);

    assert.equal(updatedFolder.file_path, '/Archive/Projects/Alpha');
    assert.equal(updatedSubfile.file_path, '/Archive/Projects/Alpha/doc.txt');
  });

  test('revokes an internal share', async () => {
    const share = await db.createFileShare(userA.id, userB.id, '/Temp/notes.txt', 'local', 0, 0);
    const deleted = await db.deleteFileShare(share.id, userA.id);
    assert.equal(deleted, true);

    const ownerShares = await db.getFileSharesByOwner(userA.id);
    const match = ownerShares.find(s => s.id === share.id);
    assert.equal(match, undefined);
  });
});
