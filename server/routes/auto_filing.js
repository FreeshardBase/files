const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { evaluateRules, processAutoFiling } = require('../utils/auto_filing');

// Require authentication for all auto-filing endpoints
router.use((req, res, next) => {
  if (req.userId) return next();
  requireAuth(req, res, next);
});

/**
 * GET /api/auto-filing/rules
 */
router.get('/rules', async (req, res) => {
  try {
    const rules = await db.getFilingRulesByUser(req.userId);
    res.json({ success: true, rules });
  } catch (err) {
    console.error('[AutoFiling] Error listing rules:', err);
    res.status(500).json({ error: 'Failed to list filing rules' });
  }
});

/**
 * POST /api/auto-filing/rules
 */
router.post('/rules', async (req, res) => {
  try {
    const { name, condition_type, condition_value, target_folder, is_active, priority } = req.body || {};

    if (!condition_type || !condition_value || !target_folder) {
      return res.status(400).json({ error: 'condition_type, condition_value, and target_folder are required' });
    }

    const rule = await db.createFilingRule(req.userId, {
      name,
      condition_type,
      condition_value,
      target_folder,
      is_active,
      priority
    });

    res.status(201).json({ success: true, rule });
  } catch (err) {
    console.error('[AutoFiling] Error creating rule:', err);
    res.status(500).json({ error: 'Failed to create filing rule' });
  }
});

/**
 * PUT /api/auto-filing/rules/:id
 */
router.put('/rules/:id', async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id, 10);
    const updated = await db.updateFilingRule(req.userId, ruleId, req.body || {});
    if (!updated) {
      return res.status(404).json({ error: 'Filing rule not found' });
    }
    res.json({ success: true, rule: updated });
  } catch (err) {
    console.error('[AutoFiling] Error updating rule:', err);
    res.status(500).json({ error: 'Failed to update filing rule' });
  }
});

/**
 * DELETE /api/auto-filing/rules/:id
 */
router.delete('/rules/:id', async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id, 10);
    const deleted = await db.deleteFilingRule(req.userId, ruleId);
    if (!deleted) {
      return res.status(404).json({ error: 'Filing rule not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[AutoFiling] Error deleting rule:', err);
    res.status(500).json({ error: 'Failed to delete filing rule' });
  }
});

/**
 * POST /api/auto-filing/evaluate
 */
router.post('/evaluate', async (req, res) => {
  try {
    const { fileName, name, mimeType } = req.body || {};
    const targetName = fileName || name;
    if (!targetName) {
      return res.status(400).json({ error: 'fileName is required' });
    }
    const rule = await evaluateRules(req.userId, targetName, mimeType);
    res.json({ success: true, matched: !!rule, rule });
  } catch (err) {
    console.error('[AutoFiling] Error evaluating rule:', err);
    res.status(500).json({ error: 'Failed to evaluate filing rule' });
  }
});

/**
 * POST /api/auto-filing/process
 */
router.post('/process', async (req, res) => {
  try {
    const { filePath, path: p, mimeType } = req.body || {};
    const targetPath = filePath || p;
    if (!targetPath) {
      return res.status(400).json({ error: 'filePath is required' });
    }
    const result = await processAutoFiling(req.userId, targetPath, mimeType);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[AutoFiling] Error processing auto-filing:', err);
    res.status(500).json({ error: 'Failed to process auto-filing' });
  }
});

module.exports = router;
