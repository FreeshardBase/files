const express = require('express');
const session = require('express-session');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const db = require('./db');
const authRoutes = require('./routes/auth');
const filesRoutes = require('./routes/files');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'freeshard-files-default-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/files/local', filesRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'freeshard-files', timestamp: new Date().toISOString() });
});

// SPA Fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Initialize DB and start server
db.initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FilesApp] Server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('[FilesApp] Fatal DB initialization error:', err);
  process.exit(1);
});
