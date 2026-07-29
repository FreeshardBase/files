const express  = require('express');
const router   = express.Router();
const path     = require('path');
const { requireAuth }          = require('../middleware/auth');
const { validateUserIsolation } = require('../middleware/isolation');
const { transcribeMediaFile }  = require('../utils/media_transcription');
const db = require('../db');

router.use(requireAuth);
router.use(validateUserIsolation);

/**
 * POST /api/media/transcribe
 * Body: { filePath: string, language?: string, format?: 'vtt'|'text' }
 *
 * Transcribes an audio/video file owned by the authenticated user.
 * Returns VTT subtitles and a plain-text search transcript.
 *
 * (#89)
 */
router.post('/transcribe', async (req, res) => {
  try {
    const { filePath, language = 'en', format = 'vtt' } = req.body;

    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }

    // Resolve to the user's root to enforce isolation
    const absPath = path.resolve(req.userRoot, filePath.replace(/^\//, ''));

    // Guard against path traversal
    if (!absPath.startsWith(req.userRoot)) {
      return res.status(403).json({ success: false, error: 'Path traversal blocked' });
    }

    const result = await transcribeMediaFile({
      filePath: absPath,
      language,
      format
    });

    // Persist transcription record to DB for later search / retrieval
    await db.saveTranscription({
      userId:     req.userId,
      filePath:   filePath,
      language:   result.language,
      transcript: result.transcript,
      vtt:        result.vtt,
      duration:   result.duration
    });

    return res.json({
      success:    true,
      filePath:   filePath,
      language:   result.language,
      duration:   result.duration,
      vtt:        result.vtt,
      transcript: result.transcript
    });

  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      error:   err.message || 'Transcription failed'
    });
  }
});

module.exports = router;
