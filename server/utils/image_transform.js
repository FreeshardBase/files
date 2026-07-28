/**
 * Image Transformation Utilities (#73)
 * Handles base64 image data decoding and pure JS BMP buffer operations (Rotate, Flip, Crop).
 */

function parseBase64Image(dataStr) {
  if (!dataStr || typeof dataStr !== 'string') return null;
  const matches = dataStr.match(/^data:([^;]+);base64,(.+)$/s);
  if (matches) {
    return {
      contentType: matches[1].trim(),
      buffer: Buffer.from(matches[2].trim(), 'base64')
    };
  }
  try {
    const buffer = Buffer.from(dataStr, 'base64');
    if (buffer.length > 0) {
      return { contentType: 'application/octet-stream', buffer };
    }
  } catch (e) {}
  return null;
}

function createTestBmp(width, height, rgb = { r: 255, g: 0, b: 0 }) {
  const bpp = 24;
  const bytesPerPixel = 3;
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const pixelArraySize = rowStride * height;
  const dataOffset = 54;
  const fileSize = dataOffset + pixelArraySize;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(dataOffset, 10);

  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y++) {
    const rowOffset = dataOffset + y * rowStride;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + x * bytesPerPixel;
      buf[pxOffset] = rgb.b;
      buf[pxOffset + 1] = rgb.g;
      buf[pxOffset + 2] = rgb.r;
    }
  }
  return buf;
}

function rotateBmp90(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a valid BMP image');
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP bpp: ${bpp}`);

  const bytesPerPixel = bpp / 8;
  const srcDataOffset = buf.readUInt32LE(10);
  const srcRowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;

  const newWidth = height;
  const newHeight = width;
  const dstRowStride = Math.ceil((newWidth * bytesPerPixel) / 4) * 4;
  const dstPixelArraySize = dstRowStride * newHeight;
  const dstFileSize = srcDataOffset + dstPixelArraySize;

  const dst = Buffer.alloc(dstFileSize);
  buf.copy(dst, 0, 0, srcDataOffset);

  dst.writeUInt32LE(dstFileSize, 2);
  dst.writeInt32LE(newWidth, 18);
  dst.writeInt32LE(newHeight, 22);
  dst.writeUInt32LE(dstPixelArraySize, 34);

  for (let srcY = 0; srcY < height; srcY++) {
    const srcRowOffset = srcDataOffset + srcY * srcRowStride;
    for (let srcX = 0; srcX < width; srcX++) {
      const srcPx = srcRowOffset + srcX * bytesPerPixel;
      const dstX = srcY;
      const dstY = width - 1 - srcX;

      const dstPx = srcDataOffset + dstY * dstRowStride + dstX * bytesPerPixel;
      for (let b = 0; b < bytesPerPixel; b++) {
        dst[dstPx + b] = buf[srcPx + b];
      }
    }
  }
  return dst;
}

function flipBmp(buf, direction = 'horizontal') {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a valid BMP image');
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP bpp: ${bpp}`);

  const bytesPerPixel = bpp / 8;
  const srcDataOffset = buf.readUInt32LE(10);
  const rowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;

  const dst = Buffer.alloc(buf.length);
  buf.copy(dst);

  for (let srcY = 0; srcY < height; srcY++) {
    for (let srcX = 0; srcX < width; srcX++) {
      const srcPx = srcDataOffset + srcY * rowStride + srcX * bytesPerPixel;
      let dstX = srcX;
      let dstY = srcY;
      if (direction === 'horizontal' || direction === 'both') {
        dstX = width - 1 - srcX;
      }
      if (direction === 'vertical' || direction === 'both') {
        dstY = height - 1 - srcY;
      }

      const dstPx = srcDataOffset + dstY * rowStride + dstX * bytesPerPixel;
      for (let b = 0; b < bytesPerPixel; b++) {
        dst[dstPx + b] = buf[srcPx + b];
      }
    }
  }
  return dst;
}

function cropBmp(buf, cropX = 0, cropY = 0, cropW, cropH) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('Not a valid BMP image');
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);

  const bytesPerPixel = bpp / 8;
  const srcDataOffset = buf.readUInt32LE(10);
  const srcRowStride = Math.ceil((width * bytesPerPixel) / 4) * 4;

  const x0 = Math.max(0, Math.min(width - 1, cropX));
  const y0 = Math.max(0, Math.min(height - 1, cropY));
  const w = Math.min(width - x0, cropW || (width - x0));
  const h = Math.min(height - y0, cropH || (height - y0));

  const dstRowStride = Math.ceil((w * bytesPerPixel) / 4) * 4;
  const dstPixelArraySize = dstRowStride * h;
  const dstFileSize = srcDataOffset + dstPixelArraySize;

  const dst = Buffer.alloc(dstFileSize);
  buf.copy(dst, 0, 0, srcDataOffset);

  dst.writeUInt32LE(dstFileSize, 2);
  dst.writeInt32LE(w, 18);
  dst.writeInt32LE(h, 22);
  dst.writeUInt32LE(dstPixelArraySize, 34);

  for (let dstY = 0; dstY < h; dstY++) {
    const srcY = height - 1 - (y0 + dstY);
    const targetRowInDst = h - 1 - dstY;
    const dstRowOffset = srcDataOffset + targetRowInDst * dstRowStride;
    const srcRowOffset = srcDataOffset + srcY * srcRowStride;

    for (let dstX = 0; dstX < w; dstX++) {
      const srcX = x0 + dstX;
      const srcPx = srcRowOffset + srcX * bytesPerPixel;
      const dstPx = dstRowOffset + dstX * bytesPerPixel;
      for (let b = 0; b < bytesPerPixel; b++) {
        dst[dstPx + b] = buf[srcPx + b];
      }
    }
  }
  return dst;
}

function transformImageBuffer(inputBuffer, options = {}) {
  const { imageData, operations = [], rotate, flip, crop } = options;

  if (imageData) {
    const parsed = parseBase64Image(imageData);
    if (parsed && parsed.buffer) {
      return parsed.buffer;
    }
  }

  const ops = [...operations];
  if (rotate !== undefined) {
    ops.push({ type: 'rotate', angle: rotate });
  }
  if (flip !== undefined) {
    ops.push({ type: 'flip', direction: flip });
  }
  if (crop !== undefined) {
    ops.push({ type: 'crop', ...crop });
  }

  if (ops.length === 0) {
    return inputBuffer;
  }

  if (inputBuffer && inputBuffer.length >= 54 && inputBuffer.toString('ascii', 0, 2) === 'BM') {
    let current = inputBuffer;
    for (const op of ops) {
      if (op.type === 'rotate') {
        const angle = ((op.angle % 360) + 360) % 360;
        const count = Math.round(angle / 90) % 4;
        for (let i = 0; i < count; i++) {
          current = rotateBmp90(current);
        }
      } else if (op.type === 'flip') {
        current = flipBmp(current, op.direction || op.axis || 'horizontal');
      } else if (op.type === 'crop') {
        current = cropBmp(current, op.x || 0, op.y || 0, op.width || op.w, op.height || op.h);
      }
    }
    return current;
  }

  return inputBuffer;
}

module.exports = {
  parseBase64Image,
  createTestBmp,
  rotateBmp90,
  flipBmp,
  cropBmp,
  transformImageBuffer
};
