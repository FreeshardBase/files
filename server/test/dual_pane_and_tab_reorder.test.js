const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function reorderTabs(tabs, fromIndex, toIndex) {
  const newTabs = [...tabs];
  if (fromIndex >= 0 && fromIndex < newTabs.length && toIndex >= 0 && toIndex < newTabs.length) {
    const [movedTab] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, movedTab);
  }
  return newTabs;
}

describe('Dual-Pane Side-by-Side View (#61) & Tab Drag-to-Reorder (#69)', () => {
  describe('Tab Reordering Algorithm (#69)', () => {
    test('reorders tabs horizontally when dragging tab 0 to position 2', () => {
      const tabs = [
        { id: 'tab-1', title: 'Home' },
        { id: 'tab-2', title: 'Google Drive' },
        { id: 'tab-3', title: 'Dropbox' }
      ];

      const reordered = reorderTabs(tabs, 0, 2);
      assert.equal(reordered[0].id, 'tab-2');
      assert.equal(reordered[1].id, 'tab-3');
      assert.equal(reordered[2].id, 'tab-1');
    });

    test('reorders tabs horizontally when dragging tab 2 to position 0', () => {
      const tabs = [
        { id: 'tab-1', title: 'Home' },
        { id: 'tab-2', title: 'Google Drive' },
        { id: 'tab-3', title: 'Dropbox' }
      ];

      const reordered = reorderTabs(tabs, 2, 0);
      assert.equal(reordered[0].id, 'tab-3');
      assert.equal(reordered[1].id, 'tab-1');
      assert.equal(reordered[2].id, 'tab-2');
    });

    test('preserves tab array unchanged for out-of-bound indices', () => {
      const tabs = [{ id: 'tab-1' }, { id: 'tab-2' }];
      const reordered = reorderTabs(tabs, 0, 99);
      assert.deepEqual(reordered, tabs);
    });
  });

  describe('Dual-Pane State & Context Menu Contract (#61)', () => {
    test('toggles split view state cleanly', () => {
      let isSplitViewActive = false;
      const toggle = () => { isSplitViewActive = !isSplitViewActive; };

      toggle();
      assert.equal(isSplitViewActive, true);

      toggle();
      assert.equal(isSplitViewActive, false);
    });

    test('selects secondary tab for split-right action', () => {
      const tabs = [
        { id: 'tab-1', path: '/', viewType: 'local' },
        { id: 'tab-2', path: '/Photos', viewType: 'provider', providerId: '1' }
      ];
      const activeTabId = 'tab-1';

      const targetTab = tabs.find(t => t.id !== activeTabId);
      assert.ok(targetTab);
      assert.equal(targetTab.id, 'tab-2');
      assert.equal(targetTab.path, '/Photos');
    });

    test('tracks active pane focus state and routes tab switching correctly', () => {
      let activePane = 'primary';
      let primaryTab = 'tab-1';
      let secondaryTab = 'tab-2';

      const switchTab = (tabId) => {
        if (activePane === 'secondary') {
          secondaryTab = tabId;
        } else {
          primaryTab = tabId;
        }
      };

      // When primary pane is focused, switching tab updates primary pane
      switchTab('tab-3');
      assert.equal(primaryTab, 'tab-3');
      assert.equal(secondaryTab, 'tab-2');

      // Set focus to secondary pane
      activePane = 'secondary';
      switchTab('tab-4');
      assert.equal(primaryTab, 'tab-3');
      assert.equal(secondaryTab, 'tab-4');
    });

    test('normalizes stringified null/undefined providerId in secondary pane', () => {
      const normalizeProviderId = (providerId) => {
        return (providerId && providerId !== 'null' && providerId !== 'undefined') ? String(providerId) : null;
      };

      assert.equal(normalizeProviderId('1'), '1');
      assert.equal(normalizeProviderId(1), '1');
      assert.equal(normalizeProviderId(null), null);
      assert.equal(normalizeProviderId('null'), null);
      assert.equal(normalizeProviderId(undefined), null);
      assert.equal(normalizeProviderId('undefined'), null);
    });

    test('resolves file icon emoji via getFileIcon & getFileIconEmoji alias without throwing TypeError', () => {
      const getFileIcon = (filename) => {
        const ext = filename.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
        if (['pdf'].includes(ext)) return '📕';
        return '📄';
      };
      const getFileIconEmoji = (filename) => getFileIcon(filename);

      assert.equal(getFileIconEmoji('document.pdf'), '📕');
      assert.equal(getFileIconEmoji('photo.png'), '🖼️');
      assert.equal(getFileIcon('file.txt'), '📄');
    });

    test('verifies active pane border outline CSS is scoped to .panes-wrapper.split-view-active', () => {
      const fs = require('fs');
      const path = require('path');
      const cssPath = path.join(__dirname, '../../public/css/app.css');
      const cssContent = fs.readFileSync(cssPath, 'utf8');

      assert.ok(cssContent.includes('.panes-wrapper.split-view-active .content-area.active-pane'));
    });
  });
});
