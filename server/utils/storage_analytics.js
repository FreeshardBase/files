const fs = require('fs/promises');
const path = require('path');
const db = require('../db');

const CATEGORY_MAP = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff'],
  documents: ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.md', '.csv', '.rtf'],
  videos: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.m4v'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'],
  archives: ['.zip', '.tar', '.gz', '.7z', '.rar'],
  code: ['.js', '.json', '.html', '.css', '.py', '.c', '.cpp', '.ts', '.sh', '.xml', '.yml', '.yaml']
};

function getCategoryForExtension(ext) {
  ext = (ext || '').toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORY_MAP)) {
    if (extensions.includes(ext)) {
      return category;
    }
  }
  return 'other';
}

async function getStorageAnalytics(userRoot, userId = null) {
  let totalUsed = 0;
  let totalFiles = 0;

  const byFileType = {
    images: { count: 0, bytes: 0 },
    documents: { count: 0, bytes: 0 },
    videos: { count: 0, bytes: 0 },
    audio: { count: 0, bytes: 0 },
    archives: { count: 0, bytes: 0 },
    code: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 }
  };

  const byExtension = {};

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.lstat(fullPath);
          if (stat.isDirectory()) {
            await walk(fullPath);
          } else if (stat.isFile()) {
            const size = stat.size;
            const ext = path.extname(entry.name).toLowerCase() || '.none';
            const category = getCategoryForExtension(ext);

            totalUsed += size;
            totalFiles += 1;

            byFileType[category].count += 1;
            byFileType[category].bytes += size;

            if (!byExtension[ext]) {
              byExtension[ext] = { count: 0, bytes: 0 };
            }
            byExtension[ext].count += 1;
            byExtension[ext].bytes += size;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  if (userRoot) {
    await walk(userRoot);
  }

  const providers = {
    local: { used: totalUsed, total: null }
  };

  if (userId) {
    try {
      const user = await db.get('SELECT quota_bytes FROM users WHERE id = ?', [userId]);
      if (user && user.quota_bytes) {
        providers.local.total = user.quota_bytes;
      }
      const connections = await db.all('SELECT * FROM provider_connections WHERE user_id = ? AND enabled = 1', [userId]);
      if (Array.isArray(connections)) {
        for (const conn of connections) {
          providers[conn.provider_type] = {
            id: conn.id,
            displayName: conn.display_name,
            type: conn.provider_type,
            used: 0,
            total: null
          };
        }
      }
    } catch (err) {}
  }

  return {
    totalUsed,
    totalFiles,
    byFileType,
    byExtension,
    providers
  };
}

module.exports = {
  getStorageAnalytics,
  getCategoryForExtension,
  CATEGORY_MAP
};
