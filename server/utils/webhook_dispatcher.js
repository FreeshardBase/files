const path = require('path');
const fs = require('fs/promises');
const db = require('../db');

/**
 * Evaluate and execute file automation rules when an event triggers (#37)
 */
async function processAutomationRules(userId, event, data) {
  if (!userId || !data || !data.path) return [];
  try {
    const rules = await db.getAutomationRulesByUser(userId);
    const activeRules = rules.filter(r => (r.is_active === 1 || r.is_active === true) && (r.trigger_event === event || r.trigger_event === '*'));
    if (!activeRules.length) return [];

    const filePath = data.path;
    const fileName = path.posix.basename(filePath);
    const ext = path.extname(fileName).toLowerCase().replace(/^\./, '');
    const lowerName = fileName.toLowerCase();
    const mimeType = data.mimeType || data.mime_type || null;

    const results = [];

    for (const rule of activeRules) {
      const condVal = (rule.condition_value || '').trim();
      let matched = false;

      switch (rule.condition_type) {
        case 'extension': {
          const targetExt = condVal.toLowerCase().replace(/^\./, '');
          if (ext === targetExt) matched = true;
          break;
        }
        case 'keyword':
        case 'name_contains': {
          if (lowerName.includes(condVal.toLowerCase())) matched = true;
          break;
        }
        case 'mime_type': {
          if (mimeType) {
            const ruleType = condVal.toLowerCase();
            const actualType = mimeType.toLowerCase();
            if (ruleType.endsWith('/*') && actualType.startsWith(ruleType.slice(0, -2))) {
              matched = true;
            } else if (actualType === ruleType) {
              matched = true;
            }
          }
          break;
        }
        case 'regex': {
          try {
            const re = new RegExp(condVal, 'i');
            if (re.test(fileName)) matched = true;
          } catch (e) {}
          break;
        }
      }

      if (!matched) continue;

      // Execute Action
      if (rule.action_type === 'move') {
        const targetFolder = rule.action_target || '/';
        const destinationPath = path.posix.join(targetFolder, fileName);
        if (filePath !== destinationPath) {
          const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
          const userFilesDir = data.userRoot || path.join(dataDir, 'users', userId, 'files');

          const absSource = path.join(userFilesDir, filePath);
          const absDestDir = path.join(userFilesDir, targetFolder);
          const absDest = path.join(userFilesDir, destinationPath);

          try {
            await fs.mkdir(absDestDir, { recursive: true });
            await fs.rename(absSource, absDest);
            results.push({ ruleId: rule.id, action: 'move', success: true, destinationPath });
          } catch (err) {
            results.push({ ruleId: rule.id, action: 'move', success: false, error: err.message });
          }
        }
      } else if (rule.action_type === 'tag') {
        try {
          await db.assignTag(userId, filePath, rule.action_target);
          results.push({ ruleId: rule.id, action: 'tag', success: true, tag: rule.action_target });
        } catch (err) {
          results.push({ ruleId: rule.id, action: 'tag', success: false, error: err.message });
        }
      } else if (rule.action_type === 'process') {
        results.push({ ruleId: rule.id, action: 'process', success: true });
      }
    }

    return results;
  } catch (err) {
    console.error('[WebhookDispatcher] Error processing automation rules:', err);
    return [];
  }
}

/**
 * Dispatch JSON event payloads to configured webhooks for a user (#72)
 * @param {string} userId - ID of the user triggering or owning the action
 * @param {'file_created'|'file_deleted'|'share_revoked'} event - Event type
 * @param {Object} data - Payload details
 */
async function dispatchWebhookEvent(userId, event, data) {
  if (!userId) return [];
  try {
    // Also process event-driven file automation rules (#37)
    await processAutomationRules(userId, event, data).catch(() => []);

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
  dispatchWebhookEvent,
  processAutomationRules
};

