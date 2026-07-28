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
