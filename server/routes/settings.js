const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/bandwidth', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const settings = await db.getBandwidthSettings(userId);
    res.json({
      success: true,
      settings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bandwidth', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { upload_limit_kbps, download_limit_kbps } = req.body || {};

  if (
    upload_limit_kbps === undefined ||
    download_limit_kbps === undefined ||
    typeof upload_limit_kbps !== 'number' ||
    typeof download_limit_kbps !== 'number' ||
    upload_limit_kbps < 0 ||
    download_limit_kbps < 0
  ) {
    return res.status(400).json({ error: 'Invalid bandwidth limit values' });
  }

  try {
    const updated = await db.setBandwidthSettings(userId, {
      upload_limit_kbps,
      download_limit_kbps
    });
    res.json({
      success: true,
      settings: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Custom Branding Settings (#92)
router.get('/branding', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const branding = await db.getUserBranding(userId);
    res.json({
      success: true,
      branding
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/branding', async (req, res) => {
  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { logo_url, primary_color, welcome_message, custom_domain } = req.body || {};

  try {
    const branding = await db.setUserBranding(userId, {
      logo_url,
      primary_color,
      welcome_message,
      custom_domain
    });
    res.json({
      success: true,
      branding
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
