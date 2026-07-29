const express = require('express');
const LocalProvider = require('../providers/local');
const FailoverProvider = require('../providers/failover');
const { getStorageAnalytics } = require('../utils/storage_analytics');
const path = require('path');

let globalFailoverInstance = null;

function getFailoverInstance() {
  if (!globalFailoverInstance) {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    const primaryPath = process.env.PRIMARY_STORAGE_PATH || path.join(dataDir, 'primary');
    const secondaryPath = process.env.SECONDARY_STORAGE_PATH || path.join(dataDir, 'secondary');

    const primaryProvider = new LocalProvider({ userRoot: primaryPath });
    const secondaryProvider = new LocalProvider({ userRoot: secondaryPath });

    globalFailoverInstance = new FailoverProvider({
      primaryProvider,
      secondaryProvider
    });
  }
  return globalFailoverInstance;
}

function createStorageRouter(customFailoverProvider = null) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    try {
      const provider = customFailoverProvider || getFailoverInstance();
      const health = await provider.checkHealth();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: 'Failed to retrieve storage health', details: err.message });
    }
  });

  router.post('/probe', async (req, res) => {
    try {
      const provider = customFailoverProvider || getFailoverInstance();
      const health = await provider.probeHealth();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: 'Failed to probe storage health', details: err.message });
    }
  });

  router.get('/analytics', async (req, res) => {
    try {
      const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id)));
      const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
      const userRoot = req.userRoot || (userId ? path.join(dataDir, 'users', userId) : (process.env.FILES_ROOT || dataDir));

      const analytics = await getStorageAnalytics(userRoot, userId);
      res.json(analytics);
    } catch (err) {
      res.status(500).json({ error: 'Failed to retrieve storage analytics', details: err.message });
    }
  });

  return router;
}

// Support both express router middleware default export and factory function
const defaultRouter = createStorageRouter();

function storageMiddleware(req, res, next) {
  if (req && req.on && typeof next === 'function') {
    return defaultRouter(req, res, next);
  }
  return createStorageRouter(req);
}

module.exports = Object.assign(storageMiddleware, defaultRouter, { createStorageRouter });

