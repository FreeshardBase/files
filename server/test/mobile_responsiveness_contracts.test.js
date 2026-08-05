const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Mobile & Tablet Responsiveness Contracts (#67)', () => {
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

  test('defines touch-friendly 44px min-height buttons for mobile modals', () => {
    assert.ok(cssContent.includes('min-height: 44px'));
  });

  test('defines touch-scrollable tab bar container with hidden scrollbar', () => {
    assert.ok(cssContent.includes('.tab-bar-scroll'));
    assert.ok(cssContent.includes('-webkit-overflow-scrolling: touch'));
    assert.ok(cssContent.includes('scrollbar-width: none'));
  });

  test('truncates tab titles on mobile viewports for layout stability', () => {
    assert.ok(cssContent.includes('.tab-item .tab-title'));
    assert.ok(cssContent.includes('text-overflow: ellipsis'));
  });

  test('defines scrollable breadcrumb area for deep folder hierarchies on mobile', () => {
    assert.ok(cssContent.includes('.breadcrumb-area'));
    assert.ok(cssContent.includes('white-space: nowrap'));
  });
});
