const express = require('express');
const router = express.Router();
const { getTranslations, resolveLocale, supportedLocales } = require('../utils/i18n');

// GET /api/i18n/translations?lang=de
router.get('/translations', (req, res) => {
  const locale = resolveLocale(req);
  const data = getTranslations(locale);
  res.json({
    locale,
    supportedLocales,
    translations: data
  });
});

module.exports = router;
