const fs = require('fs/promises');
const { createReadStream, createWriteStream, lstatSync, existsSync } = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const mime = require('mime-types');
const crypto = require('crypto');
const BaseProvider = require('./base');
const { safePath, toRelativePath } = require('../utils/safepath');

class LocalProvider extends BaseProvider {
  /**
   * @param {{ userRoot: string }} config 
   */
  constructor(config) {
    super(config);
    if (!config || !config.userRoot) {
      throw new Error('LocalProvider requires config.userRoot');
    }
    this.userRoot = path.resolve(config.userRoot);
  }

  async ensureUserHome() {
    await fs.mkdir(this.userRoot, { recursive: true });
    await fs.mkdir(path.join(this.userRoot, 'Documents'), { recursive: true });
    await fs.mkdir(path.join(this.userRoot, 'Pictures'), { recursive: true });
  }

  /**
   * Resolve safe path relative to userRoot
   */
  _resolve(relativePath) {
    return safePath(this.userRoot, relativePath || '/');
  }

  async list(dirPath = '/') {
    const fullPath = this._resolve(dirPath);
    const stat = await fs.lstat(fullPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path '${dirPath}' is not a directory`);
    }

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      // Hide dotfiles by default (.trash, .versions, etc.)
      if (entry.name.startsWith('.')) continue;

      const entryFullPath = path.join(fullPath, entry.name);
      try {
        const entryStat = await fs.lstat(entryFullPath);
        const relPath = toRelativePath(this.userRoot, entryFullPath);
        const isDir = entryStat.isDirectory();

        result.push({
          name: entry.name,
          path: relPath,
          isDirectory: isDir,
          size: isDir ? 0 : entryStat.size,
          modified: entryStat.mtime ? entryStat.mtime.toISOString() : null,
          mimeType: isDir ? null : (mime.lookup(entry.name) || 'application/octet-stream')
        });
      } catch (err) {
        // Skip unreadable files
      }
    }

    // Sort folders first, then files alphabetically
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  async read(filePath) {
    const fullPath = this._resolve(filePath);
    const stat = await fs.lstat(fullPath);
    if (stat.isDirectory()) {
      throw new Error(`Cannot read directory '${filePath}' as a file`);
    }

    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const stream = createReadStream(fullPath);

    return {
      stream,
      size: stat.size,
      mimeType
    };
  }

  /**
   * Atomic write: writes to temporary file (.tmp) then renames to target
   */
  async write(filePath, dataStream, options = {}) {
    const fullPath = this._resolve(filePath);
    const targetDir = path.dirname(fullPath);

    // Ensure target directory exists
    await fs.mkdir(targetDir, { recursive: true });

    // Generate unique temp file path in target directory
    const tempFileName = `.tmp_${crypto.randomBytes(8).toString('hex')}`;
    const tempFilePath = path.join(targetDir, tempFileName);

    try {
      const writeStream = createWriteStream(tempFilePath);
      // Stream pipeline (Risk 5 in Architecture Guide #24)
      await pipeline(dataStream, writeStream);

      // Atomic rename once fully written
      await fs.rename(tempFilePath, fullPath);

      const stat = await fs.lstat(fullPath);
      return {
        path: toRelativePath(this.userRoot, fullPath),
        size: stat.size
      };
    } catch (err) {
      // Clean up temp file on error
      try { await fs.unlink(tempFilePath); } catch {}
      throw err;
    }
  }

  async delete(targetPath) {
    const fullPath = this._resolve(targetPath);
    await fs.rm(fullPath, { recursive: true, force: true });
    return true;
  }

  async move(srcPath, dstPath) {
    const fullSrc = this._resolve(srcPath);
    const fullDst = this._resolve(dstPath);

    await fs.mkdir(path.dirname(fullDst), { recursive: true });
    await fs.rename(fullSrc, fullDst);
    return true;
  }

  async copy(srcPath, dstPath) {
    const fullSrc = this._resolve(srcPath);
    const fullDst = this._resolve(dstPath);

    await fs.mkdir(path.dirname(fullDst), { recursive: true });
    await fs.cp(fullSrc, fullDst, { recursive: true });
    return true;
  }

  async metadata(targetPath) {
    const fullPath = this._resolve(targetPath);
    const stat = await fs.lstat(fullPath);
    const isDir = stat.isDirectory();
    const fileName = path.basename(fullPath);

    return {
      name: fileName,
      path: toRelativePath(this.userRoot, fullPath),
      isDirectory: isDir,
      size: isDir ? 0 : stat.size,
      modified: stat.mtime ? stat.mtime.toISOString() : null,
      mimeType: isDir ? null : (mime.lookup(fileName) || 'application/octet-stream')
    };
  }

  async mkdir(dirPath) {
    const fullPath = this._resolve(dirPath);
    await fs.mkdir(fullPath, { recursive: true });
    return true;
  }

  async search(query, basePath = '/') {
    const fullBasePath = this._resolve(basePath);
    const lowerQuery = query.toLowerCase();
    const results = [];

    async function walk(currentDir, userRoot) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(currentDir, entry.name);
        try {
          const stat = await fs.lstat(entryPath);
          const isDir = stat.isDirectory();
          if (entry.name.toLowerCase().includes(lowerQuery)) {
            results.push({
              name: entry.name,
              path: toRelativePath(userRoot, entryPath),
              isDirectory: isDir,
              size: isDir ? 0 : stat.size,
              modified: stat.mtime ? stat.mtime.toISOString() : null
            });
          }
          if (isDir) {
            await walk(entryPath, userRoot);
          }
        } catch (err) {}
      }
    }

    await walk(fullBasePath, this.userRoot);
    return results;
  }
}

module.exports = LocalProvider;
