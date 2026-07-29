const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validateUserIsolation } = require('../middleware/isolation');
const { compressArchive, extractArchive } = require('../utils/archive_manager');

router.use(requireAuth);
router.use(validateUserIsolation);

/**
 * POST /api/archive/compress
 * Compress specified files/folders into a ZIP, TAR, or GZ archive (#88)
 */
router.post('/compress', async (req, res) => {
  try {
    const { files, outputPath, targetPath, archiveName, format, password } = req.body;
    const finalFiles = files || req.body.sources || req.body.sourcePaths;
    const finalOutputPath = outputPath || targetPath || archiveName;

    const result = await compressArchive({
      userRoot: req.userRoot,
      files: finalFiles,
      outputPath: finalOutputPath,
      format,
      password
    });

    res.json({
      success: true,
      message: 'Archive compressed successfully',
      ...result
    });
  } catch (err) {
    let status = err.statusCode || 500;
    if (err.message && err.message.includes('Path traversal blocked')) {
      status = 403;
    }
    res.status(status).json({
      success: false,
      error: err.message || 'Failed to compress archive',
      code: err.code || 'COMPRESS_FAILED'
    });
  }
});

/**
 * POST /api/archive/extract
 * Extract a ZIP, TAR, or GZ archive into a target directory (#88)
 */
router.post('/extract', async (req, res) => {
  try {
    const { archivePath, src, source, targetDir, destination, targetPath, password } = req.body;
    const finalArchivePath = archivePath || src || source;
    const finalTargetDir = targetDir || destination || targetPath || '/';

    const result = await extractArchive({
      userRoot: req.userRoot,
      archivePath: finalArchivePath,
      targetDir: finalTargetDir,
      password
    });

    res.json({
      success: true,
      message: 'Archive extracted successfully',
      ...result
    });
  } catch (err) {
    let status = err.statusCode || 500;
    if (err.message && err.message.includes('Path traversal blocked')) {
      status = 403;
    }
    res.status(status).json({
      success: false,
      error: err.message || 'Failed to extract archive',
      code: err.code || 'EXTRACT_FAILED'
    });
  }
});

module.exports = router;
