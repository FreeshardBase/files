/**
 * Photo Gallery Mode utility (#23)
 *
 * Provides image filtering and gallery metadata assembly for the
 * dedicated image-centric folder view (grid layout + lightbox).
 */

'use strict';

const mime = require('mime-types');

/**
 * Exhaustive set of MIME types treated as gallery-displayable images.
 * Includes all common web formats plus HEIC/AVIF for modern mobile uploads.
 */
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/ico',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * Returns whether a file's MIME type is gallery-displayable.
 * @param {string} filename
 * @returns {boolean}
 */
function isGalleryImage(filename) {
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  return IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Build gallery item list for a directory.
 *
 * Calls provider.list() (which already enforces safePath traversal guards),
 * filters to image-only files, attaches thumbnailUrl, and sorts by name.
 *
 * @param {import('../providers/local')} provider  LocalProvider instance
 * @param {string} dirPath  Virtual path relative to user root (e.g. '/Photos')
 * @returns {Promise<Array<{
 *   name: string,
 *   path: string,
 *   mimeType: string,
 *   size: number,
 *   modified: string,
 *   thumbnailUrl: string
 * }>>}
 */
async function buildGalleryItems(provider, dirPath) {
  // provider.list() internally calls _resolve() → safePath(), so traversal
  // attempts are blocked at this layer (throws 'Path traversal blocked').
  const allItems = await provider.list(dirPath);

  const images = allItems
    .filter(item => !item.isDirectory && isGalleryImage(item.name))
    .map(item => ({
      name:         item.name,
      path:         item.path,
      mimeType:     mime.lookup(item.name) || 'application/octet-stream',
      size:         item.size,
      modified:     item.modified,
      // Thumbnail URL — served via the existing /api/files/read endpoint.
      // The frontend can use this as both the lightbox src and the grid thumb src.
      thumbnailUrl: `/api/files/read?path=${encodeURIComponent(item.path)}`,
    }));

  // Stable alphabetical sort by filename (case-insensitive)
  images.sort((a, b) => a.name.localeCompare(b.name));

  return images;
}

module.exports = { IMAGE_MIME_TYPES, isGalleryImage, buildGalleryItems };
