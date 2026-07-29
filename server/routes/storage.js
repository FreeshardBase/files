const express = require('express');
const LocalProvider = require('../providers/local');
const FailoverProvider = require('../providers/failover');
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

  return router;
}

// Support both express router middleware default export and factory function
const defaultRouter = createStorageRouter();
module.exports = Object.assign(createStorageRouter, defaultRouter);
