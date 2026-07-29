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

