const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

class HistoryTracker {
  constructor() {
    this.historyStack = [];
    this.historyIndex = -1;
  }

  pushHistory(state, isNavigatingHistory = false) {
    if (isNavigatingHistory) return;
    const current = this.historyStack[this.historyIndex];
    if (current && JSON.stringify(current) === JSON.stringify(state)) return;
    this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    this.historyStack.push(state);
    this.historyIndex = this.historyStack.length - 1;
  }

  canNavigateBack() {
    return this.historyIndex > 0;
  }

  canNavigateForward() {
    return this.historyIndex >= 0 && this.historyIndex < this.historyStack.length - 1;
  }

  navigateBack() {
    if (!this.canNavigateBack()) return null;
    this.historyIndex--;
    return this.historyStack[this.historyIndex];
  }

  navigateForward() {
    if (!this.canNavigateForward()) return null;
    this.historyIndex++;
    return this.historyStack[this.historyIndex];
  }
}

describe('Mouse Side-Button Folder History Navigation (#65)', () => {
  test('initializes empty history stack and index at -1', () => {
    const tracker = new HistoryTracker();
    assert.equal(tracker.historyStack.length, 0);
    assert.equal(tracker.historyIndex, -1);
    assert.equal(tracker.canNavigateBack(), false);
    assert.equal(tracker.canNavigateForward(), false);
  });

  test('pushes new directory navigation states into history stack', () => {
    const tracker = new HistoryTracker();
    tracker.pushHistory({ viewType: 'local', path: '/' });
    tracker.pushHistory({ viewType: 'local', path: '/Documents' });

    assert.equal(tracker.historyStack.length, 2);
    assert.equal(tracker.historyIndex, 1);
    assert.equal(tracker.canNavigateBack(), true);
    assert.equal(tracker.canNavigateForward(), false);
  });

  test('navigates back to previous folder history state', () => {
    const tracker = new HistoryTracker();
    tracker.pushHistory({ viewType: 'local', path: '/' });
    tracker.pushHistory({ viewType: 'local', path: '/Documents' });
    tracker.pushHistory({ viewType: 'local', path: '/Documents/Projects' });

    const prev = tracker.navigateBack();
    assert.deepEqual(prev, { viewType: 'local', path: '/Documents' });
    assert.equal(tracker.historyIndex, 1);
    assert.equal(tracker.canNavigateBack(), true);
    assert.equal(tracker.canNavigateForward(), true);
  });

  test('navigates forward to next folder history state', () => {
    const tracker = new HistoryTracker();
    tracker.pushHistory({ viewType: 'local', path: '/' });
    tracker.pushHistory({ viewType: 'local', path: '/Documents' });

    tracker.navigateBack();
    const next = tracker.navigateForward();

    assert.deepEqual(next, { viewType: 'local', path: '/Documents' });
    assert.equal(tracker.historyIndex, 1);
    assert.equal(tracker.canNavigateForward(), false);
  });

  test('truncates forward history when new path is visited after back navigation', () => {
    const tracker = new HistoryTracker();
    tracker.pushHistory({ viewType: 'local', path: '/' });
    tracker.pushHistory({ viewType: 'local', path: '/Documents' });
    tracker.pushHistory({ viewType: 'local', path: '/Pictures' });

    tracker.navigateBack(); // Back to /Documents
    tracker.pushHistory({ viewType: 'local', path: '/Music' }); // New path

    assert.equal(tracker.historyStack.length, 3);
    assert.deepEqual(tracker.historyStack.map(s => s.path), ['/', '/Documents', '/Music']);
    assert.equal(tracker.canNavigateForward(), false);
  });

  test('verifies filebrowser.js source code contains mouse button 3 & 4 event handlers and navigation methods (#65)', () => {
    const filebrowserPath = path.join(__dirname, '../../public/js/filebrowser.js');
    const content = fs.readFileSync(filebrowserPath, 'utf8');

    assert.ok(content.includes('navigateBack'), 'filebrowser.js should implement navigateBack()');
    assert.ok(content.includes('navigateForward'), 'filebrowser.js should implement navigateForward()');
    assert.ok(content.includes('e.button === 3') || content.includes('button === 3'), 'filebrowser.js should handle Mouse Button 3 (Back)');
    assert.ok(content.includes('e.button === 4') || content.includes('button === 4'), 'filebrowser.js should handle Mouse Button 4 (Forward)');
  });
});

describe('Keyboard Shortcuts File Navigation (#29)', () => {
  class MockFileBrowser {
    constructor(items = []) {
      this.items = items;
      this.selectedItem = null;
      this.selectedPaths = new Set();
      this.internalClipboard = null;
      this.currentPath = '/';
      this.openedPath = null;
      this.deletedPaths = [];
      this.pastedPaths = [];
    }

    selectItemByIndex(index) {
      if (!this.items || this.items.length === 0) return;
      if (index < 0) index = 0;
      if (index >= this.items.length) index = this.items.length - 1;

      const item = this.items[index];
      this.clearSelection();
      this.selectedItem = item;
      this.selectedPaths.add(item.path);
    }

    selectNextItem() {
      if (!this.items || this.items.length === 0) return;
      let currentIndex = -1;
      if (this.selectedItem) {
        currentIndex = this.items.findIndex(i => i.path === this.selectedItem.path);
      }
      const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, this.items.length - 1);
      this.selectItemByIndex(nextIndex);
    }

    selectPreviousItem() {
      if (!this.items || this.items.length === 0) return;
      let currentIndex = -1;
      if (this.selectedItem) {
        currentIndex = this.items.findIndex(i => i.path === this.selectedItem.path);
      }
      const prevIndex = currentIndex < 0 ? this.items.length - 1 : Math.max(currentIndex - 1, 0);
      this.selectItemByIndex(prevIndex);
    }

    clearSelection() {
      this.selectedPaths.clear();
      this.selectedItem = null;
    }

    selectAll() {
      if (!this.items || this.items.length === 0) return;
      this.selectedPaths.clear();
      this.items.forEach(i => this.selectedPaths.add(i.path));
      if (this.items.length > 0) {
        this.selectedItem = this.items[0];
      }
    }

    copySelection() {
      let pathsToCopy = [];
      if (this.selectedPaths.size > 0) {
        pathsToCopy = Array.from(this.selectedPaths);
      } else if (this.selectedItem) {
        pathsToCopy = [this.selectedItem.path];
      }
      if (pathsToCopy.length > 0) {
        this.internalClipboard = {
          action: 'copy',
          paths: pathsToCopy,
          sourcePath: this.currentPath
        };
      }
      return pathsToCopy;
    }

    async pasteSelection() {
      if (!this.internalClipboard || !this.internalClipboard.paths || this.internalClipboard.paths.length === 0) return;
      const targetDir = this.currentPath;
      for (const srcPath of this.internalClipboard.paths) {
        const filename = srcPath.split('/').filter(Boolean).pop() || 'copied';
        const dstPath = targetDir === '/' ? `/${filename}` : `${targetDir}/${filename}`;
        this.pastedPaths.push({ src: srcPath, dst: dstPath });
      }
    }

    openSelectedItem() {
      if (!this.selectedItem && this.selectedPaths.size === 1) {
        const path = Array.from(this.selectedPaths)[0];
        this.selectedItem = this.items.find(i => i.path === path);
      }
      if (this.selectedItem) {
        this.openedPath = this.selectedItem.path;
      }
    }

    batchDelete() {
      if (this.selectedPaths.size > 0) {
        this.deletedPaths.push(...Array.from(this.selectedPaths));
        this.clearSelection();
      } else if (this.selectedItem) {
        this.deletedPaths.push(this.selectedItem.path);
        this.clearSelection();
      }
    }

    handleKeyDown(e) {
      if (e.target && ['input', 'textarea', 'select'].includes(e.target.tagName?.toLowerCase())) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (e.preventDefault) e.preventDefault();
        this.selectAll();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (e.preventDefault) e.preventDefault();
        this.copySelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (e.preventDefault) e.preventDefault();
        this.pasteSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.preventDefault) e.preventDefault();
        this.batchDelete();
        return;
      }
      if (e.key === 'Enter') {
        if (e.preventDefault) e.preventDefault();
        this.openSelectedItem();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        if (e.preventDefault) e.preventDefault();
        this.selectNextItem();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        if (e.preventDefault) e.preventDefault();
        this.selectPreviousItem();
        return;
      }
    }
  }

  test('navigates item selection with Arrow keys', () => {
    const items = [
      { name: 'Folder 1', path: '/Folder 1', isDirectory: true },
      { name: 'File 1.txt', path: '/File 1.txt', isDirectory: false },
      { name: 'File 2.txt', path: '/File 2.txt', isDirectory: false }
    ];
    const fb = new MockFileBrowser(items);

    fb.handleKeyDown({ key: 'ArrowDown' });
    assert.equal(fb.selectedItem.path, '/Folder 1');

    fb.handleKeyDown({ key: 'ArrowDown' });
    assert.equal(fb.selectedItem.path, '/File 1.txt');

    fb.handleKeyDown({ key: 'ArrowUp' });
    assert.equal(fb.selectedItem.path, '/Folder 1');
  });

  test('selects all items with Ctrl+A', () => {
    const items = [
      { name: 'a.txt', path: '/a.txt' },
      { name: 'b.txt', path: '/b.txt' }
    ];
    const fb = new MockFileBrowser(items);

    fb.handleKeyDown({ ctrlKey: true, key: 'a' });
    assert.equal(fb.selectedPaths.size, 2);
    assert.ok(fb.selectedPaths.has('/a.txt'));
    assert.ok(fb.selectedPaths.has('/b.txt'));
  });

  test('copies and pastes selection with Ctrl+C and Ctrl+V', async () => {
    const items = [{ name: 'doc.pdf', path: '/doc.pdf' }];
    const fb = new MockFileBrowser(items);

    fb.handleKeyDown({ key: 'ArrowDown' });
    fb.handleKeyDown({ ctrlKey: true, key: 'c' });
    assert.deepEqual(fb.internalClipboard.paths, ['/doc.pdf']);

    await fb.handleKeyDown({ ctrlKey: true, key: 'v' });
    assert.equal(fb.pastedPaths.length, 1);
    assert.equal(fb.pastedPaths[0].src, '/doc.pdf');
    assert.equal(fb.pastedPaths[0].dst, '/doc.pdf');
  });

  test('deletes selected item with Delete key', () => {
    const items = [{ name: 'temp.txt', path: '/temp.txt' }];
    const fb = new MockFileBrowser(items);

    fb.handleKeyDown({ key: 'ArrowDown' });
    fb.handleKeyDown({ key: 'Delete' });
    assert.deepEqual(fb.deletedPaths, ['/temp.txt']);
  });

  test('verifies filebrowser.js implements keyboard shortcut handlers (#29)', () => {
    const filebrowserPath = path.join(__dirname, '../../public/js/filebrowser.js');
    const content = fs.readFileSync(filebrowserPath, 'utf8');

    assert.ok(content.includes('selectNextItem'), 'filebrowser.js should implement selectNextItem()');
    assert.ok(content.includes('selectPreviousItem'), 'filebrowser.js should implement selectPreviousItem()');
    assert.ok(content.includes('selectAll'), 'filebrowser.js should implement selectAll()');
    assert.ok(content.includes('copySelection'), 'filebrowser.js should implement copySelection()');
    assert.ok(content.includes('pasteSelection'), 'filebrowser.js should implement pasteSelection()');
    assert.ok(content.includes('ArrowDown') || content.includes('ArrowUp'), 'filebrowser.js should handle Arrow keys');
  });
});

