const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Mobile & Touch Responsiveness Strategy (#67)', () => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  let cssContent = '';

  try {
    cssContent = fs.readFileSync(cssPath, 'utf8');
  } catch (err) {
    console.error('Failed to read app.css:', err);
  }

  test('defines max-width 640px mobile media query in app.css', () => {
    assert.ok(cssContent.includes('@media (max-width: 640px)'));
  });

  test('defines single-column card stacking for Conflict Modal on mobile', () => {
    assert.ok(cssContent.includes('.conflict-comparison-grid'));
    assert.ok(cssContent.includes('grid-template-columns: 1fr'));
  });

  test('defines touch-friendly 44px min-height targets for mobile modal buttons and context menu items', () => {
    assert.ok(cssContent.includes('min-height: 44px'));
    assert.ok(cssContent.includes('.context-menu-item'));
  });

  test('defines touch-scrollable tab bar container with hidden scrollbar', () => {
    assert.ok(cssContent.includes('.tab-bar-scroll'));
    assert.ok(cssContent.includes('-webkit-overflow-scrolling: touch'));
    assert.ok(cssContent.includes('scrollbar-width: none'));
  });

  test('collapses inactive tab titles on mobile viewports', () => {
    assert.ok(cssContent.includes('.tab-item:not(.active) .tab-title'));
    assert.ok(cssContent.includes('display: none'));
  });

  test('defines scrollable breadcrumb container for deep folder hierarchies on mobile', () => {
    assert.ok(cssContent.includes('.breadcrumb'));
    assert.ok(cssContent.includes('white-space: nowrap'));
  });
});

describe('Design Guide Alignment — Visual Identity & Responsive Theme (#17)', () => {
  const cssPath = path.join(__dirname, '../../public/css/app.css');
  let cssContent = '';

  try {
    cssContent = fs.readFileSync(cssPath, 'utf8');
  } catch (err) {
    console.error('Failed to read app.css:', err);
  }

  test('defines glassmorphism CSS variables and dark mode palette tokens in app.css', () => {
    assert.ok(cssContent.includes('--glass-bg'));
    assert.ok(cssContent.includes('--glass-border'));
    assert.ok(cssContent.includes('--glass-blur'));
  });

  test('defines glassmorphism panel utility class with backdrop-filter', () => {
    assert.ok(cssContent.includes('.glass-panel'));
    assert.ok(cssContent.includes('backdrop-filter: blur('));
  });

  test('defines micro-animations and smooth transition effects', () => {
    assert.ok(cssContent.includes('.micro-hover'));
    assert.ok(cssContent.includes('.micro-bounce'));
    assert.ok(cssContent.includes('@keyframes microPulse'));
  });
});

describe('Progressive Web App (PWA) & Offline Caching Engine (#47)', () => {
  const publicDir = path.join(__dirname, '../../public');
  const manifestPath = path.join(publicDir, 'manifest.json');
  const swPath = path.join(publicDir, 'sw.js');
  const htmlPath = path.join(publicDir, 'index.html');

  test('defines PWA web app manifest with name, icons, and start_url', () => {
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist in public directory');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.name, 'manifest must specify app name');
    assert.ok(manifest.short_name, 'manifest must specify short_name');
    assert.ok(manifest.start_url, 'manifest must specify start_url');
    assert.ok(manifest.display, 'manifest must specify display mode');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest must contain icons array');
  });

  test('implements service worker for offline caching with install, activate, and fetch handlers', () => {
    assert.ok(fs.existsSync(swPath), 'sw.js must exist in public directory');
    const swContent = fs.readFileSync(swPath, 'utf8');
    assert.ok(swContent.includes("addEventListener('install'"), 'sw.js must handle install event');
    assert.ok(swContent.includes("addEventListener('activate'"), 'sw.js must handle activate event');
    assert.ok(swContent.includes("addEventListener('fetch'"), 'sw.js must handle fetch event');
    assert.ok(swContent.includes('caches.open'), 'sw.js must open cache for offline storage');
  });

  test('links manifest.json and registers service worker in index.html', () => {
    assert.ok(fs.existsSync(htmlPath), 'index.html must exist in public directory');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(htmlContent.includes('rel="manifest"') || htmlContent.includes("rel='manifest'"), 'index.html must link manifest.json');
    assert.ok(htmlContent.includes('serviceWorker.register'), 'index.html must register service worker sw.js');
  });
});


