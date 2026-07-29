require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const db = require('./db');
const authRouter = require('./routes/auth');
const filesRouter = require('./routes/files');
const i18nRouter = require('./routes/i18n');
const sharingRouter = require('./routes/sharing');
const publicShareRouter = require('./routes/public_share');
const providersRouter = require('./routes/providers');
const trashRouter = require('./routes/trash');
const activityRouter = require('./routes/activity');
const transfersRouter = require('./routes/transfers');
const ecosystemRouter = require('./routes/ecosystem');
const syncRouter = require('./routes/sync');
const webhooksRouter = require('./routes/webhooks');
const vaultsRouter = require('./routes/vaults');
const tagsRouter = require('./routes/tags');
const commentsRouter = require('./routes/comments');
const webdavRouter = require('./routes/webdav');
const backupsRouter = require('./routes/backups');
const wopiRouter = require('./routes/wopi');
const settingsRouter = require('./routes/settings');
const archiveRouter = require('./routes/archive');
const mediaRouter   = require('./routes/media');
const { bitrotScannerRouter } = require('./utils/bitrot_scanner');
const { bandwidthThrottler } = require('./middleware/bandwidth');
const { i18nMiddleware } = require('./utils/i18n');

const app = express();
const PORT = process.env.PORT || 3005;

// Trust reverse proxy (Nginx / SSH Tunnel) so secure session cookies are set correctly (#2)
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session handling
app.use(session({
  secret: process.env.SESSION_SECRET || 'freeshard_files_secret_key_change_in_prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Internationalization Middleware (#25)
app.use(i18nMiddleware);

// Bandwidth Throttling Middleware (#86)
app.use(bandwidthThrottler);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mount API routes
app.use('/api/auth', authRouter);
app.use('/api/files/local', filesRouter);
app.use('/api/files', filesRouter);
app.use('/api/i18n', i18nRouter);
app.use('/api/shares', sharingRouter);
app.use('/api/providers', providersRouter);
app.use('/api/trash', trashRouter);
app.use('/api/activity', activityRouter);
app.use('/api/transfers', transfersRouter);
app.use('/api/ecosystem', ecosystemRouter);
app.use('/api/sync', syncRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/vaults', vaultsRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/archive', archiveRouter);
app.use('/api/media',   mediaRouter);
app.use('/api/integrity', bitrotScannerRouter);
app.use('/wopi', wopiRouter);
app.use('/api/wopi', wopiRouter);
app.use('/webdav', webdavRouter);
app.use('/s', publicShareRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'freeshard-files',
    locale: req.locale,
    timestamp: new Date().toISOString()
  });
});

// Periodic Trash 30-Day Auto-Cleanup Job (#18)
function startTrashAutoCleanup() {
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run every hour
  setInterval(async () => {
    try {
      const expiredItems = await db.cleanupExpiredTrashItems();
      if (expiredItems.length > 0) {
        console.log(`[TrashCleanup] Purged ${expiredItems.length} expired items from database.`);
        const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
        for (const item of expiredItems) {
          const diskPath = path.join(dataDir, 'users', item.user_id, '.trash', item.id);
          await fs.rm(diskPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[TrashCleanup] Error purging expired items:', err.message);
    }
  }, CLEANUP_INTERVAL_MS);
}

// Initialize SQLite DB and start HTTP Server
db.initDb().then(() => {
  startTrashAutoCleanup();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FilesApp] Server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
