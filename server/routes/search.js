/**
 * Search API Routes (#100)
 * GET /api/search/universal — Universal cross-app search query across files, shares, tags, and ecosystem integrations.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

router.use(requireAuth);

/**
 * GET /api/search/universal?q=...
 */
router.get('/universal', async (req, res) => {
  try {
    const q = req.query.q || req.query.query;
    if (!q || typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: 'Query parameter "q" or "query" is required' });
    }

    const searchResults = await db.searchUniversal(req.userId, q.trim());

    // Aggregate deep links
    const deepLinks = [];

    searchResults.files.forEach(f => {
      if (f.deepLink) deepLinks.push({ type: 'file', url: f.deepLink, path: f.path });
    });

    searchResults.shares.forEach(s => {
      if (s.deepLink) deepLinks.push({ type: s.type, url: s.deepLink, id: s.id, token: s.token });
    });

    searchResults.tags.forEach(t => {
      if (t.deepLink) deepLinks.push({ type: 'tag', url: t.deepLink, tagName: t.tagName });
    });

    searchResults.ecosystem.forEach(e => {
      if (e.deepLink) deepLinks.push({ type: e.target, url: e.deepLink, remoteId: e.remoteId });
    });

    res.json({
      query: q.trim(),
      results: searchResults,
      deepLinks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
