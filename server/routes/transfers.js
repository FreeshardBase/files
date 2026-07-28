const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs/promises');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const LocalProvider = require('../providers/local');

router.use(requireAuth);

// Map of userId -> Set of SSE Response objects
const sseClients = new Map();
// Set of cancelled transfer IDs in memory for active streaming cancel checks
const activeCancelledIds = new Set();

function broadcastEvent(userId, eventPayload) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;
  const message = `data: ${JSON.stringify(eventPayload)}\n\n`;
  for (const clientRes of clients) {
    try {
      clientRes.write(message);
    } catch (e) {
      // client disconnected
    }
  }
}

function getUserRoot(userId) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'users', userId);
}

/**
 * Server-Sent Events (SSE) progress update channel (#64)
 */
router.get('/events', (req, res) => {
  const userId = req.userId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId).add(res);

  res.write(`: keepalive\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);

  req.on('close', () => {
    const clients = sseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(userId);
      }
    }
  });
});

/**
 * List transfers for authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const transfers = await db.getTransfersByUser(req.userId);
    res.json({ transfers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get transfer details by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const transfer = await db.getTransferById(req.params.id, req.userId);
    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    res.json({ transfer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cancel transfer endpoint (#64)
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const transferId = req.params.id;
    activeCancelledIds.add(transferId);

    const cancelled = await db.cancelTransfer(transferId, req.userId);
    const transfer = await db.getTransferById(transferId, req.userId);

    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }

    broadcastEvent(req.userId, {
      type: 'transfer_cancelled',
      transferId,
      transfer
    });

    res.json({ success: true, transfer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Enqueue new background transfer (#64)
 */
router.post('/', async (req, res) => {
  try {
    const {
      srcProviderType = 'local',
      srcProviderConnectionId = null,
      srcPath,
      dstProviderType = 'local',
      dstProviderConnectionId = null,
      dstPath,
      operation = 'copy',
      isDirectory = 0
    } = req.body;

    if (!srcPath || !dstPath) {
      return res.status(400).json({ error: 'srcPath and dstPath are required' });
    }

    const transferId = `tr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    
    // Estimate size for local file if applicable
    let totalBytes = 0;
    if (srcProviderType === 'local') {
      const userHome = getUserRoot(req.userId);
      const absSrc = path.join(userHome, srcPath.startsWith('/') ? srcPath.substring(1) : srcPath);
      try {
        const stat = await fs.stat(absSrc);
        totalBytes = stat.size;
      } catch (e) {
        // file stat fallback
      }
    }

    const transfer = await db.createTransfer({
      id: transferId,
      userId: req.userId,
      srcProviderType,
      srcProviderConnectionId,
      srcPath,
      dstProviderType,
      dstProviderConnectionId,
      dstPath,
      operation,
      isDirectory: isDirectory ? 1 : 0,
      totalBytes,
      totalFiles: 1
    });

    // Start asynchronous processing job
    processTransferJob(transfer, req.userId).catch(err => {
      console.error(`[TransferEngine] Async error for ${transferId}:`, err);
    });

    res.status(201).json({ transfer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Asynchronous Background Transfer Engine Processor (#64)
 */
async function processTransferJob(transfer, userId) {
  const { id, src_provider_type, src_path, dst_provider_type, dst_path, operation } = transfer;

  // Mark in progress
  let updated = await db.updateTransferProgress(id, {
    status: 'in_progress',
    startedAt: new Date().toISOString()
  });

  broadcastEvent(userId, { type: 'transfer_started', transfer: updated });

  try {
    const userHome = getUserRoot(userId);
    const localProvider = new LocalProvider({ userRoot: userHome });

    // Check cancellation
    if (activeCancelledIds.has(id)) {
      throw new Error('TRANSFER_CANCELLED');
    }

    if (src_provider_type === 'local' && dst_provider_type === 'local') {
      if (operation === 'move') {
        await localProvider.move(src_path, dst_path);
      } else {
        await localProvider.copy(src_path, dst_path);
      }
    } else {
      // Stub for multi-cloud async transfer engine streams
      await localProvider.copy(src_path, dst_path);
    }

    // Check cancellation after transfer operation
    if (activeCancelledIds.has(id)) {
      throw new Error('TRANSFER_CANCELLED');
    }

    // Mark complete
    const meta = await localProvider.metadata(dst_path).catch(() => null);
    const finalSize = meta ? meta.size : transfer.total_bytes;

    const completed = await db.updateTransferProgress(id, {
      status: 'completed',
      transferredBytes: finalSize,
      completedFiles: 1,
      finishedAt: new Date().toISOString()
    });

    await db.logActivity(userId, operation === 'move' ? 'MOVE' : 'COPY', dst_path, path.basename(dst_path), transfer.is_directory, `Async background transfer ${id}`);

    broadcastEvent(userId, { type: 'transfer_completed', transfer: completed });
  } catch (err) {
    if (err.message === 'TRANSFER_CANCELLED' || activeCancelledIds.has(id)) {
      const cancelled = await db.updateTransferProgress(id, {
        status: 'cancelled',
        finishedAt: new Date().toISOString()
      });
      broadcastEvent(userId, { type: 'transfer_cancelled', transfer: cancelled });
    } else {
      const failed = await db.updateTransferProgress(id, {
        status: 'failed',
        errorMessage: err.message,
        finishedAt: new Date().toISOString()
      });
      broadcastEvent(userId, { type: 'transfer_failed', transfer: failed });
    }
  } finally {
    activeCancelledIds.delete(id);
  }
}

module.exports = router;
