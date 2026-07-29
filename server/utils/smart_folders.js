const fs = require('fs/promises');
const path = require('path');

const CATEGORIES = {
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages', 'csv', 'xlsx', 'xls', 'pptx', 'ppt'],
  videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  archives: ['zip', 'tar', 'gz', 'bz2', '7z', 'rar'],
  code: ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'sh']
};

/**
 * Dynamically evaluate smart folder criteria against files in userRoot (#46)
 */
async function evaluateSmartFolder(userRoot, smartFolder) {
  const query = (smartFolder.query || '').trim().toLowerCase();
  const filters = smartFolder.filters || {};
  const results = [];

  let allowedExtensions = null;
  if (filters.extension) {
    if (Array.isArray(filters.extension)) {
      allowedExtensions = filters.extension.map(e => e.toLowerCase().replace(/^\./, ''));
    } else if (typeof filters.extension === 'string') {
      allowedExtensions = [filters.extension.toLowerCase().replace(/^\./, '')];
    }
  }

  let categoryExtensions = null;
  if (filters.category && CATEGORIES[filters.category.toLowerCase()]) {
    categoryExtensions = CATEGORIES[filters.category.toLowerCase()];
  }

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relativePath = '/' + path.relative(userRoot, fullPath).replace(/\\/g, '/');
          const ext = path.extname(entry.name).slice(1).toLowerCase();

          // 1. Text Query Filter
          if (query && !entry.name.toLowerCase().includes(query) && !relativePath.toLowerCase().includes(query)) {
            continue;
          }

          // 2. Extension Filter
          if (allowedExtensions && !allowedExtensions.includes(ext)) {
            continue;
          }

          // 3. Category Filter
          if (categoryExtensions && !categoryExtensions.includes(ext)) {
            continue;
          }

          const stat = await fs.stat(fullPath);

          // 4. Size Filters
          if (filters.minSize !== undefined && stat.size < filters.minSize) {
            continue;
          }
          if (filters.maxSize !== undefined && stat.size > filters.maxSize) {
            continue;
          }

          // 5. Date Filters
          if (filters.dateFrom && new Date(stat.mtime) < new Date(filters.dateFrom)) {
            continue;
          }
          if (filters.dateTo && new Date(stat.mtime) > new Date(filters.dateTo)) {
            continue;
          }

          // Categorize
          let category = 'other';
          for (const [catName, catExts] of Object.entries(CATEGORIES)) {
            if (catExts.includes(ext)) {
              category = catName;
              break;
            }
          }

          results.push({
            name: entry.name,
            path: relativePath,
            size: stat.size,
            extension: ext,
            category,
            modified: stat.mtime,
            created: stat.birthtime || stat.ctime,
            is_directory: false,
            virtual: true
          });
        }
      }
    } catch (err) {
      // Ignore unreadable dirs
    }
  }

  await walk(userRoot);
  return results;
}

module.exports = {
  evaluateSmartFolder,
  CATEGORIES
};
