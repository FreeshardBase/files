const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('../db');

/**
 * Calculates SHA-256 (or given algorithm) checksum for a file on disk.
 */
async function calculateFileHash(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash(algorithm);
      const stream = fsSync.createReadStream(filePath);
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Registers (or updates) a file's SHA-256 checksum in the SQLite database.
 */
async function registerFileChecksum(filePath, algorithm = 'sha256') {
  const stat = await fs.stat(filePath);
  const checksum = await calculateFileHash(filePath, algorithm);
  const record = await db.saveFileChecksum(filePath, checksum, stat.size, algorithm);
  return {
    filePath,
    checksum,
    fileSize: stat.size,
    status: record ? record.status : 'ok'
  };
}

/**
 * Verifies a single file's checksum on disk against the registered DB hash.
 * Detects bit-rot (silent data corruption) or missing files.
 */
async function verifyFileIntegrity(filePath) {
  const record = await db.getFileChecksum(filePath);
  if (!record) {
    return {
      filePath,
      status: 'untracked',
      error: 'File is not tracked in checksum database'
    };
  }

  const fileExists = fsSync.existsSync(filePath);
  if (!fileExists) {
    await db.updateChecksumStatus(filePath, 'missing');
    return {
      filePath,
      status: 'missing',
      expectedHash: record.checksum,
      actualHash: null,
      error: 'File missing on disk'
    };
  }

  try {
    const currentHash = await calculateFileHash(filePath, record.algorithm || 'sha256');
    if (currentHash === record.checksum) {
      await db.updateChecksumStatus(filePath, 'ok');
      return {
        filePath,
        status: 'ok',
        checksum: currentHash
      };
    } else {
      await db.updateChecksumStatus(filePath, 'corrupted');
      return {
        filePath,
        status: 'corrupted',
        expectedHash: record.checksum,
        actualHash: currentHash,
        error: `Bit-rot detected: SHA-256 hash mismatch (expected ${record.checksum}, got ${currentHash})`
      };
    }
  } catch (err) {
    await db.updateChecksumStatus(filePath, 'error');
    return {
      filePath,
      status: 'error',
      expectedHash: record.checksum,
      actualHash: null,
      error: err.message
    };
  }
}

/**
 * Recursively scans directory or all tracked files to verify integrity.
 */
async function runIntegrityScan(targetDir = null) {
  const allTracked = await db.getAllChecksums();
  let filesToScan = allTracked;

  if (targetDir) {
    const normalizedTarget = path.resolve(targetDir);
    filesToScan = allTracked.filter(item => {
      const normalizedItem = path.resolve(item.file_path);
      return normalizedItem.startsWith(normalizedTarget);
    });
  }

  const results = [];
  let okCount = 0;
  const corruptedList = [];
  const missingList = [];

  for (const item of filesToScan) {
    const res = await verifyFileIntegrity(item.file_path);
    results.push(res);
    if (res.status === 'ok') {
      okCount++;
    } else if (res.status === 'corrupted') {
      corruptedList.push(item);
    } else if (res.status === 'missing') {
      missingList.push(item);
    }
  }

  return {
    total: filesToScan.length,
    ok: okCount,
    corrupted: corruptedList,
    missing: missingList,
    details: results
  };
}

/**
 * Returns all currently logged corrupted files from database.
 */
async function getCorruptedFiles() {
  return db.getCorruptedFiles();
}

/**
 * Express router for Bit-Rot Scanner & File Integrity Check API.
 */
const bitrotScannerRouter = express.Router();

bitrotScannerRouter.post('/register', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }
    const record = await registerFileChecksum(filePath);
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

bitrotScannerRouter.post('/verify', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }
    const result = await verifyFileIntegrity(filePath);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

bitrotScannerRouter.post('/scan', async (req, res) => {
  try {
    const { targetDir } = req.body || {};
    const report = await runIntegrityScan(targetDir);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

bitrotScannerRouter.get('/corrupted', async (req, res) => {
  try {
    const corruptedFiles = await getCorruptedFiles();
    res.json({ success: true, corruptedFiles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = {
  calculateFileHash,
  registerFileChecksum,
  verifyFileIntegrity,
  runIntegrityScan,
  getCorruptedFiles,
  bitrotScannerRouter
};
