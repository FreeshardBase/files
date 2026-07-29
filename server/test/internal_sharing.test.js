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
    await db.run('DELETE FROM federated_shares');
    await db.run('DELETE FROM inbound_federated_shares');
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

  // ── Cross-Shard File Sharing (#31) ────────────────────────────────────────

  test('creates cross-shard federated share targeting remote shard user (#31)', async () => {
    const share = await db.createFederatedShare(
      userA.id,
      'shard_b8rk3f',
      'charlie@shard_b8rk3f',
      '/Shared/Project.docx',
      0,
      1,
      'fed_token_123'
    );
    assert.ok(share.id);
    assert.equal(share.target_shard_id, 'shard_b8rk3f');
    assert.equal(share.sharee_handle, 'charlie@shard_b8rk3f');
    assert.equal(share.federated_token, 'fed_token_123');

    const ownerShares = await db.getFederatedSharesByOwner(userA.id);
    const match = ownerShares.find(s => s.id === share.id);
    assert.ok(match);
    assert.equal(match.file_path, '/Shared/Project.docx');
  });

  test('handles inbound cross-shard share notification (#31)', async () => {
    const inbound = await db.createInboundFederatedShare(
      userB.id,
      'shard_c0p3x5',
      'alice@shard_c0p3x5',
      'remote_report.pdf',
      'inbound_token_456',
      0
    );
    assert.ok(inbound.id);
    assert.equal(inbound.sender_shard_id, 'shard_c0p3x5');

    const list = await db.getInboundFederatedShares(userB.id);
    const match = list.find(s => s.id === inbound.id);
    assert.ok(match);
    assert.equal(match.sender_handle, 'alice@shard_c0p3x5');
  });

  test('preserves federated share links on file/folder move (#31)', async () => {
    const fedShare = await db.createFederatedShare(
      userA.id,
      'shard_b8rk3f',
      'charlie@shard_b8rk3f',
      '/FedFolder/data.csv',
      0,
      0,
      'fed_token_move_789'
    );

    await db.updateSharePathsOnMove(userA.id, '/FedFolder', '/Moved/FedFolder');

    const ownerShares = await db.getFederatedSharesByOwner(userA.id);
    const match = ownerShares.find(s => s.id === fedShare.id);
    assert.ok(match);
    assert.equal(match.file_path, '/Moved/FedFolder/data.csv');
  });

  test('revokes a cross-shard federated share (#31)', async () => {
    const fedShare = await db.createFederatedShare(
      userA.id,
      'shard_b8rk3f',
      'charlie@shard_b8rk3f',
      '/Temp/fed_note.txt',
      0,
      0,
      'fed_token_revoke_000'
    );

    const deleted = await db.deleteFederatedShare(fedShare.id, userA.id);
    assert.equal(deleted, true);

    const ownerShares = await db.getFederatedSharesByOwner(userA.id);
    const match = ownerShares.find(s => s.id === fedShare.id);
    assert.equal(match, undefined);
  });

  describe('Federated Sharing HTTP API Endpoints (#31)', () => {
    let server;
    let baseUrl;

    before(async () => {
      const express = require('express');
      const sharingRouter = require('../routes/sharing');
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.session = { userId: userA.id };
        req.userId = userA.id;
        next();
      });
      app.use('/api/shares', sharingRouter);
      await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      });
    });

    after(async () => {
      if (server) {
        await new Promise(resolve => server.close(resolve));
      }
    });

    test('POST /api/shares/federated creates outbound cross-shard share', async () => {
      const res = await fetch(`${baseUrl}/api/shares/federated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_shard_id: 'shard_xyz',
          sharee_handle: 'dave@shard_xyz',
          file_path: '/Docs/FederatedDoc.pdf',
          read_write: 1
        })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.share.target_shard_id, 'shard_xyz');
      assert.equal(data.share.sharee_handle, 'dave@shard_xyz');
      assert.ok(data.share.federated_token);
    });

    test('POST /api/shares/internal delegates to federated share when username contains @', async () => {
      const res = await fetch(`${baseUrl}/api/shares/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sharee_username: 'eve@peer_shard_99',
          file_path: '/Shared/Archive.zip'
        })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.is_federated, true);
      assert.equal(data.share.target_shard_id, 'peer_shard_99');
    });

    test('POST /api/shares/federated/receive receives inbound share from peer shard', async () => {
      const res = await fetch(`${baseUrl}/api/shares/federated/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_user_id: userB.id,
          sender_shard_id: 'shard_origin_1',
          sender_handle: 'mallory@shard_origin_1',
          file_name: 'peer_data.json',
          federated_token: 'inbound_http_token_111'
        })
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.share.sender_shard_id, 'shard_origin_1');
    });

    test('GET /api/shares/federated/my-shares lists outbound and inbound shares', async () => {
      const res = await fetch(`${baseUrl}/api/shares/federated/my-shares`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.outbound));
      assert.ok(Array.isArray(data.inbound));
      assert.ok(data.outbound.length >= 1);
    });

    test('GET /api/shares/federated/access/:token retrieves share metadata', async () => {
      // Create a share to access
      const createRes = await fetch(`${baseUrl}/api/shares/federated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_shard_id: 'shard_access',
          sharee_handle: 'user@shard_access',
          file_path: '/Public/PublicNote.txt'
        })
      });
      const createData = await createRes.json();
      const token = createData.share.federated_token;

      const accessRes = await fetch(`${baseUrl}/api/shares/federated/access/${token}`);
      assert.equal(accessRes.status, 200);
      const accessData = await accessRes.json();
      assert.equal(accessData.success, true);
      assert.equal(accessData.share.file_path, '/Public/PublicNote.txt');
    });

    test('DELETE /api/shares/federated/:id revokes outbound share', async () => {
      const createRes = await fetch(`${baseUrl}/api/shares/federated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_shard_id: 'shard_del',
          sharee_handle: 'del@shard_del',
          file_path: '/Temp/to_delete.txt'
        })
      });
      const createData = await createRes.json();
      const shareId = createData.share.id;

      const delRes = await fetch(`${baseUrl}/api/shares/federated/${shareId}`, {
        method: 'DELETE'
      });
      assert.equal(delRes.status, 200);
      const delData = await delRes.json();
      assert.equal(delData.success, true);
    });

    test('GET /api/shares/users/search returns user autocomplete results (#51)', async () => {
      const res = await fetch(`${baseUrl}/api/shares/users/search?q=bo`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.users));
      const match = data.users.find(u => u.username === 'bob');
      assert.ok(match, 'must find user bob when searching for "bo"');
      assert.equal(match.display_name, 'Bob');
      assert.equal(data.users.some(u => u.id === userA.id), false, 'must exclude searching user');
    });
  });

  test('db.searchUsers finds users by username or display_name (#51)', async () => {
    const results = await db.searchUsers('ob', userA.id);
    assert.ok(Array.isArray(results));
    const match = results.find(u => u.username === 'bob');
    assert.ok(match);
    assert.equal(match.username, 'bob');
  });
});


