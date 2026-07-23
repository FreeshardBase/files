const path = require('path');
const fs = require('fs/promises');
const { lstatSync } = require('fs');

/**
 * Validates and resolves a requested relative path against the user's home root.
 * Guarantees that the resolved path never escapes userRoot.
 * 
 * @param {string} userRoot - Absolute path to the user's root directory
 * @param {string} requestedPath - Requested path (relative or with leading slashes)
 * @returns {string} Absolute resolved path strictly inside userRoot
 * @throws {Error} If path traversal or illegal characters/symlinks are detected
 */
function safePath(userRoot, requestedPath) {
  if (!userRoot || typeof userRoot !== 'string') {
    throw new Error('userRoot must be a valid absolute directory string');
  }

  const normalizedUserRoot = path.resolve(userRoot);

  if (typeof requestedPath !== 'string') {
    throw new Error('Invalid path parameter: must be a string');
  }

  // 1. Check for null bytes / control chars (%00)
  if (requestedPath.includes('\0') || requestedPath.includes('%00')) {
    throw new Error('Path traversal blocked: null byte detected');
  }

  // 2. Iteratively decode URI components to unwrap double/nested encoding (%252f -> %2f -> /)
  let decoded = requestedPath;
  let prevDecoded = '';
  let maxDecodePasses = 3;
  while (decoded !== prevDecoded && maxDecodePasses > 0) {
    prevDecoded = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch (e) {
      break;
    }
    maxDecodePasses--;
  }

  // 3. Normalize slashes (convert backslashes to forward slashes)
  let sanitized = decoded.replace(/\\/g, '/');

  // Reject suspicious multi-dot sequences like "...." used to confuse path parsers
  if (/\b\.{3,}\b|\/\.{3,}\//.test(sanitized)) {
    throw new Error('Path traversal blocked: path escapes user root directory');
  }

  sanitized = sanitized.replace(/^[\/\\]+/, '');

  // 4. Resolve path against userRoot
  const resolved = path.resolve(normalizedUserRoot, sanitized);

  // 5. Strict boundary check: resolved path MUST start with normalizedUserRoot
  if (resolved !== normalizedUserRoot && !resolved.startsWith(normalizedUserRoot + path.sep)) {
    throw new Error('Path traversal blocked: path escapes user root directory');
  }

  // 6. Symlink check (if path exists): reject symlinks pointing outside userRoot
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      const realTarget = path.resolve(normalizedUserRoot, sanitized);
      if (!realTarget.startsWith(normalizedUserRoot)) {
        throw new Error('Path traversal blocked: symlink escapes user root directory');
      }
    }
  } catch (err) {
    // Path might not exist yet (e.g. for new file writes/mkdir)
    if (err.code !== 'ENOENT') throw err;
  }

  return resolved;
}

/**
 * Formats an absolute path inside userRoot into a clean, relative path string starting with '/'
 */
function toRelativePath(userRoot, absolutePath) {
  const normalizedUserRoot = path.resolve(userRoot);
  const normalizedAbsolute = path.resolve(absolutePath);
  if (!normalizedAbsolute.startsWith(normalizedUserRoot)) {
    throw new Error('Absolute path is outside user root');
  }
  const rel = path.relative(normalizedUserRoot, normalizedAbsolute).replace(/\\/g, '/');
  return rel ? '/' + rel : '/';
}

module.exports = {
  safePath,
  toRelativePath
};
