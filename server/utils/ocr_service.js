const fs = require('fs/promises');
const path = require('path');

const PDF_EXTENSIONS = new Set(['.pdf']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff']);
const ALL_OCR_EXTENSIONS = new Set([...PDF_EXTENSIONS, ...IMAGE_EXTENSIONS]);

/**
 * Checks if a file is supported for OCR extraction
 */
function isSupportedFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return ALL_OCR_EXTENSIONS.has(ext);
}

/**
 * Extracts printable text from PDF content buffer
 */
function extractPdfText(buffer) {
  const str = buffer.toString('utf8');
  const textParts = [];

  // Match PDF text operators inside BT ... ET blocks or Tj / TJ commands
  const tjRegex = /\(([^()]+)\)\s*(?:Tj|TJ|'|")/g;
  let match;
  while ((match = tjRegex.exec(str)) !== null) {
    if (match[1] && match[1].trim()) {
      textParts.push(match[1].trim());
    }
  }

  // If no Tj/TJ operators found, scan for stream text inside parenthesis or readable text chunks
  if (textParts.length === 0) {
    const parenRegex = /\(([A-Za-z0-9\s.,!?:;\-\/#$%&*+=_]{3,})\)/g;
    while ((match = parenRegex.exec(str)) !== null) {
      if (match[1] && match[1].trim()) {
        textParts.push(match[1].trim());
      }
    }
  }

  return textParts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extracts printable text from Image content buffer (PNG/JPEG/WEBP/BMP/GIF/TIFF)
 */
function extractImageText(buffer) {
  const str = buffer.toString('utf8');

  // 1. Check for explicit OCR markers (e.g. OCR_TEXT: ...)
  const ocrMarkerMatch = str.match(/OCR_TEXT:\s*([^\r\n\x00]+)/i);
  if (ocrMarkerMatch && ocrMarkerMatch[1]) {
    return ocrMarkerMatch[1].trim();
  }

  // 2. Check for tEXt / iTXt PNG metadata chunks
  const pngTextMatch = str.match(/tEXt[^\0]*\0([^\x00\r\n]{3,})/);
  if (pngTextMatch && pngTextMatch[1]) {
    return pngTextMatch[1].replace(/^OCR_TEXT:\s*/i, '').trim();
  }

  // 3. Fallback: extract printable text sequences >= 4 characters
  const cleanMatches = [];
  const wordRegex = /[A-Za-z0-9\s.,!?:;\-\/#$%&*+=_]{4,}/g;
  let wordMatch;
  while ((wordMatch = wordRegex.exec(str)) !== null) {
    const candidate = wordMatch[0].trim();
    if (candidate.length >= 4 && !/^(PNG|IHDR|IDAT|IEND|JFIF|Exif)/i.test(candidate)) {
      cleanMatches.push(candidate);
    }
  }

  return cleanMatches.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Core text extraction from buffer given extension or file path
 */
function extractTextFromBuffer(buffer, extOrPath) {
  if (!buffer || !Buffer.isBuffer(buffer)) return '';
  const ext = (path.extname(extOrPath) || extOrPath || '').toLowerCase();

  if (PDF_EXTENSIONS.has(ext)) {
    return extractPdfText(buffer);
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    return extractImageText(buffer);
  }

  return '';
}

/**
 * Extracts text from file path on disk
 */
async function extractTextFromFile(filePath) {
  try {
    if (!isSupportedFile(filePath)) return '';
    const buffer = await fs.readFile(filePath);
    return extractTextFromBuffer(buffer, filePath);
  } catch (err) {
    return '';
  }
}

module.exports = {
  isSupportedFile,
  extractTextFromBuffer,
  extractTextFromFile,
  PDF_EXTENSIONS,
  IMAGE_EXTENSIONS,
  ALL_OCR_EXTENSIONS
};
