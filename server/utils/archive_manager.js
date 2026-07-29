const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { safePath, toRelativePath } = require('./safepath');

/**
 * Determine archive format based on format parameter or file extension
 */
function inferFormat(outputPath, format) {
  if (format) {
    const f = format.toLowerCase();
    if (f === 'tar.gz' || f === 'tgz') return 'tar.gz';
    if (f === 'tar') return 'tar';
    if (f === 'gz') return 'gz';
    if (f === 'zip') return 'zip';
    return f;
  }
  const lower = outputPath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  return 'zip';
}

/**
 * Compress specified relative files inside userRoot into an archive file
 */
async function compressArchive({ userRoot, files, outputPath, format, password }) {
  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error('files array must contain at least one file path');
    err.statusCode = 400;
    throw err;
  }
  if (!outputPath || typeof outputPath !== 'string') {
    const err = new Error('outputPath parameter is required');
    err.statusCode = 400;
    throw err;
  }

  const targetAbs = safePath(userRoot, outputPath);
  await fs.mkdir(path.dirname(targetAbs), { recursive: true });

  const resolvedFiles = [];
  for (const f of files) {
    const abs = safePath(userRoot, f);
    try {
      await fs.stat(abs);
      resolvedFiles.push(path.relative(userRoot, abs));
    } catch (e) {
      const err = new Error(`Source file or directory not found: ${f}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const archiveFormat = inferFormat(outputPath, format);

  if (archiveFormat === 'tar.gz' || archiveFormat === 'tgz') {
    await execFileAsync('tar', ['-czf', targetAbs, ...resolvedFiles], { cwd: userRoot });
  } else if (archiveFormat === 'tar') {
    await execFileAsync('tar', ['-cf', targetAbs, ...resolvedFiles], { cwd: userRoot });
  } else if (archiveFormat === 'gz' && resolvedFiles.length === 1) {
    const srcAbs = path.join(userRoot, resolvedFiles[0]);
    const fileData = await fs.readFile(srcAbs);
    const zlib = require('zlib');
    const gzipAsync = util.promisify(zlib.gzip);
    const gzipped = await gzipAsync(fileData);
    await fs.writeFile(targetAbs, gzipped);
  } else {
    // Default to ZIP (using 7z for password support)
    const passArg = password ? `-p${password}` : '-p""';
    await execFileAsync('7z', ['a', '-tzip', passArg, targetAbs, ...resolvedFiles], { cwd: userRoot });
  }

  const stat = await fs.stat(targetAbs);
  return {
    archivePath: toRelativePath(userRoot, targetAbs),
    size: stat.size,
    format: archiveFormat
  };
}

/**
 * Extract an archive inside userRoot into targetDir
 */
async function extractArchive({ userRoot, archivePath, targetDir = '/', password }) {
  if (!archivePath || typeof archivePath !== 'string') {
    const err = new Error('archivePath parameter is required');
    err.statusCode = 400;
    throw err;
  }

  const archiveAbs = safePath(userRoot, archivePath);
  try {
    await fs.stat(archiveAbs);
  } catch (e) {
    const err = new Error(`Archive file not found: ${archivePath}`);
    err.statusCode = 404;
    throw err;
  }

  const destAbs = safePath(userRoot, targetDir);
  await fs.mkdir(destAbs, { recursive: true });

  const passArg = password ? `-p${password}` : '-p""';

  const lower = archiveAbs.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    try {
      await execFileAsync('tar', ['-xzf', archiveAbs, '-C', destAbs]);
    } catch (e) {
      // Fallback to 7z double extraction if tar fails
      const tmpDir = path.join(destAbs, `.tmp_extract_${Date.now()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      try {
        await execFileAsync('7z', ['x', '-y', passArg, `-o${tmpDir}`, archiveAbs]);
        const entries = await fs.readdir(tmpDir);
        const tarFile = entries.find(n => n.endsWith('.tar'));
        if (tarFile) {
          await execFileAsync('tar', ['-xf', path.join(tmpDir, tarFile), '-C', destAbs]);
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else if (lower.endsWith('.gz') && !lower.endsWith('.tar.gz')) {
    const zlib = require('zlib');
    const gunzipAsync = util.promisify(zlib.gunzip);
    const compressed = await fs.readFile(archiveAbs);
    const decompressed = await gunzipAsync(compressed);
    const outFileName = path.basename(archiveAbs, '.gz');
    await fs.writeFile(path.join(destAbs, outFileName), decompressed);
  } else {
    // Standard ZIP, TAR, 7z extraction using 7z
    try {
      await execFileAsync('7z', ['x', '-y', passArg, `-o${destAbs}`, archiveAbs]);
    } catch (e) {
      const errOutput = (e.stdout || '').toString() + (e.stderr || '').toString();
      if (errOutput.includes('Sub items Errors') || errOutput.includes('Wrong password') || errOutput.includes('Encrypted') || !password) {
        const err = new Error('Password required or incorrect password for protected archive');
        err.statusCode = 400;
        err.code = 'PASSWORD_REQUIRED';
        throw err;
      }
      const err = new Error(`Extraction failed: ${e.message}`);
      err.statusCode = 400;
      throw err;
    }
  }

  return {
    extractedTo: toRelativePath(userRoot, destAbs)
  };
}

module.exports = {
  compressArchive,
  extractArchive
};
