const db = require('../db');

/**
 * Dispatch JSON event payloads to configured webhooks for a user (#72)
 * @param {string} userId - ID of the user triggering or owning the action
 * @param {'file_created'|'file_deleted'|'share_revoked'} event - Event type
 * @param {Object} data - Payload details
 */
async function dispatchWebhookEvent(userId, event, data) {
  if (!userId) return [];
  try {
    const webhooks = await db.getWebhooksByUser(userId);
    const activeWebhooks = webhooks.filter(w => w.enabled === 1 || w.enabled === true);

    const dispatches = activeWebhooks.map(async (webhook) => {
      let subscribedEvents = [];
      try {
        subscribedEvents = typeof webhook.events === 'string' ? JSON.parse(webhook.events) : (webhook.events || []);
      } catch (e) {
        subscribedEvents = ['file_created', 'file_deleted', 'share_revoked'];
      }

      if (subscribedEvents.length > 0 && !subscribedEvents.includes(event)) {
        return { webhookId: webhook.id, skipped: true };
      }

      const payload = {
        event,
        timestamp: new Date().toISOString(),
        user_id: userId,
        data
      };

      const headers = {
        'Content-Type': 'application/json'
      };
      if (webhook.secret) {
        headers['X-Webhook-Secret'] = webhook.secret;
      }

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
        return {
          webhookId: webhook.id,
          success: response.ok,
          status: response.status
        };
      } catch (err) {
        return {
          webhookId: webhook.id,
          success: false,
          error: err.message
        };
      }
    });

    return await Promise.all(dispatches);
  } catch (err) {
    console.error('[WebhookDispatcher] Error dispatching event:', err);
    return [];
  }
}

module.exports = {
  dispatchWebhookEvent
};
