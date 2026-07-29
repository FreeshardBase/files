const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  createWebhook, getWebhooksByUser, getWebhookById, deleteWebhook, updateWebhook,
  createAutomationRule, getAutomationRulesByUser, getAutomationRuleById, updateAutomationRule, deleteAutomationRule,
  createPersonalAccessToken, getPersonalAccessTokensByUser, deletePersonalAccessToken
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

/**
 * GET /api/webhooks/automation-rules
 * List user's event-driven file automation rules (#37)
 */
router.get('/automation-rules', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const rules = await getAutomationRulesByUser(userId);
    res.json({ success: true, rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/automation-rules
 * Create a new event-driven file automation rule (#37)
 */
router.post('/automation-rules', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { name, trigger_event, condition_type, condition_value, action_type, action_target, priority, is_active } = req.body;

    if (!condition_type || !condition_value || !action_target) {
      return res.status(400).json({ error: 'condition_type, condition_value, and action_target are required' });
    }

    const rule = await createAutomationRule({
      userId,
      name: name || '',
      trigger_event: trigger_event || 'file_created',
      condition_type,
      condition_value,
      action_type: action_type || 'move',
      action_target,
      priority: priority || 0,
      is_active: is_active !== undefined ? is_active : 1
    });

    res.status(201).json({ success: true, rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/webhooks/automation-rules/:id
 * Update an automation rule
 */
router.patch('/automation-rules/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const ruleId = req.params.id;

    const existing = await getAutomationRuleById(userId, ruleId);
    if (!existing) {
      return res.status(404).json({ error: 'Automation rule not found' });
    }

    const updated = await updateAutomationRule(userId, ruleId, req.body);
    res.json({ success: true, rule: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/webhooks/automation-rules/:id
 * Delete an automation rule
 */
router.delete('/automation-rules/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const ruleId = req.params.id;

    const deleted = await deleteAutomationRule(userId, ruleId);
    if (!deleted) {
      return res.status(404).json({ error: 'Automation rule not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/webhooks/pats
 * List personal access tokens for authenticated user (#40)
 */
router.get('/pats', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const pats = await getPersonalAccessTokensByUser(userId);
    res.json({ success: true, pats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/pats
 * Create a new personal access token (#40)
 */
router.post('/pats', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const { name, expiresAt } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const pat = await createPersonalAccessToken({ userId, name, expiresAt });
    res.status(201).json({ success: true, pat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/webhooks/pats/:id
 * Delete/revoke a personal access token (#40)
 */
router.delete('/pats/:id', async (req, res) => {
  try {
    const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
    const patId = req.params.id;

    const deleted = await deletePersonalAccessToken(userId, patId);
    if (!deleted) {
      return res.status(404).json({ error: 'PAT not found' });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


