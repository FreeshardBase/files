const express = require('express');
const router = express.Router();
const { handleSSEConnection } = require('../utils/sse_events');
const { validateUserIsolation } = require('../middleware/isolation');

/**
 * GET /api/events/stream
 * Real-time Server-Sent Events stream for instant file system change notifications (#97)
 */
router.get('/stream', validateUserIsolation, (req, res) => {
  handleSSEConnection(req, res);
});

module.exports = router;
