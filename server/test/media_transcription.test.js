/**
 * Tests for Issue #89 — Multi-Language OCR Subtitle & Audio Transcription Extractor
 *
 * Verifies:
 *   1. POST /api/media/transcribe processes audio files and returns VTT + transcript
 *   2. Returned VTT string starts with WEBVTT header
 *   3. Language parameter is respected in response
 *   4. Unsupported file format returns 400
 *   5. Missing or non-existent file returns appropriate error
 *   6. Path traversal is blocked (403)
 *   7. Unauthenticated request returns 401
 *   8. Transcription is persisted and retrievable via DB helpers
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('path');
const fs      = require('fs/promises');
const http    = require('http');
const express = require('express');

const db          = require('../db');
const mediaRouter = require('../routes/media');

describe('Media Transcription Extractor (#89)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userRoot;
  const userId = 'user-media-transcription-1';

  before(async () => {
    dataDir  = path.join(__dirname, 'data_media_transcription_test');
    process.env.DATA_DIR      = dataDir;
    process.env.FILES_ROOT    = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_media_transcription.db');
    userRoot = path.join(process.env.FILES_ROOT, userId);
    await fs.mkdir(userRoot, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'mediauser', 'media@freeshard.local');

    // Create a synthetic "audio" file — the utility reads bytes, not actual audio format
    const fakeMp3 = Buffer.from('ID3' + 'A'.repeat(2048)); // ~2 KB pseudo-MP3
    await fs.writeFile(path.join(userRoot, 'sample.mp3'), fakeMp3);

    const fakeWav = Buffer.from('RIFF' + 'B'.repeat(4096)); // ~4 KB pseudo-WAV
    await fs.writeFile(path.join(userRoot, 'sample.wav'), fakeWav);

    // Express app setup mirroring the production pattern used in other tests
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use((req, res, next) => {
      const authHeader = req.headers['x-test-user'];
      if (authHeader === 'none') {
        req.session = {};
        return next();
      }
      const activeUser = authHeader || userId;
      req.session  = { userId: activeUser, user: { id: activeUser } };
      req.userId   = activeUser;
      req.userRoot = path.join(dataDir, 'users', activeUser);
      next();
    });

    app.use('/api/media', mediaRouter);

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.closeDb();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Test 1: basic happy path ─────────────────────────────────────────────
  test('POST /api/media/transcribe returns VTT and transcript for a valid audio file', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.mp3' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(typeof data.vtt === 'string', 'vtt field should be a string');
    assert.ok(typeof data.transcript === 'string', 'transcript field should be a string');
    assert.ok(data.vtt.startsWith('WEBVTT'), 'VTT should start with WEBVTT header');
    assert.ok(data.transcript.length > 0, 'transcript should be non-empty');
    assert.ok(typeof data.duration === 'number', 'duration should be a number');
    assert.ok(data.duration > 0, 'duration should be positive');
  });

  // ── Test 2: VTT format correctness ──────────────────────────────────────
  test('Returned VTT contains timestamp cues in HH:MM:SS.mmm --> HH:MM:SS.mmm format', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.wav' })
    });
    assert.equal(res.status, 200);
    const { vtt } = await res.json();
    // VTT cue timestamps match  HH:MM:SS.mmm --> HH:MM:SS.mmm
    assert.match(vtt, /\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  // ── Test 3: language parameter is respected ──────────────────────────────
  test('POST /api/media/transcribe respects the language parameter', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.mp3', language: 'de' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.language, 'de');
  });

  // ── Test 4: unsupported format returns 400 ───────────────────────────────
  test('POST /api/media/transcribe returns 400 for unsupported file format', async () => {
    // Create a .txt file (not audio/video)
    await fs.writeFile(path.join(userRoot, 'notes.txt'), 'plain text', 'utf8');

    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'notes.txt' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error, 'error message should be present');
  });

  // ── Test 5: missing filePath returns 400 ────────────────────────────────
  test('POST /api/media/transcribe returns 400 when filePath is missing', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({})
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // ── Test 6: non-existent file returns 404 ───────────────────────────────
  test('POST /api/media/transcribe returns 404 for a non-existent file', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'ghost.mp3' })
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // ── Test 7: path traversal is blocked ───────────────────────────────────
  test('POST /api/media/transcribe blocks path traversal', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: '../../etc/passwd.mp3' })
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  // ── Test 8: unauthenticated request returns 401 ──────────────────────────
  test('Unauthenticated request returns 401', async () => {
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user':  'none'
      },
      body: JSON.stringify({ filePath: 'sample.mp3' })
    });
    assert.equal(res.status, 401);
  });

  // ── Test 9: DB persistence ───────────────────────────────────────────────
  test('Transcription is persisted to DB and retrievable', async () => {
    // Trigger transcription
    const res = await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.wav', language: 'fr' })
    });
    assert.equal(res.status, 200);

    // Retrieve from DB
    const record = await db.getTranscriptionByFile(userId, 'sample.wav');
    assert.ok(record, 'DB record should exist');
    assert.equal(record.user_id, userId);
    assert.equal(record.language, 'fr');
    assert.ok(record.vtt.startsWith('WEBVTT'));
    assert.ok(record.transcript.length > 0);
  });

  // ── Test 10: idempotent re-transcription upserts the record ─────────────
  test('Re-transcribing the same file upserts the DB record', async () => {
    // First call
    await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.mp3', language: 'en' })
    });
    // Second call with different language
    await fetch(`${serverUrl}/api/media/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filePath: 'sample.mp3', language: 'es' })
    });

    const rows = await db.getTranscriptionsByUser(userId);
    const mp3Records = rows.filter(r => r.file_path === 'sample.mp3');
    // Should be exactly one record (upserted, not duplicated)
    assert.equal(mp3Records.length, 1);
    assert.equal(mp3Records[0].language, 'es');
  });
});
