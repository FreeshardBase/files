require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const authRouter = require('./routes/auth');
const filesRouter = require('./routes/files');
const i18nRouter = require('./routes/i18n');
const { i18nMiddleware } = require('./utils/i18n');

const app = express();
const PORT = process.env.PORT || 3005;

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
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Internationalization Middleware (#25)
app.use(i18nMiddleware);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mount API routes
app.use('/api/auth', authRouter);
app.use('/api/files/local', filesRouter);
app.use('/api/i18n', i18nRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'freeshard-files',
    locale: req.locale,
    timestamp: new Date().toISOString()
  });
});

// Initialize SQLite DB and start HTTP Server
db.initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FilesApp] Server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
