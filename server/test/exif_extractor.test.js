const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const express = require('express');

const db = require('../db');
const filesRouter = require('../routes/files');
const { parseExif, extractExifFromFile } = require('../utils/exif_extractor');

/**
 * Helper to build a minimal valid JPEG buffer with EXIF metadata (TIFF IFD0 & GPS IFD).
 */
function createMockJpegWithExif() {
  const parts = [];

  // 1. JPEG SOI (2 bytes)
  parts.push(Buffer.from([0xFF, 0xD8]));

  // 2. APP1 Marker (2 bytes) + Length placeholder (2 bytes) + Exif header (6 bytes)
  // APP1 payload will start with 'Exif\0\0' followed by TIFF header.
  
  // TIFF Header starts at offset 0 of TIFF buffer:
  // 0..1: 'II' (Little Endian)
  // 2..3: 42 (0x002A)
  // 4..7: IFD0 offset = 8 (0x00000008)
  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write('II', 0, 'ascii');
  tiffHeader.writeUInt16LE(42, 2);
  tiffHeader.writeUInt32LE(8, 4);

  // IFD0: 5 entries
  // Entry size = 12 bytes
  // IFD0 length = 2 + (5 * 12) + 4 (next IFD offset = 0) = 66 bytes.
  // Data offsets start at 8 + 66 = 74 bytes.
  
  const ifd0 = Buffer.alloc(66);
  ifd0.writeUInt16LE(5, 0); // 5 entries

  // Entry 0: Make (0x010F), ASCII (2), count 6, offset 74
  ifd0.writeUInt16LE(0x010F, 2);
  ifd0.writeUInt16LE(2, 4);
  ifd0.writeUInt32LE(6, 6);
  ifd0.writeUInt32LE(74, 10);

  // Entry 1: Model (0x0110), ASCII (2), count 13, offset 80
  ifd0.writeUInt16LE(0x0110, 14);
  ifd0.writeUInt16LE(2, 16);
  ifd0.writeUInt32LE(13, 18);
  ifd0.writeUInt32LE(80, 22);

  // Entry 2: DateTime (0x0132), ASCII (2), count 20, offset 94
  ifd0.writeUInt16LE(0x0132, 26);
  ifd0.writeUInt16LE(2, 28);
  ifd0.writeUInt32LE(20, 30);
  ifd0.writeUInt32LE(94, 34);

  // Entry 3: Exif IFD Pointer (0x8769), LONG (4), count 1, value 0 (none)
  ifd0.writeUInt16LE(0x8769, 38);
  ifd0.writeUInt16LE(4, 40);
  ifd0.writeUInt32LE(1, 42);
  ifd0.writeUInt32LE(0, 46);

  // Entry 4: GPS IFD Pointer (0x8825), LONG (4), count 1, value offset 114
  ifd0.writeUInt16LE(0x8825, 50);
  ifd0.writeUInt16LE(4, 52);
  ifd0.writeUInt32LE(1, 54);
  ifd0.writeUInt32LE(114, 58);

  // Next IFD offset = 0
  ifd0.writeUInt32LE(0, 62);

  // Data section (at offset 74):
  // 74..79: "Canon\0" (6 bytes)
  // 80..92: "EOS Rebel T7\0" (13 bytes)
  // 93: padding 1 byte -> 94
  // 94..113: "2026:07:29 12:00:00\0" (20 bytes)
  const stringData = Buffer.alloc(40);
  stringData.write('Canon\0', 0, 'ascii');
  stringData.write('EOS Rebel T7\0', 6, 'ascii');
  stringData.write('2026:07:29 12:00:00\0', 20, 'ascii');

  // GPS IFD (at offset 114):
  // 4 entries: GPSLatitudeRef (0x0001), GPSLatitude (0x0002), GPSLongitudeRef (0x0003), GPSLongitude (0x0004)
  // Length = 2 + (4 * 12) + 4 = 54 bytes (114..167)
  const gpsIfd = Buffer.alloc(54);
  gpsIfd.writeUInt16LE(4, 0);

  // Entry 0: GPSLatitudeRef (0x0001), ASCII (2), count 2, value 'N\0' inline
  gpsIfd.writeUInt16LE(0x0001, 2);
  gpsIfd.writeUInt16LE(2, 4);
  gpsIfd.writeUInt32LE(2, 6);
  gpsIfd.write('N\0', 10, 'ascii');

  // Entry 1: GPSLatitude (0x0002), RATIONAL (5), count 3, offset 168
  gpsIfd.writeUInt16LE(0x0002, 14);
  gpsIfd.writeUInt16LE(5, 16);
  gpsIfd.writeUInt32LE(3, 18);
  gpsIfd.writeUInt32LE(168, 22);

  // Entry 2: GPSLongitudeRef (0x0003), ASCII (2), count 2, value 'W\0' inline
  gpsIfd.writeUInt16LE(0x0003, 26);
  gpsIfd.writeUInt16LE(2, 28);
  gpsIfd.writeUInt32LE(2, 30);
  gpsIfd.write('W\0', 34, 'ascii');

  // Entry 3: GPSLongitude (0x0004), RATIONAL (5), count 3, offset 192
  gpsIfd.writeUInt16LE(0x0004, 38);
  gpsIfd.writeUInt16LE(5, 40);
  gpsIfd.writeUInt32LE(3, 42);
  gpsIfd.writeUInt32LE(192, 46);

  gpsIfd.writeUInt32LE(0, 50);

  // GPS Rationals data (at offset 168):
  // Latitude: 37/1 deg, 46/1 min, 30/1 sec (37.775)
  // Longitude: 122/1 deg, 25/1 min, 10/1 sec (122.419444)
  const gpsRationals = Buffer.alloc(48);
  // Lat deg
  gpsRationals.writeUInt32LE(37, 0); gpsRationals.writeUInt32LE(1, 4);
  // Lat min
  gpsRationals.writeUInt32LE(46, 8); gpsRationals.writeUInt32LE(1, 12);
  // Lat sec
  gpsRationals.writeUInt32LE(30, 16); gpsRationals.writeUInt32LE(1, 20);
  // Lon deg
  gpsRationals.writeUInt32LE(122, 24); gpsRationals.writeUInt32LE(1, 28);
  // Lon min
  gpsRationals.writeUInt32LE(25, 32); gpsRationals.writeUInt32LE(1, 36);
  // Lon sec
  gpsRationals.writeUInt32LE(10, 40); gpsRationals.writeUInt32LE(1, 44);

  const tiffBuffer = Buffer.concat([tiffHeader, ifd0, stringData, gpsIfd, gpsRationals]);

  // APP1 payload: 'Exif\0\0' (6 bytes) + tiffBuffer
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiffBuffer]);

  const app1Marker = Buffer.alloc(4);
  app1Marker[0] = 0xFF;
  app1Marker[1] = 0xE1;
  app1Marker.writeUInt16BE(app1Payload.length + 2, 2);

  // EOI marker
  const eoi = Buffer.from([0xFF, 0xD9]);

  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1Marker, app1Payload, eoi]);
}

describe('Automated Photo Metadata & EXIF Geolocation Extractor (#96)', () => {
  let app;
  let server;
  let serverUrl;
  let dataDir;
  let userId = 'test-user-exif';
  let userHome;

  before(async () => {
    dataDir = path.join(__dirname, 'data_exif_test');
    process.env.DATA_DIR = dataDir;
    process.env.FILES_ROOT = path.join(dataDir, 'users');
    process.env.DATABASE_PATH = path.join(dataDir, 'test_exif.db');
    await fs.mkdir(dataDir, { recursive: true });

    await db.initDb();
    await db.upsertUser(userId, 'exifuser', 'exifuser@freeshard.local');

    userHome = path.join(dataDir, 'users', userId);
    const picturesDir = path.join(userHome, 'Pictures');
    await fs.mkdir(picturesDir, { recursive: true });

    // Write a sample JPEG with EXIF to user's Pictures folder
    const mockJpeg = createMockJpegWithExif();
    await fs.writeFile(path.join(picturesDir, 'sample_photo.jpg'), mockJpeg);

    // Write a plain text file without EXIF
    await fs.writeFile(path.join(picturesDir, 'notes.txt'), 'Plain text file content');

    app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      req.session = { user: { id: userId, username: 'exifuser' } };
      req.userId = userId;
      req.userRoot = userHome;
      next();
    });

    app.use('/api/files/local', filesRouter);
    app.use('/api/files', filesRouter);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) server.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Unit: parseExif correctly extracts camera model, date, latitude, and longitude from JPEG buffer', () => {
    const jpegBuf = createMockJpegWithExif();
    const result = parseExif(jpegBuf);

    assert.equal(result.has_exif, true);
    assert.equal(result.make, 'Canon');
    assert.equal(result.model, 'EOS Rebel T7');
    assert.equal(result.date, '2026:07:29 12:00:00');
    assert.equal(result.latitude, 37.775);
    assert.equal(result.longitude, -122.419444);
  });

  test('Unit: parseExif returns empty metadata for non-image or invalid buffer', () => {
    const invalidBuf = Buffer.from('Not an image file at all');
    const result = parseExif(invalidBuf);

    assert.equal(result.has_exif, false);
    assert.equal(result.make, null);
    assert.equal(result.model, null);
    assert.equal(result.latitude, null);
    assert.equal(result.longitude, null);
  });

  test('API: GET /api/files/metadata/exif returns extracted metadata for photo', async () => {
    const res = await fetch(`${serverUrl}/api/files/metadata/exif?path=/Pictures/sample_photo.jpg`);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.path, '/Pictures/sample_photo.jpg');
    assert.equal(json.metadata.has_exif, true);
    assert.equal(json.metadata.make, 'Canon');
    assert.equal(json.metadata.model, 'EOS Rebel T7');
    assert.equal(json.metadata.date, '2026:07:29 12:00:00');
    assert.equal(json.metadata.latitude, 37.775);
    assert.equal(json.metadata.longitude, -122.419444);
  });

  test('API: GET /api/files/metadata/exif handles file without EXIF', async () => {
    const res = await fetch(`${serverUrl}/api/files/metadata/exif?path=/Pictures/notes.txt`);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.metadata.has_exif, false);
    assert.equal(json.metadata.model, null);
  });

  test('API: GET /api/files/metadata/exif returns 400 when path parameter is missing', async () => {
    const res = await fetch(`${serverUrl}/api/files/metadata/exif`);
    assert.equal(res.status, 400);

    const json = await res.json();
    assert.equal(json.error, 'path parameter is required');
  });

  test('API: GET /api/files/metadata/exif returns 403 on path traversal attempt', async () => {
    const res = await fetch(`${serverUrl}/api/files/metadata/exif?path=../../etc/passwd`);
    assert.equal(res.status, 403);
  });
});
