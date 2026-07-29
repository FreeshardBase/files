const fs = require('fs/promises');

/**
 * Parses EXIF metadata from image buffers (JPEG/PNG).
 * @param {Buffer} buffer 
 * @returns {{ make: string|null, model: string|null, date: string|null, latitude: number|null, longitude: number|null, has_exif: boolean }}
 */
function parseExif(buffer) {
  const result = {
    make: null,
    model: null,
    date: null,
    latitude: null,
    longitude: null,
    has_exif: false
  };

  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return result;
  }

  // Check JPEG format (0xFF 0xD8)
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    return parseJpegExif(buffer, result);
  }

  // Check PNG format (0x89 PNG)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return parsePngExif(buffer, result);
  }

  return result;
}

function parseJpegExif(buffer, result) {
  let offset = 2;
  while (offset < buffer.length - 4) {
    if (buffer[offset] !== 0xFF) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];

    // SOS (0xDA) or EOI (0xD9) terminates header scanning
    if (marker === 0xDA || marker === 0xD9) break;

    // Check APP1 marker (0xE1)
    if (marker === 0xE1) {
      const length = buffer.readUInt16BE(offset + 2);
      if (offset + 4 + 6 <= buffer.length) {
        const exifHeader = buffer.toString('ascii', offset + 4, offset + 8);
        if (exifHeader === 'Exif') {
          result.has_exif = true;
          // TIFF header starts 6 bytes after Exif\0\0 header (offset + 10)
          const tiffBuffer = buffer.subarray(offset + 10, offset + 2 + length);
          parseTiff(tiffBuffer, result);
          break;
        }
      }
      offset += 2 + length;
    } else {
      if ((marker >= 0xE0 && marker <= 0xEF) || marker === 0xFE || (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xCC)) {
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      } else {
        offset += 2;
      }
    }
  }

  return result;
}

function parsePngExif(buffer, result) {
  let offset = 8;
  while (offset < buffer.length - 8) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataOffset = offset + 8;

    if (dataOffset + length > buffer.length) break;

    if (type === 'eXIf') {
      result.has_exif = true;
      const tiffBuffer = buffer.subarray(dataOffset, dataOffset + length);
      parseTiff(tiffBuffer, result);
      break;
    } else if (type === 'tEXt') {
      const chunkData = buffer.toString('utf8', dataOffset, dataOffset + length);
      const nullIdx = chunkData.indexOf('\0');
      if (nullIdx !== -1) {
        const keyword = chunkData.substring(0, nullIdx).toLowerCase();
        const textVal = chunkData.substring(nullIdx + 1);
        if (keyword === 'date' || keyword === 'creation time') {
          result.date = textVal;
          result.has_exif = true;
        } else if (keyword === 'model' || keyword === 'camera') {
          result.model = textVal;
          result.has_exif = true;
        } else if (keyword === 'make') {
          result.make = textVal;
          result.has_exif = true;
        }
      }
    }

    offset += 12 + length;
  }

  return result;
}

function parseTiff(buf, result) {
  if (!buf || buf.length < 8) return;

  const endianStr = buf.toString('ascii', 0, 2);
  let isLE = false;
  if (endianStr === 'II') {
    isLE = true;
  } else if (endianStr === 'MM') {
    isLE = false;
  } else {
    return;
  }

  const readU16 = (pos) => (isLE ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos));
  const readU32 = (pos) => (isLE ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos));

  const magic = readU16(2);
  if (magic !== 42) return;

  const ifd0Offset = readU32(4);
  let exifIfdOffset = null;
  let gpsIfdOffset = null;

  function parseIFD(offset, tagCallback) {
    if (offset <= 0 || offset + 2 > buf.length) return;
    const numEntries = readU16(offset);
    let entryOffset = offset + 2;

    for (let i = 0; i < numEntries; i++) {
      if (entryOffset + 12 > buf.length) break;
      const tag = readU16(entryOffset);
      const type = readU16(entryOffset + 2);
      const count = readU32(entryOffset + 4);
      const valOrOffset = entryOffset + 8;

      tagCallback(tag, type, count, valOrOffset);
      entryOffset += 12;
    }
  }

  function readString(type, count, valOrOffset) {
    if (type !== 2) return null;
    let dataPos = valOrOffset;
    if (count > 4) {
      dataPos = readU32(valOrOffset);
    }
    if (dataPos < 0 || dataPos + count > buf.length) return null;
    const raw = buf.toString('ascii', dataPos, dataPos + count);
    return raw.replace(/\0+$/, '').trim();
  }

  function readRationals(count, valOrOffset) {
    let dataPos = valOrOffset;
    if (count * 8 > 4) {
      dataPos = readU32(valOrOffset);
    }
    const arr = [];
    for (let i = 0; i < count; i++) {
      const pos = dataPos + i * 8;
      if (pos + 8 > buf.length) break;
      const num = readU32(pos);
      const den = readU32(pos + 4);
      arr.push(den === 0 ? 0 : num / den);
    }
    return arr;
  }

  // Parse IFD0
  parseIFD(ifd0Offset, (tag, type, count, valOrOffset) => {
    if (tag === 0x010F) { // Make
      result.make = readString(type, count, valOrOffset);
    } else if (tag === 0x0110) { // Model
      result.model = readString(type, count, valOrOffset);
    } else if (tag === 0x0132) { // DateTime
      result.date = readString(type, count, valOrOffset);
    } else if (tag === 0x8769) { // Exif IFD Pointer
      exifIfdOffset = readU32(valOrOffset);
    } else if (tag === 0x8825) { // GPS IFD Pointer
      gpsIfdOffset = readU32(valOrOffset);
    }
  });

  // Parse Exif IFD
  if (exifIfdOffset) {
    parseIFD(exifIfdOffset, (tag, type, count, valOrOffset) => {
      if ((tag === 0x9003 || tag === 0x9004) && !result.date) {
        result.date = readString(type, count, valOrOffset);
      }
    });
  }

  // Parse GPS IFD
  if (gpsIfdOffset) {
    let latRef = 'N';
    let latRats = null;
    let lonRef = 'E';
    let lonRats = null;

    parseIFD(gpsIfdOffset, (tag, type, count, valOrOffset) => {
      if (tag === 0x0001) { // GPSLatitudeRef
        latRef = buf.toString('ascii', valOrOffset, valOrOffset + 1);
      } else if (tag === 0x0002) { // GPSLatitude
        latRats = readRationals(count, valOrOffset);
      } else if (tag === 0x0003) { // GPSLongitudeRef
        lonRef = buf.toString('ascii', valOrOffset, valOrOffset + 1);
      } else if (tag === 0x0004) { // GPSLongitude
        lonRats = readRationals(count, valOrOffset);
      }
    });

    if (latRats && latRats.length >= 3) {
      const deg = latRats[0] + latRats[1] / 60 + latRats[2] / 3600;
      result.latitude = Number((latRef === 'S' ? -deg : deg).toFixed(6));
    }
    if (lonRats && lonRats.length >= 3) {
      const deg = lonRats[0] + lonRats[1] / 60 + lonRats[2] / 3600;
      result.longitude = Number((lonRef === 'W' ? -deg : deg).toFixed(6));
    }
  }
}

async function extractExifFromFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    return parseExif(buffer);
  } catch (err) {
    return {
      make: null,
      model: null,
      date: null,
      latitude: null,
      longitude: null,
      has_exif: false,
      error: err.message
    };
  }
}

module.exports = {
  parseExif,
  extractExifFromFile
};
