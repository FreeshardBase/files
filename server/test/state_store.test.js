const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { FileBrowserStore } = require('../../public/js/filebrowser.js');

describe('Issue #81: [ARCH-FSM] Unidirectional State Store & Multi-Pane Tab Separation', () => {
  let store;

  beforeEach(() => {
    store = new FileBrowserStore();
  });

  test('Initial state is correctly initialized in FSM state INITIALIZING or IDLE', () => {
    const state = store.getState();
    assert.ok(['INITIALIZING', 'IDLE'].includes(state.fsmState));
    assert.strictEqual(state.isSplitViewActive, false);
    assert.strictEqual(state.activePane, 'primary');
  });

  test('INIT_TABS sets tabs array and initial activeTabId', () => {
    store.dispatch('INIT_TABS', {
      tabs: [
        { id: 'tab1', title: 'Home', viewType: 'local', path: '/' },
        { id: 'tab2', title: 'Shared', viewType: 'shared', path: '/' }
      ],
      activeTabId: 'tab1'
    });

    const state = store.getState();
    assert.strictEqual(state.fsmState, 'IDLE');
    assert.strictEqual(state.tabs.length, 2);
    assert.strictEqual(state.activeTabId, 'tab1');
  });

  test('SWITCH_TAB updates global activeTabId and sets primary pane focus', () => {
    store.dispatch('INIT_TABS', {
      tabs: [
        { id: 'tab1', title: 'Home', viewType: 'local', path: '/' },
        { id: 'tab2', title: 'Shared', viewType: 'shared', path: '/' }
      ],
      activeTabId: 'tab1'
    });

    store.dispatch('SWITCH_TAB', { tabId: 'tab2' });
    const state = store.getState();

    assert.strictEqual(state.activeTabId, 'tab2');
    assert.strictEqual(state.primaryTabId, 'tab2');
    assert.strictEqual(state.activePane, 'primary');
  });

  test('SWITCH_TAB dispatches globally without secondary pane interception when split view is active', () => {
    store.dispatch('INIT_TABS', {
      tabs: [
        { id: 'tab1', title: 'Home', viewType: 'local', path: '/' },
        { id: 'tab2', title: 'Shared', viewType: 'shared', path: '/' },
        { id: 'tab3', title: 'Trash', viewType: 'trash', path: '/' }
      ],
      activeTabId: 'tab1'
    });

    // Activate Split View
    store.dispatch('TOGGLE_SPLIT_VIEW', { targetTab: store.getState().tabs[1] }); // secondaryTabId = tab2
    let state = store.getState();
    assert.strictEqual(state.isSplitViewActive, true);
    assert.strictEqual(state.secondaryTabId, 'tab2');
    assert.strictEqual(state.activePane, 'secondary');

    // Perform top-level tab switch to tab3 while secondary pane is focused
    store.dispatch('SWITCH_TAB', { tabId: 'tab3' });
    state = store.getState();

    // Must dispatch globally without secondary pane interception
    assert.strictEqual(state.activeTabId, 'tab3');
    assert.strictEqual(state.primaryTabId, 'tab3');
    assert.strictEqual(state.activePane, 'primary');
    // secondaryTabId must remain unchanged
    assert.strictEqual(state.secondaryTabId, 'tab2');
  });

  test('CREATE_TAB adds a new tab and activates it globally', () => {
    store.dispatch('INIT_TABS', {
      tabs: [{ id: 'tab1', title: 'Home', viewType: 'local', path: '/' }],
      activeTabId: 'tab1'
    });

    store.dispatch('CREATE_TAB', { title: 'Activity', viewType: 'activity', path: '/' });
    const state = store.getState();

    assert.strictEqual(state.tabs.length, 2);
    assert.strictEqual(state.tabs[1].title, 'Activity');
    assert.strictEqual(state.activeTabId, state.tabs[1].id);
  });

  test('CLOSE_TAB removes target tab and updates activeTabId fallback', () => {
    store.dispatch('INIT_TABS', {
      tabs: [
        { id: 'tab1', title: 'Home', viewType: 'local', path: '/' },
        { id: 'tab2', title: 'Shared', viewType: 'shared', path: '/' }
      ],
      activeTabId: 'tab2'
    });

    store.dispatch('CLOSE_TAB', { tabId: 'tab2' });
    const state = store.getState();

    assert.strictEqual(state.tabs.length, 1);
    assert.strictEqual(state.activeTabId, 'tab1');
  });

  test('SET_LOADING updates FSM state to LOADING and back to IDLE/SPLIT_VIEW', () => {
    store.dispatch('SET_LOADING', { isLoading: true });
    assert.strictEqual(store.getState().fsmState, 'LOADING');

    store.dispatch('SET_LOADING', { isLoading: false });
    assert.strictEqual(store.getState().fsmState, 'IDLE');
  });
});
