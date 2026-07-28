const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  createWebhook, getWebhooksByUser, getWebhookById, deleteWebhook, updateWebhook
} = require('../db');
const { dispatchWebhookEvent } = require('../utils/webhook_dispatcher');

router.use(requireAuth);

/**
 * GET /api/webhooks
 * List user's configured webhooks
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const webhooks = await getWebhooksByUser(userId);
    const formatted = webhooks.map(w => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events
    }));
    res.json({ webhooks: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks
 * Create a new user webhook configuration
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { url, secret, events, enabled } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const webhook = await createWebhook({
      userId,
      url,
      secret: secret || null,
      events: events || ['file_created', 'file_deleted', 'share_revoked'],
      enabled: enabled !== undefined ? enabled : 1
    });

    res.status(201).json({
      success: true,
      webhook: {
        ...webhook,
        events: typeof webhook.events === 'string' ? JSON.parse(webhook.events) : webhook.events
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/webhooks/:id
 * Update a user webhook configuration
 */
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const webhookId = req.params.id;
    const { url, secret, events, enabled } = req.body;

    const existing = await getWebhookById(webhookId, userId);
    if (!existing) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const updated = await updateWebhook(webhookId, userId, { url, secret, events, enabled });
    res.json({
      success: true,
      webhook: {
        ...updated,
        events: typeof updated.events === 'string' ? JSON.parse(updated.events) : updated.events
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/webhooks/:id
 * Delete a user webhook configuration
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const webhookId = req.params.id;

    const deleted = await deleteWebhook(webhookId, userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/test
 * Trigger test payload dispatch to user webhooks
 */
router.post('/test', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { event = 'file_created', data = { test: true } } = req.body;

    const results = await dispatchWebhookEvent(userId, event, data);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
