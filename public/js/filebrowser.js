class FileBrowserStore {
  constructor(initialState = {}) {
    this.state = {
      fsmState: 'INITIALIZING',
      tabs: [],
      activeTabId: null,
      isSplitViewActive: false,
      activePane: 'primary',
      primaryTabId: null,
      secondaryTabId: null,
      viewMode: 'grid',
      clickNavigationMode: 'double',
      isLoading: false,
      error: null,
      selectedPaths: new Set(),
      items: [],
      ...initialState
    };
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(action, payload = {}) {
    const prevState = { ...this.state };
    this.state = this.reducer(this.state, action, payload);
    this.notify(action, prevState);
  }

  notify(action, prevState) {
    for (const listener of this.listeners) {
      try {
        listener(this.state, action, prevState);
      } catch (err) {
        console.error('State store listener error:', err);
      }
    }
  }

  reducer(state, action, payload = {}) {
    switch (action) {
      case 'INIT_TABS': {
        const rawTabs = payload.tabs || state.tabs;
        const tabs = rawTabs.map(t => ({
          isSplitView: false,
          secondaryPath: '/',
          secondaryViewType: 'local',
          secondaryProviderId: null,
          secondaryProviderName: null,
          ...t
        }));
        const activeId = payload.activeTabId || (tabs[0] ? tabs[0].id : state.activeTabId);
        const activeTab = tabs.find(t => t.id === activeId) || tabs[0];
        return {
          ...state,
          tabs: tabs,
          activeTabId: activeId,
          primaryTabId: activeId,
          isSplitViewActive: activeTab ? !!activeTab.isSplitView : false,
          fsmState: activeTab && activeTab.isSplitView ? 'SPLIT_VIEW' : 'IDLE'
        };
      }
      case 'SWITCH_TAB': {
        const targetTab = state.tabs.find(t => t.id === payload.tabId);
        if (!targetTab) return state;
        const isSplit = !!targetTab.isSplitView;
        return {
          ...state,
          activeTabId: payload.tabId,
          primaryTabId: payload.tabId,
          activePane: 'primary',
          isSplitViewActive: isSplit,
          fsmState: isSplit ? 'SPLIT_VIEW' : 'IDLE'
        };
      }
      case 'CREATE_TAB': {
        const newId = payload.id || ('tab_' + Date.now() + '_' + Math.floor(Math.random() * 1000));
        const newTab = {
          id: newId,
          title: payload.title || 'Home',
          viewType: payload.viewType || 'local',
          path: payload.path || '/',
          providerId: payload.providerId || null,
          providerName: payload.providerName || null,
          isSplitView: false,
          secondaryPath: '/',
          secondaryViewType: 'local',
          secondaryProviderId: null,
          secondaryProviderName: null
        };
        const updatedTabs = [...state.tabs, newTab];
        return {
          ...state,
          tabs: updatedTabs,
          activeTabId: newId,
          primaryTabId: newId,
          activePane: 'primary',
          isSplitViewActive: false,
          fsmState: 'IDLE'
        };
      }
      case 'CLOSE_TAB': {
        if (state.tabs.length <= 1) {
          const firstTab = {
            ...state.tabs[0],
            title: 'Home',
            viewType: 'local',
            path: '/',
            providerId: null,
            providerName: null,
            isSplitView: false,
            secondaryPath: '/'
          };
          return {
            ...state,
            tabs: [firstTab],
            activeTabId: firstTab.id,
            primaryTabId: firstTab.id,
            isSplitViewActive: false
          };
        }
        const filteredTabs = state.tabs.filter(t => t.id !== payload.tabId);
        let nextActiveId = state.activeTabId;
        if (state.activeTabId === payload.tabId) {
          const closedIdx = state.tabs.findIndex(t => t.id === payload.tabId);
          const nextTab = filteredTabs[Math.max(0, closedIdx - 1)];
          nextActiveId = nextTab ? nextTab.id : filteredTabs[0].id;
        }
        const activeTab = filteredTabs.find(t => t.id === nextActiveId);
        const isSplit = activeTab ? !!activeTab.isSplitView : false;
        return {
          ...state,
          tabs: filteredTabs,
          activeTabId: nextActiveId,
          primaryTabId: nextActiveId,
          isSplitViewActive: isSplit
        };
      }
      case 'UPDATE_TAB_STATE': {
        const updatedTabs = state.tabs.map(t => {
          if (t.id === state.activeTabId) {
            if (payload.isSecondary || state.activePane === 'secondary') {
              return {
                ...t,
                secondaryPath: payload.path !== undefined ? payload.path : (payload.secondaryPath !== undefined ? payload.secondaryPath : t.secondaryPath),
                secondaryViewType: payload.viewType !== undefined ? payload.viewType : (payload.secondaryViewType !== undefined ? payload.secondaryViewType : t.secondaryViewType),
                secondaryProviderId: payload.providerId !== undefined ? payload.providerId : (payload.secondaryProviderId !== undefined ? payload.secondaryProviderId : t.secondaryProviderId),
                secondaryProviderName: payload.providerName !== undefined ? payload.providerName : (payload.secondaryProviderName !== undefined ? payload.secondaryProviderName : t.secondaryProviderName)
              };
            }
            return {
              ...t,
              title: payload.title !== undefined ? payload.title : t.title,
              viewType: payload.viewType !== undefined ? payload.viewType : t.viewType,
              path: payload.path !== undefined ? payload.path : t.path,
              providerId: payload.providerId !== undefined ? payload.providerId : t.providerId,
              providerName: payload.providerName !== undefined ? payload.providerName : t.providerName
            };
          }
          return t;
        });
        return {
          ...state,
          tabs: updatedTabs
        };
      }
      case 'REORDER_TABS':
        return {
          ...state,
          tabs: payload.tabs
        };
      case 'TOGGLE_SPLIT_VIEW': {
        const activeTab = state.tabs.find(t => t.id === state.activeTabId);
        if (!activeTab) return state;
        const nextSplit = !activeTab.isSplitView;
        const targetSecondaryId = (payload && payload.targetTab && payload.targetTab.id) ? payload.targetTab.id : ((payload && payload.targetTabId) ? payload.targetTabId : state.activeTabId);
        const updatedTabs = state.tabs.map(t => {
          if (t.id === state.activeTabId) {
            return {
              ...t,
              isSplitView: nextSplit,
              secondaryPath: t.secondaryPath || t.path || '/'
            };
          }
          return t;
        });
        return {
          ...state,
          tabs: updatedTabs,
          isSplitViewActive: nextSplit,
          primaryTabId: state.activeTabId,
          secondaryTabId: nextSplit ? targetSecondaryId : state.activeTabId,
          activePane: nextSplit ? 'secondary' : 'primary',
          fsmState: nextSplit ? 'SPLIT_VIEW' : 'IDLE'
        };
      }
      case 'SET_ACTIVE_PANE':
        return {
          ...state,
          activePane: payload.pane
        };
      case 'SET_SECONDARY_TAB':
        return {
          ...state,
          secondaryTabId: payload.tabId
        };
      case 'SET_VIEW_MODE':
        return {
          ...state,
          viewMode: payload.viewMode
        };
      case 'SET_LOADING':
        return {
          ...state,
          isLoading: payload.isLoading,
          fsmState: payload.isLoading ? 'LOADING' : (state.isSplitViewActive ? 'SPLIT_VIEW' : 'IDLE')
        };
      case 'SET_ERROR':
        return {
          ...state,
          error: payload.error,
          fsmState: payload.error ? 'ERROR' : 'IDLE'
        };
      default:
        return state;
    }
  }
}

class FileBrowser {
  constructor(initialViewMode = 'grid') {
    this.currentPath = '/';
    this.currentViewType = 'local'; // 'local', 'shared', 'trash', or 'activity'
    this.currentTrashId = null;
    this.currentTrashSubpath = '/';
    this.viewMode = localStorage.getItem('fs-view-mode') || initialViewMode || 'grid';
    this.clickNavigationMode = localStorage.getItem('fs-click-mode') || 'double';
    this.items = [];
    this.selectedItem = null;
    this.selectedPaths = new Set(); // Multi-select state (#12)

    this.container = document.getElementById('fileContainer');
    this.breadcrumb = document.getElementById('breadcrumb');
    this.contentArea = document.getElementById('contentArea');
    this.dropOverlay = document.getElementById('dropOverlay');
    this.contextMenu = document.getElementById('contextMenu');

    // Media Viewer Elements (#11)
    this.mediaModal = document.getElementById('modalMediaViewer');
    this.mediaTitle = document.getElementById('mediaTitle');
    this.mediaViewerBody = document.getElementById('mediaViewerBody');
    this.currentMediaItem = null;

    // Multi-Select Elements (#12)
    this.selectionActionBar = document.getElementById('selectionActionBar');
    this.selectedCountText = document.getElementById('selectedCountText');

    this.isInternalDragging = false; // Drag & Drop file move state (#50)
    this.activeDragPayload = null; // Drag payload fallback for DOM re-renders (#50, #59)
    this.springLoadTimer = null; // Spring-loaded folder hover timer (#59)
    this.springLoadTarget = null;

    // Multi-Tab UI System (#60) & Unidirectional FSM Store (#81)
    this.tabs = [];
    this.activeTabId = null;

    this.store = new FileBrowserStore({
      viewMode: this.viewMode,
      clickNavigationMode: this.clickNavigationMode
    });
    this.store.subscribe((state) => {
      this.activeTabId = state.activeTabId;
      this.tabs = state.tabs;
      this.isSplitViewActive = state.isSplitViewActive;
      this.activePane = state.activePane;
      this.primaryTabId = state.primaryTabId;
      this.secondaryTabId = state.secondaryTabId;
    });

    // Mouse Side-Button Folder History Navigation (#65)
    this.historyStack = [];
    this.historyIndex = -1;
    this.internalClipboard = null;

    this.init();
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
    if (!this.canNavigateBack()) return false;
    this.historyIndex--;
    const state = this.historyStack[this.historyIndex];
    this.restoreHistoryState(state);
    return true;
  }

  navigateForward() {
    if (!this.canNavigateForward()) return false;
    this.historyIndex++;
    const state = this.historyStack[this.historyIndex];
    this.restoreHistoryState(state);
    return true;
  }

  restoreHistoryState(state) {
    if (!state) return;
    if (state.viewType === 'provider' && state.providerId) {
      this.loadProviderDirectory(state.providerId, state.providerName, state.path || '/', false, true);
    } else if (state.viewType === 'shared') {
      this.loadSharedWithMe(false, true);
    } else if (state.viewType === 'trash') {
      this.loadTrash(state.trashId || null, state.trashSubpath || '/', false, true);
    } else if (state.viewType === 'activity') {
      this.loadActivity(false, true);
    } else {
      this.loadDirectory(state.path || '/', false, true);
    }
  }

  clearSpringLoadTimer() {
    if (this.springLoadTimer) {
      clearTimeout(this.springLoadTimer);
      this.springLoadTimer = null;
    }
    if (this.springLoadTarget) {
      this.springLoadTarget.classList.remove('drag-spring-loading');
      this.springLoadTarget = null;
    }
  }

  init() {
    this.checkOAuthCallback();
    this.setupEventListeners();
    this.loadUserPreferences();
    this.loadSidebarProviders();
    this.loadTabsFromSession();

    const activeTab = this.getActiveTab();
    if (activeTab) {
      this.switchTab(activeTab.id);
    } else {
      this.loadDirectory(this.currentPath);
    }
  }

  async loadUserPreferences() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        if (data && data.authenticated && data.user && data.user.preferredClickMode) {
          this.clickNavigationMode = data.user.preferredClickMode;
          localStorage.setItem('fs-click-mode', data.user.preferredClickMode);
        }
      }
    } catch (e) {}
  }

  // ── Multi-Tab Session & State Management (#60) ───────────────────────────
  loadTabsFromSession() {
    try {
      const stored = sessionStorage.getItem('fs_ui_tabs');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          this.tabs = parsed.tabs;
          this.activeTabId = parsed.activeTabId || this.tabs[0].id;
          this.store.dispatch('INIT_TABS', { tabs: this.tabs, activeTabId: this.activeTabId });
          return;
        }
      }
    } catch (e) {}

    const defaultTab = {
      id: 'tab_' + Date.now(),
      title: 'Home',
      icon: '🏠',
      viewType: 'local',
      path: '/',
      providerId: null,
      providerName: null
    };
    this.tabs = [defaultTab];
    this.activeTabId = defaultTab.id;
    this.store.dispatch('INIT_TABS', { tabs: this.tabs, activeTabId: this.activeTabId });
    this.saveTabsToSession();
  }

  saveTabsToSession() {
    try {
      sessionStorage.setItem('fs_ui_tabs', JSON.stringify({
        tabs: this.tabs,
        activeTabId: this.activeTabId
      }));
    } catch (e) {}
  }

  getActiveTab() {
    return this.tabs.find(t => t.id === this.activeTabId) || this.tabs[0];
  }

  getTabIconHtml(tab, size = 14) {
    if (!tab) return '🏠';
    if (tab.viewType === 'provider') {
      const pName = (tab.providerName || '').toLowerCase();
      if (pName.includes('dropbox')) {
        return this.getProviderIconSvg('dropbox', size);
      }
      if (pName.includes('gdrive') || pName.includes('google')) {
        return this.getProviderIconSvg('gdrive', size);
      }
      if (pName.includes('s3') || pName.includes('minio') || pName.includes('wasabi')) {
        return this.getProviderIconSvg('s3', size);
      }
      if (pName.includes('moveit') || pName.includes('sftp')) {
        return this.getProviderIconSvg('moveit', size);
      }
      return this.getProviderIconSvg('cloud', size);
    }
    if (tab.viewType === 'shared') return '🔗';
    if (tab.viewType === 'trash') return '🗑️';
    if (tab.viewType === 'activity') return '🕒';
    if (tab.viewType === 'smart_folder') return '🔍';
    if (tab.viewType === 'favorites') return '⭐';
    return '🏠';
  }

  updateActiveTabState(title, viewType, path, providerId = null, providerName = null) {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    activeTab.title = title;
    activeTab.viewType = viewType;
    activeTab.path = path;
    activeTab.providerId = providerId;
    activeTab.providerName = providerName;
    this.saveTabsToSession();
    this.renderTabBar();
  }

  createTab(viewType = 'local', path = '/', providerId = null, providerName = null) {
    const newId = 'tab_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    let title = 'Home';
    if (viewType === 'provider') {
      title = providerName || 'Cloud Drive';
    } else if (viewType === 'shared') {
      title = 'Shared';
    } else if (viewType === 'trash') {
      title = 'Trash';
    } else if (viewType === 'activity') {
      title = 'Activity';
    }

    this.store.dispatch('CREATE_TAB', {
      id: newId,
      title,
      viewType,
      path,
      providerId,
      providerName
    });
    this.switchTab(newId);
  }

  switchTab(tabId) {
    const targetTab = this.tabs.find(t => t.id === tabId);
    if (!targetTab) return;

    this.store.dispatch('SWITCH_TAB', { tabId });

    const wrapper = document.getElementById('panesWrapper');
    const secPane = document.getElementById('secondaryPane');
    const btn = document.getElementById('btnToggleSplitView');

    const isSplit = !!targetTab.isSplitView;
    if (wrapper) wrapper.classList.toggle('split-view-active', isSplit);
    if (secPane) secPane.style.display = isSplit ? 'flex' : 'none';
    if (btn) btn.classList.toggle('active', isSplit);

    this.saveTabsToSession();

    if (targetTab.viewType === 'provider' && targetTab.providerId) {
      this.loadProviderDirectory(targetTab.providerId, targetTab.providerName, targetTab.path, false);
    } else if (targetTab.viewType === 'shared') {
      this.loadSharedWithMe(false);
    } else if (targetTab.viewType === 'trash') {
      this.loadTrash(false);
    } else if (targetTab.viewType === 'activity') {
      this.loadActivity(false);
    } else {
      this.loadDirectory(targetTab.path || '/', false);
    }

    if (isSplit) {
      this.loadSecondaryDirectory(
        targetTab.secondaryPath || '/',
        targetTab.secondaryViewType || 'local',
        targetTab.secondaryProviderId || null,
        targetTab.secondaryProviderName || null
      );
    }

    this.renderTabBar();
  }

  closeTab(tabId, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    this.store.dispatch('CLOSE_TAB', { tabId });
    this.saveTabsToSession();
    const activeTab = this.getActiveTab();
    if (activeTab) {
      this.switchTab(activeTab.id);
    }
  }

  renderTabBar() {
    const barList = document.getElementById('tabBarList');
    if (!barList) return;

    barList.innerHTML = this.tabs.map(tab => {
      const isActive = tab.id === this.activeTabId;
      const iconHtml = this.getTabIconHtml(tab, 14);
      return `
        <div class="tab-item ${isActive ? 'active' : ''}" data-tab-id="${tab.id}">
          <span class="tab-icon">${iconHtml}</span>
          <span class="tab-title" title="${tab.title}">${tab.title}</span>
          <button class="tab-close" data-close-tab-id="${tab.id}" title="Tab schließen">&times;</button>
        </div>
      `;
    }).join('');

    barList.querySelectorAll('.tab-item').forEach(el => {
      const id = el.getAttribute('data-tab-id');
      const tabObj = this.tabs.find(t => t.id === id);

      el.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) return;
        this.switchTab(id);
      });

      const closeBtn = el.querySelector('.tab-close');
      closeBtn?.addEventListener('click', (e) => {
        this.closeTab(id, e);
      });

      // Tab Context Menu Right-Click Handler (#61)
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showTabContextMenu(e.clientX, e.clientY, tabObj);
      });

      // Touch long-press gesture for mobile tab context menu (#85)
      let tabTouchTimer = null;
      let tStartX = 0, tStartY = 0;
      el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || e.target.closest('.tab-close')) return;
        tStartX = e.touches[0].clientX;
        tStartY = e.touches[0].clientY;
        tabTouchTimer = setTimeout(() => {
          this.showTabContextMenu(tStartX, tStartY, tabObj);
        }, 500);
      }, { passive: true });

      el.addEventListener('touchmove', (e) => {
        if (!tabTouchTimer) return;
        const touch = e.touches[0];
        if (Math.hypot(touch.clientX - tStartX, touch.clientY - tStartY) > 10) {
          clearTimeout(tabTouchTimer);
          tabTouchTimer = null;
        }
      }, { passive: true });

      el.addEventListener('touchend', () => {
        if (tabTouchTimer) { clearTimeout(tabTouchTimer); tabTouchTimer = null; }
      });
      el.addEventListener('touchcancel', () => {
        if (tabTouchTimer) { clearTimeout(tabTouchTimer); tabTouchTimer = null; }
      });

      // Interactive Tab Drag-to-Reorder (#69)
      el.setAttribute('draggable', 'true');

      el.addEventListener('dragstart', (e) => {
        if (e.target.closest('.tab-close')) return;
        this.draggingTabId = id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `tab_reorder:${id}`);
        }
      });

      // Cross-Tab Drag & Drop Target & Tab Reorder (#60, #69)
      el.addEventListener('dragover', (e) => {
        if (this.draggingTabId && this.draggingTabId !== id) {
          e.preventDefault();
          e.stopPropagation();
          el.classList.add('drag-tab-over');
          return;
        }

        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-target-hover');

        if (this.springLoadTarget !== el) {
          this.clearSpringLoadTimer();
          this.springLoadTarget = el;
          el.classList.add('drag-spring-loading');
          this.springLoadTimer = setTimeout(() => {
            this.clearSpringLoadTimer();
            if (this.isInternalDragging || this.activeDragPayload) {
              this.switchTab(id);
            }
          }, 750);
        }
      });

      el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-tab-over');
        el.classList.remove('drag-target-hover');
        if (!this.draggingTabId) this.clearSpringLoadTimer();
      });

      el.addEventListener('drop', async (e) => {
        if (this.draggingTabId) {
          e.preventDefault();
          e.stopPropagation();
          el.classList.remove('drag-tab-over');

          const fromIdx = this.tabs.findIndex(t => t.id === this.draggingTabId);
          const toIdx = this.tabs.findIndex(t => t.id === id);
          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const reordered = [...this.tabs];
            const [movedTab] = reordered.splice(fromIdx, 1);
            reordered.splice(toIdx, 0, movedTab);
            this.store.dispatch('REORDER_TABS', { tabs: reordered });
            this.saveTabsToSession();
            this.renderTabBar();
          }
          this.draggingTabId = null;
          return;
        }

        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();

        let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
        let data = null;
        if (rawData) {
          try { data = JSON.parse(rawData); } catch(err){}
        }
        if (!data) data = this.activeDragPayload;
        if (!data || !tabObj) return;

        try {
          const payload = data;
          this.activeDragPayload = null;
          this.isInternalDragging = false;
          const targetDir = tabObj.path || '/';
          const targetProvId = tabObj.viewType === 'provider' ? tabObj.providerId : null;
          await this.handleDragDropMove(payload, targetDir, targetProvId);
          this.switchTab(id);
        } catch (err) {
          console.error('Cross-Tab Drop Error:', err);
          alert(`Move failed: ${err.message}`);
        }
      });
    });
  }

  async checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const connId = urlParams.get('connection_id');
    if (urlParams.get('gdrive_connected') === 'true' || urlParams.get('dropbox_connected') === 'true') {
      window.history.replaceState({}, document.title, window.location.pathname);
      await this.loadSidebarProviders();
      if (connId) {
        this.openShareReconciliationWizard(connId);
      }
    }
  }

  getProviderIconSvg(providerType, size = 18) {
    if (providerType === 'gdrive') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; flex-shrink: 0;"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.2-2.1 7.4-12.8c.8-1.4 1.2-2.95 1.2-4.5h-27.5l6.85 11.85z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.95-1.2-4.5-1.2h-18.5c-1.55 0-3.15.4-4.5 1.2z" fill="#00832d"/><path d="m59.8 50h27.5c0-1.55-.4-3.1-1.2-4.5l-13.75-23.8c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8z" fill="#ffba00"/><path d="m27.5 50 13.75 23.8c1.35.8 2.95 1.2 4.5 1.2h27.5c1.55 0 3.15-.4 4.5-1.2l-13.75-23.8z" fill="#2684fc"/></svg>`;
    }
    if (providerType === 'dropbox') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#0061FF" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; flex-shrink: 0;"><path d="M6 2L0 6l6 4 6-4-6-4zm12 0l-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4l-6 4 6 4 6-4-6-4zM6 19.5l6 4 6-4-6-3.5-6 3.5z"/></svg>`;
    }
    if (providerType === 's3' || providerType === 'minio' || providerType === 'wasabi') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; flex-shrink: 0;"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;
    }
    if (providerType === 'moveit' || providerType === 'sftp') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; flex-shrink: 0;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; flex-shrink: 0;"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
  }

  async updateProviderQuotas() {
    try {
      const res = await fetch('/api/providers/quota');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.quotas) return;

      data.quotas.forEach(q => {
        const container = document.getElementById(`quota_provider_${q.connectionId}`);
        if (!container) return;

        const fillEl = container.querySelector('.sidebar-quota-fill, .quota-progress-fill');
        const textEl = container.querySelector('.sidebar-quota-text, .quota-text');

        if (q.error) {
          if (textEl) textEl.textContent = 'Fehler beim Laden';
          return;
        }

        const pct = q.percent !== null ? q.percent : 0;
        if (fillEl) {
          fillEl.style.width = `${pct}%`;
          if (pct >= 90) fillEl.classList.add('high-usage');
          else fillEl.classList.remove('high-usage');
        }

        if (textEl) {
          const usedStr = this.formatSize(q.used || 0);
          const totalStr = q.total ? this.formatSize(q.total) : 'Unbegrenzt';
          textEl.textContent = `${usedStr} / ${totalStr} (${pct}%)`;
        }
      });
    } catch (e) {}
  }

  async loadSidebarProviders() {
    const listEl = document.getElementById('sidebarProvidersList');
    const headerEl = document.getElementById('sectionExternalStorageHeader');
    if (!listEl) return;

    try {
      const res = await fetch('/api/providers/connections');
      if (!res.ok) return;

      const data = await res.json();
      const connections = data.connections || [];

      if (headerEl) headerEl.style.display = 'flex';

      if (connections.length === 0) {
        listEl.innerHTML = `<li style="padding: 4px var(--space-3); font-size: 11px; color: var(--ink-muted); font-family: var(--font-mono);">Keine Konten verbunden</li>`;
        return;
      }

      listEl.innerHTML = connections.map(conn => {
        const icon = this.getProviderIconSvg(conn.provider_type, 18);
        const name = conn.display_name || (conn.provider_type === 'gdrive' ? 'Google Drive' : 'Dropbox');
        const isActive = this.currentViewType === 'provider' && this.currentProviderId === String(conn.id);
        const isEnabled = conn.enabled !== 0;

        return `
          <li class="nav-item ${isActive ? 'active' : ''} ${!isEnabled ? 'disabled-provider' : ''}" id="navProvider_${conn.id}" data-id="${conn.id}" data-type="${conn.provider_type}" data-name="${name}" style="${!isEnabled ? 'opacity: 0.6;' : ''}">
            <a href="#/provider/${conn.id}" style="flex-direction: column; align-items: flex-start; gap: 4px;">
              <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
                <span class="nav-icon" style="display: flex; align-items: center; justify-content: center;">${icon}</span>
                <span class="fs-label" style="text-transform: none; letter-spacing: normal; flex: 1;">${name} ${!isEnabled ? '<small style="font-size: 10px; color: var(--ink-muted);">(Entkoppelt)</small>' : ''}</span>
              </div>
              <div class="sidebar-quota-container" id="quota_provider_${conn.id}" style="width: 100%;">
                <div class="sidebar-quota-bar quota-progress-bar">
                  <div class="sidebar-quota-fill quota-progress-fill" style="width: 0%;"></div>
                </div>
                <span class="sidebar-quota-text quota-text">Speicher wird geladen...</span>
              </div>
            </a>
          </li>
        `;
      }).join('');

      this.updateProviderQuotas();

      // Add click, ContextMenu & Drag and Drop event listeners to each sidebar provider item
      connections.forEach(conn => {
        const navEl = document.getElementById(`navProvider_${conn.id}`);
        if (!navEl) return;

        const name = conn.display_name || (conn.provider_type === 'gdrive' ? 'Google Drive' : 'Dropbox');

        navEl.addEventListener('click', (e) => {
          e.preventDefault();
          if (conn.enabled === 0) {
            if (confirm(`"${name}" ist aktuell entkoppelt. Möchtest du diesen Cloud-Speicher wieder aktivieren?`)) {
              this.reconnectProvider(conn.id);
            }
            return;
          }
          document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
          navEl.classList.add('active');
          this.loadProviderDirectory(conn.id, name, '/');
        });

        navEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showProviderContextMenu(e.clientX, e.clientY, conn);
        });

        // Sidebar Provider Drag & Drop target for direct cross-storage uploads/moves (#50, #56, #59)
        navEl.addEventListener('dragover', (e) => {
          if (!this.isInternalDragging && !this.activeDragPayload) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          navEl.classList.add('drag-target-hover');

          if (this.springLoadTarget !== navEl) {
            this.clearSpringLoadTimer();
            this.springLoadTarget = navEl;
            navEl.classList.add('drag-spring-loading');
            this.springLoadTimer = setTimeout(() => {
              this.clearSpringLoadTimer();
              if (this.isInternalDragging || this.activeDragPayload) {
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                navEl.classList.add('active');
                this.loadProviderDirectory(conn.id, name, '/');
              }
            }, 750);
          }
        });

        navEl.addEventListener('dragleave', (e) => {
          e.preventDefault();
          e.stopPropagation();
          navEl.classList.remove('drag-target-hover');
          this.clearSpringLoadTimer();
        });

        navEl.addEventListener('drop', async (e) => {
          if (!this.isInternalDragging && !this.activeDragPayload) return;
          e.preventDefault();
          e.stopPropagation();
          navEl.classList.remove('drag-target-hover');
          this.clearSpringLoadTimer();

          let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
          let data = null;
          if (rawData) {
            try { data = JSON.parse(rawData); } catch(err){}
          }
          if (!data) data = this.activeDragPayload;
          if (!data) return;

          try {
            const payload = data;
            this.activeDragPayload = null;
            this.isInternalDragging = false;
            await this.handleDragDropMove(payload, '/', conn.id);
          } catch (err) {
            console.error('Sidebar Provider Drop Error:', err);
            alert(`Move failed: ${err.message}`);
          }
        });
      });
    } catch (err) {
      console.error('Failed to load sidebar provider connections:', err);
    }
  }

  setupEventListeners() {
    // Global Event Delegation: Modal Overlay Backdrop & Close Buttons (#72)
    document.addEventListener('click', (e) => {
      if (e.target.closest('#btnImportUrl')) {
        const menu = document.getElementById('uploadDropdownMenu');
        if (menu) menu.style.display = 'none';
        const modal = document.getElementById('modalUrlImport');
        if (modal) modal.style.display = 'flex';
        return;
      }
      if (e.target.matches('.modal-close, .fs-modal-close, [data-dismiss="modal"]')) {
        const modal = e.target.closest('.modal, .fs-modal-overlay, .media-viewer-modal');
        if (modal) {
          modal.style.display = 'none';
        }
      } else if (e.target.classList.contains('modal') || e.target.classList.contains('fs-modal-overlay')) {
        e.target.style.display = 'none';
      }
    });

    // Settings Modal Navigation & Preference Persistence (#68)
    const navSettingsEl = document.getElementById('navSettings');
    if (navSettingsEl) {
      navSettingsEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const selectClickMode = document.getElementById('selectClickMode');
        const inputDisplayName = document.getElementById('inputDisplayName');
        const selectLanguage = document.getElementById('selectLanguage');
        const selectTheme = document.getElementById('selectTheme');

        if (selectClickMode) {
          selectClickMode.value = this.clickNavigationMode || 'double';
        }

        try {
          const res = await fetch('/api/auth/me');
          if (res.ok) {
            const data = await res.json();
            if (data && data.authenticated && data.user) {
              if (inputDisplayName) inputDisplayName.value = data.user.displayName || '';
              if (selectLanguage) selectLanguage.value = data.user.preferredLocale || 'en';
              if (selectTheme) selectTheme.value = data.user.preferredTheme || 'dark';
            }
          }
        } catch (err) {}

        this.loadAppPasswords();
        this.showModal('modalSettings');
      });
    }

    const btnSettingsClose = document.getElementById('btnSettingsClose');
    const btnSettingsCancel = document.getElementById('btnSettingsCancel');
    const btnSettingsSave = document.getElementById('btnSettingsSave');
    const btnCreateAppPassword = document.getElementById('btnCreateAppPassword');

    if (btnSettingsClose) btnSettingsClose.addEventListener('click', () => this.hideModal('modalSettings'));
    if (btnSettingsCancel) btnSettingsCancel.addEventListener('click', () => this.hideModal('modalSettings'));
    if (btnCreateAppPassword) {
      btnCreateAppPassword.addEventListener('click', async () => {
        const inputLabel = document.getElementById('inputAppPasswordLabel');
        const label = inputLabel ? inputLabel.value.trim() : '';
        if (!label) return;
        try {
          const res = await fetch('/api/auth/app-passwords', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label })
          });
          if (res.ok) {
            const data = await res.json();
            if (inputLabel) inputLabel.value = '';
            alert(`App Password Created for "${label}":\n\n${data.password}\n\nPlease copy it now. It will not be shown again.`);
            this.loadAppPasswords();
          }
        } catch (e) {}
      });
    }

    if (btnSettingsSave) {
      btnSettingsSave.addEventListener('click', async () => {
        const selectClickMode = document.getElementById('selectClickMode');
        const inputDisplayName = document.getElementById('inputDisplayName');
        const selectLanguage = document.getElementById('selectLanguage');
        const selectTheme = document.getElementById('selectTheme');

        const mode = selectClickMode ? selectClickMode.value : 'double';
        const displayName = inputDisplayName ? inputDisplayName.value : undefined;
        const preferredLocale = selectLanguage ? selectLanguage.value : undefined;
        const preferredTheme = selectTheme ? selectTheme.value : undefined;

        this.clickNavigationMode = mode;
        localStorage.setItem('fs-click-mode', mode);

        try {
          await fetch('/api/auth/users/me', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              preferredClickMode: mode,
              displayName: displayName,
              preferredLocale: preferredLocale,
              preferredTheme: preferredTheme
            })
          });
        } catch (e) {}
        this.hideModal('modalSettings');
        this.render();
      });
    }

    // Mouse Side-Button Folder History Navigation (#65)
    const handleMouseNav = (e) => {
      if (e.button === 3) {
        e.preventDefault();
        this.navigateBack();
      } else if (e.button === 4) {
        e.preventDefault();
        this.navigateForward();
      }
    };
    window.addEventListener('mouseup', handleMouseNav);
    window.addEventListener('pointerup', (e) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    });

    // Multi-Tab New Tab Button Drag & Drop & Spring Loading (#60)
    const btnNewTabEl = document.getElementById('btnNewTab');
    if (btnNewTabEl) {
      btnNewTabEl.addEventListener('click', () => this.createTab('local', '/'));

      btnNewTabEl.addEventListener('dragover', (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        btnNewTabEl.classList.add('drag-target-hover');

        if (this.springLoadTarget !== btnNewTabEl) {
          this.clearSpringLoadTimer();
          this.springLoadTarget = btnNewTabEl;
          btnNewTabEl.classList.add('drag-spring-loading');
          this.springLoadTimer = setTimeout(() => {
            this.clearSpringLoadTimer();
            if (this.isInternalDragging || this.activeDragPayload) {
              this.createTab('local', '/');
            }
          }, 750);
        }
      });

      btnNewTabEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btnNewTabEl.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();
      });

      btnNewTabEl.addEventListener('drop', async (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        btnNewTabEl.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();

        let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
        let data = null;
        if (rawData) {
          try { data = JSON.parse(rawData); } catch(err){}
        }
        if (!data) data = this.activeDragPayload;
        if (!data) return;

        try {
          const payload = data;
          this.activeDragPayload = null;
          this.isInternalDragging = false;
          this.createTab('local', '/');
          await this.handleDragDropMove(payload, '/');
        } catch (err) {
          console.error('New Tab Drop Error:', err);
          alert(`Move failed: ${err.message}`);
        }
      });
    }

    // View Toggle
    document.getElementById('btnGridView')?.addEventListener('click', () => this.setViewMode('grid'));
    document.getElementById('btnListView')?.addEventListener('click', () => this.setViewMode('list'));

    // Dual-Pane Split View (#61)
    document.getElementById('btnToggleSplitView')?.addEventListener('click', () => this.toggleSplitView());
    document.getElementById('btnCloseSecondaryPane')?.addEventListener('click', () => this.toggleSplitView());

    document.getElementById('primaryPane')?.addEventListener('click', () => {
      if (this.isSplitViewActive) this.setActivePane('primary');
    });

    document.getElementById('secondaryPane')?.addEventListener('click', () => {
      if (this.isSplitViewActive) this.setActivePane('secondary');
    });

    // Tab Context Menu Event Handlers (#61, #69)
    document.getElementById('ctxTabSplitRight')?.addEventListener('click', () => {
      this.hideTabContextMenu();
      if (this.selectedTabForContext) {
        this.toggleSplitView(this.selectedTabForContext);
      }
    });

    document.getElementById('ctxTabDuplicate')?.addEventListener('click', () => {
      this.hideTabContextMenu();
      if (this.selectedTabForContext) {
        this.createTab(
          this.selectedTabForContext.viewType,
          this.selectedTabForContext.path,
          this.selectedTabForContext.providerId,
          this.selectedTabForContext.providerName
        );
      }
    });

    document.getElementById('ctxTabClose')?.addEventListener('click', () => {
      this.hideTabContextMenu();
      if (this.selectedTabForContext) {
        this.closeTab(this.selectedTabForContext.id);
      }
    });

    // Provider Context Menu Event Handlers (#58)
    document.getElementById('ctxProviderToggleState')?.addEventListener('click', () => {
      this.hideProviderContextMenu();
      if (this.selectedProviderForContext) {
        const pName = this.selectedProviderForContext.display_name || 'Cloud Storage';
        if (this.selectedProviderForContext.enabled !== 0) {
          this.disconnectProvider(this.selectedProviderForContext.id, pName);
        } else {
          this.reconnectProvider(this.selectedProviderForContext.id);
        }
      }
    });

    document.getElementById('ctxProviderDelete')?.addEventListener('click', () => {
      this.hideProviderContextMenu();
      if (this.selectedProviderForContext) {
        const pName = this.selectedProviderForContext.display_name || 'Cloud Storage';
        this.deleteProviderPermanently(this.selectedProviderForContext.id, pName);
      }
    });

    document.addEventListener('click', () => {
      this.hideTabContextMenu();
      this.hideProviderContextMenu();
    });

    // Upload Engine Event Listeners (#77)
    document.getElementById('fileInput')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));
    document.getElementById('fileInputOption')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));
    document.getElementById('folderInput')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));

    // Split Upload Dropdown Toggle (#77)
    const btnUploadDropdownToggle = document.getElementById('btnUploadDropdownToggle');
    const uploadDropdownMenu = document.getElementById('uploadDropdownMenu');
    if (btnUploadDropdownToggle && uploadDropdownMenu) {
      btnUploadDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = uploadDropdownMenu.style.display === 'block';
        uploadDropdownMenu.style.display = isVisible ? 'none' : 'block';
      });
      document.addEventListener('click', (e) => {
        if (!uploadDropdownMenu.contains(e.target) && e.target !== btnUploadDropdownToggle) {
          uploadDropdownMenu.style.display = 'none';
        }
      });
    }

    // Multi-Source Options: Files, Folder, URL Import (#77)
    document.getElementById('btnUploadFiles')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (uploadDropdownMenu) uploadDropdownMenu.style.display = 'none';
      document.getElementById('fileInputOption')?.click();
    });
    document.getElementById('btnUploadFolder')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (uploadDropdownMenu) uploadDropdownMenu.style.display = 'none';
      document.getElementById('folderInput')?.click();
    });
    document.getElementById('btnImportUrl')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('uploadDropdownMenu');
      if (menu) menu.style.display = 'none';
      this.showModal('modalUrlImport');
    });

    // URL Import Modal Form Handlers (#77)
    document.getElementById('btnCloseUrlImportModal')?.addEventListener('click', () => this.hideModal('modalUrlImport'));
    document.getElementById('btnCancelUrlImport')?.addEventListener('click', () => this.hideModal('modalUrlImport'));
    document.getElementById('formUrlImport')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleUrlImportSubmit();
    });

    // Floating Upload Queue Close (#77)
    document.getElementById('btnCloseUploadQueue')?.addEventListener('click', () => {
      const queueEl = document.getElementById('uploadProgressQueue');
      if (queueEl) queueEl.style.display = 'none';
    });

    // Connect Cloud Storage Modal (#7, #56)
    document.getElementById('btnAddCloudDrive')?.addEventListener('click', () => {
      this.showModal('modalAddProvider');
    });
    document.getElementById('btnCancelAddProvider')?.addEventListener('click', () => {
      this.hideModal('modalAddProvider');
    });

    // Sidebar Navigation (#14, #18, #22, #50, #56)
    const navHomeEl = document.getElementById('navHome');
    if (navHomeEl) {
      navHomeEl.addEventListener('click', (e) => {
        e.preventDefault();
        this.currentViewType = 'local';
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        navHomeEl.classList.add('active');
        this.loadDirectory('/');
      });

      // Sidebar Home Drag & Drop target (move cloud files back to Home /)
      navHomeEl.addEventListener('dragover', (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        navHomeEl.classList.add('drag-target-hover');

        if (this.springLoadTarget !== navHomeEl) {
          this.clearSpringLoadTimer();
          this.springLoadTarget = navHomeEl;
          navHomeEl.classList.add('drag-spring-loading');
          this.springLoadTimer = setTimeout(() => {
            this.clearSpringLoadTimer();
            if (this.isInternalDragging || this.activeDragPayload) {
              this.currentViewType = 'local';
              document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
              navHomeEl.classList.add('active');
              this.loadDirectory('/');
            }
          }, 750);
        }
      });

      navHomeEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navHomeEl.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();
      });

      navHomeEl.addEventListener('drop', async (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        navHomeEl.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();

        let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
        let data = null;
        if (rawData) {
          try { data = JSON.parse(rawData); } catch(err){}
        }
        if (!data) data = this.activeDragPayload;
        if (!data) return;

        try {
          const payload = data;
          this.activeDragPayload = null;
          this.isInternalDragging = false;
          await this.handleDragDropMove(payload, '/');
        } catch (err) {
          console.error('Sidebar Home Drop Error:', err);
          alert(`Move failed: ${err.message}`);
        }
      });
    }

    document.getElementById('navShared')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.currentViewType = 'shared';
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('navShared')?.classList.add('active');
      this.loadSharedWithMe();
    });

    document.getElementById('navTrash')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.currentViewType = 'trash';
      this.currentTrashId = null;
      this.currentTrashSubpath = '/';
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('navTrash')?.classList.add('active');
      this.loadTrash();
    });

    document.getElementById('navActivity')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.currentViewType = 'activity';
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('navActivity')?.classList.add('active');
      this.loadActivity();
    });

    document.getElementById('btnEmptyTrash')?.addEventListener('click', () => this.emptyTrash());

    // New Folder Modal
    document.getElementById('btnNewFolder')?.addEventListener('click', () => this.showModal('modalNewFolder'));
    document.getElementById('btnCancelNewFolder')?.addEventListener('click', () => this.hideModal('modalNewFolder'));
    document.getElementById('btnConfirmNewFolder')?.addEventListener('click', () => this.createFolder());

    // Smart Folder Modal (#46, #73)
    document.getElementById('btnNewSmartFolder')?.addEventListener('click', () => this.showModal('modalSmartFolder'));
    document.getElementById('btnCancelSmartFolder')?.addEventListener('click', () => this.hideModal('modalSmartFolder'));
    document.getElementById('btnConfirmSmartFolder')?.addEventListener('click', async () => {
      const name = document.getElementById('inputSmartFolderName')?.value.trim();
      const query = document.getElementById('inputSmartFolderQuery')?.value.trim();
      if (!name || !query) return;
      try {
        const res = await fetch('/api/files/local/smart-folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, search_query: query })
        });
        if (res.ok) {
          this.hideModal('modalSmartFolder');
          this.loadDirectory(this.currentPath);
        }
      } catch (err) {}
    });

    // Rename Modal
    document.getElementById('btnCancelRename')?.addEventListener('click', () => this.hideModal('modalRename'));
    document.getElementById('btnConfirmRename')?.addEventListener('click', () => this.renameSelectedItem());

    // Internal Share Modal (#14, #51)
    document.getElementById('btnCancelShare')?.addEventListener('click', () => this.hideModal('modalShareInternal'));
    document.getElementById('btnConfirmShare')?.addEventListener('click', () => this.createInternalShare());

    const shareeInput = document.getElementById('inputShareeUsername');
    shareeInput?.addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      const datalist = document.getElementById('userAutocompleteList');
      const container = document.getElementById('userSearchAutocomplete');
      if (q.length < 1) {
        if (datalist) datalist.innerHTML = '';
        if (container) { container.innerHTML = ''; container.style.display = 'none'; }
        return;
      }
      try {
        const res = await fetch(`/api/shares/users/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.users)) {
          if (datalist) {
            datalist.innerHTML = data.users
              .map(u => `<option value="${u.username}">${u.display_name && u.display_name !== u.username ? u.display_name + ' (' + u.username + ')' : u.username}</option>`)
              .join('');
          }
          if (container) {
            container.innerHTML = data.users.map(u => `<div class="user-search-item" style="padding: 4px 8px; cursor: pointer;" onclick="document.getElementById('inputShareeUsername').value='${u.username}'">${u.display_name || u.username} (@${u.username})</div>`).join('');
            container.style.display = data.users.length > 0 ? 'block' : 'none';
          }
        }
      } catch (err) {}
    });

    // S3 & MOVEit Storage Connect Form Handlers (#73)
    document.getElementById('formAddS3Provider')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const displayName = document.getElementById('inputS3Name')?.value.trim();
      const endpoint = document.getElementById('inputS3Endpoint')?.value.trim();
      const bucket = document.getElementById('inputS3Bucket')?.value.trim();
      const accessKey = document.getElementById('inputS3AccessKey')?.value.trim();
      const secretKey = document.getElementById('inputS3SecretKey')?.value.trim();
      if (!displayName || !bucket || !accessKey || !secretKey) return;
      try {
        const res = await fetch('/api/providers/s3/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: displayName, endpoint, bucket, access_key: accessKey, secret_key: secretKey })
        });
        if (res.ok) {
          this.hideModal('modalAddProvider');
          this.loadSidebarProviders();
        }
      } catch (err) {}
    });

    document.getElementById('formAddMoveitProvider')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const displayName = document.getElementById('inputMoveitName')?.value.trim();
      const host = document.getElementById('inputMoveitHost')?.value.trim();
      const username = document.getElementById('inputMoveitUsername')?.value.trim();
      const password = document.getElementById('inputMoveitPassword')?.value.trim();
      if (!displayName || !host || !username || !password) return;
      try {
        const res = await fetch('/api/providers/moveit/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: displayName, host, username, password })
        });
        if (res.ok) {
          this.hideModal('modalAddProvider');
          this.loadSidebarProviders();
        }
      } catch (err) {}
    });

    document.getElementById('formAddOneDriveProvider')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const displayName = document.getElementById('inputOneDriveName')?.value.trim();
      const refreshToken = document.getElementById('inputOneDriveRefreshToken')?.value.trim();
      if (!displayName || !refreshToken) return;
      try {
        const res = await fetch('/api/providers/onedrive/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: displayName, refresh_token: refreshToken })
        });
        if (res.ok) {
          this.hideModal('modalAddProvider');
          this.loadSidebarProviders();
        }
      } catch (err) {}
    });

    document.getElementById('formAddSharePointProvider')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const displayName = document.getElementById('inputSharePointName')?.value.trim();
      const siteId = document.getElementById('inputSharePointSiteId')?.value.trim();
      const driveId = document.getElementById('inputSharePointDriveId')?.value.trim();
      const refreshToken = document.getElementById('inputSharePointRefreshToken')?.value.trim();
      if (!displayName) return;
      try {
        const res = await fetch('/api/providers/sharepoint/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: displayName, site_id: siteId, drive_id: driveId, refresh_token: refreshToken })
        });
        if (res.ok) {
          this.hideModal('modalAddProvider');
          this.loadSidebarProviders();
        }
      } catch (err) {}
    });

    // Public Share Modal (#15)
    document.getElementById('btnCancelPublicShare')?.addEventListener('click', () => this.hideModal('modalSharePublic'));
    document.getElementById('btnConfirmPublicShare')?.addEventListener('click', () => this.createPublicShareLink());
    document.getElementById('btnCopyGeneratedLink')?.addEventListener('click', () => this.copyGeneratedLink());

    // Multi-Select Actions (#12)
    document.getElementById('btnBatchZip')?.addEventListener('click', () => this.batchDownloadZip());
    document.getElementById('btnBatchDelete')?.addEventListener('click', () => this.batchDelete());
    document.getElementById('btnDeselectAll')?.addEventListener('click', () => this.clearSelection());

    // Media Viewer Controls (#11)
    document.getElementById('btnMediaClose')?.addEventListener('click', () => this.closeMediaViewer());
    document.getElementById('btnMediaDownload')?.addEventListener('click', () => {
      if (this.currentMediaItem) this.downloadFile(this.currentMediaItem.path);
    });

    // Keyboard Shortcuts — Desktop-Grade File Navigation (#29)
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Drag & Drop Upload Overlay (Only for OS file uploads, ignore internal file moves)
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.isInternalDragging || this.activeDragPayload) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        return;
      }
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
      if (types.includes('Files')) {
        this.dropOverlay?.classList.add('active');
      }
    });

    this.dropOverlay?.addEventListener('dragleave', (e) => {
      e.preventDefault();
      this.dropOverlay.classList.remove('active');
    });

    this.dropOverlay?.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.dropOverlay.classList.remove('active');
      if (this.isInternalDragging || this.activeDragPayload) return;
      const items = e.dataTransfer ? e.dataTransfer.items : null;
      if (items && items.length && items[0] && items[0].webkitGetAsEntry) {
        const files = await this.readDroppedEntries(items);
        if (files && files.length) {
          this.handleFileUpload(files);
          return;
        }
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        this.handleFileUpload(e.dataTransfer.files);
      }
    });

    // Close Context Menu on Global Click
    document.addEventListener('click', () => this.hideContextMenu());

    // Global dragend cleanup (preserves payload across DOM re-renders during spring-loading) (#50, #59)
    window.addEventListener('dragend', () => {
      this.clearSpringLoadTimer();
      this.dropOverlay?.classList.remove('active');
      document.querySelectorAll('.drag-target-hover').forEach(el => el.classList.remove('drag-target-hover'));
      document.querySelectorAll('.drag-spring-loading').forEach(el => el.classList.remove('drag-spring-loading'));

      setTimeout(() => {
        this.isInternalDragging = false;
        this.activeDragPayload = null;
      }, 200);
    });

    // Global Window Drop Zone for Internal Drag & Drop (#50, #59)
    window.addEventListener('drop', async (e) => {
      if (!this.isInternalDragging && !this.activeDragPayload) return;

      // Ignore if drop target was a subfolder card, breadcrumb link, sidebar nav item, tab item, or new tab button (which have their own specific target handlers)
      if (e.target && e.target.closest) {
        if (e.target.closest('.file-card[data-is-dir="true"]') || e.target.closest('.file-card[data-is-cloud-drive="true"]') || e.target.closest('.breadcrumb-item') || e.target.closest('.nav-item') || e.target.closest('.tab-item') || e.target.closest('.btn-new-tab')) {
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();
      this.clearSpringLoadTimer();
      this.dropOverlay?.classList.remove('active');
      document.querySelectorAll('.drag-target-hover').forEach(el => el.classList.remove('drag-target-hover'));
      document.querySelectorAll('.drag-spring-loading').forEach(el => el.classList.remove('drag-spring-loading'));

      let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
      let data = null;
      if (rawData) {
        try { data = JSON.parse(rawData); } catch(err){}
      }
      if (!data) data = this.activeDragPayload;
      if (!data) return;

      try {
        const targetDir = this.currentPath;
        const targetProvId = this.currentViewType === 'provider' ? this.currentProviderId : null;

        const payloadToMove = data;
        this.activeDragPayload = null;
        this.isInternalDragging = false;

        await this.handleDragDropMove(payloadToMove, targetDir, targetProvId);
      } catch (err) {
        console.error('Global Drop Error:', err);
        alert(`Move failed: ${err.message}`);
      }
    });

    // Context Menu Actions
    document.getElementById('ctxOpen')?.addEventListener('click', () => this.openSelectedItem());
    document.getElementById('ctxDetails')?.addEventListener('click', () => this.showFileDetailsModalFromContextMenu());
    document.getElementById('ctxShareInternal')?.addEventListener('click', () => this.showShareInternalModal());
    document.getElementById('ctxSharePublic')?.addEventListener('click', () => this.showSharePublicModal());
    document.getElementById('ctxDownload')?.addEventListener('click', () => this.downloadSelectedItem());
    document.getElementById('ctxRename')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('ctxDelete')?.addEventListener('click', () => this.deleteSelectedItem());
    document.getElementById('ctxIngestPaperless')?.addEventListener('click', () => this.ingestPaperless());
    document.getElementById('ctxIngestImmich')?.addEventListener('click', () => this.ingestImmich());

    // File Details Modal Controls (#52)
    document.getElementById('btnFileDetails')?.addEventListener('click', () => this.showFileDetailsModalFromToolbar());
    document.getElementById('btnCloseFileDetails')?.addEventListener('click', () => this.hideModal('modalFileDetails'));
    document.getElementById('btnDetailsClose')?.addEventListener('click', () => this.hideModal('modalFileDetails'));
    document.getElementById('btnDetailsAddInternalShare')?.addEventListener('click', () => {
      this.hideModal('modalFileDetails');
      this.showShareInternalModal();
    });
    document.getElementById('btnDetailsAddPublicShare')?.addEventListener('click', () => {
      this.hideModal('modalFileDetails');
      this.showSharePublicModal();
    });

    // Edit Public Share Modal Controls (#53)
    document.getElementById('btnCancelEditPublicShare')?.addEventListener('click', () => this.hideModal('modalEditPublicShare'));
    document.getElementById('btnConfirmEditPublicShare')?.addEventListener('click', () => this.updatePublicShareLink());
  }

  async loadAppPasswords() {
    const listEl = document.getElementById('appPasswordsList');
    if (!listEl) return;
    try {
      const res = await fetch('/api/auth/app-passwords');
      if (!res.ok) return;
      const data = await res.json();
      const passwords = data.appPasswords || [];
      if (passwords.length === 0) {
        listEl.innerHTML = '<p style="font-size:12px; color:var(--ink-muted);">No active app passwords.</p>';
        return;
      }
      listEl.innerHTML = passwords.map(item => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:12px;">
          <span><strong>${item.label}</strong> (created ${new Date(item.created_at).toLocaleDateString()})</span>
          <button type="button" class="fs-btn fs-btn--danger" style="padding:2px 6px; font-size:11px;" onclick="window.fileBrowser.deleteAppPassword(${item.id})">Revoke</button>
        </div>
      `).join('');
    } catch (e) {}
  }

  async deleteAppPassword(id) {
    if (!confirm('Revoke this app password?')) return;
    try {
      const res = await fetch(`/api/auth/app-passwords/${id}`, { method: 'DELETE' });
      if (res.ok) this.loadAppPasswords();
    } catch (e) {}
  }

  async loadDirectory(dirPath, updateTab = true, isNavigatingHistory = false) {
    this.currentViewType = 'local';
    this.currentPath = dirPath;
    this.pushHistory({ viewType: 'local', path: dirPath }, isNavigatingHistory);
    this.clearSelection();
    this.renderBreadcrumb();

    if (updateTab) {
      const folderName = dirPath === '/' ? 'Home' : dirPath.split('/').filter(Boolean).pop() || 'Home';
      this.updateActiveTabState(folderName, 'local', dirPath);
    }

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('navHome')?.classList.add('active');

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';

    try {
      const res = await fetch(`/api/files/local/list?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to load files');
      }

      const data = await res.json();
      this.items = data.items || [];
      this.render();
    } catch (err) {
      console.error('Error loading directory:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  async loadProviderDirectory(providerId, providerName, dirPath, updateTab = true, isNavigatingHistory = false) {
    this.currentViewType = 'provider';
    this.currentProviderId = String(providerId);
    this.currentProviderName = providerName;
    this.currentPath = dirPath;
    this.pushHistory({ viewType: 'provider', providerId: String(providerId), providerName, path: dirPath }, isNavigatingHistory);
    this.clearSelection();

    if (updateTab) {
      const pathParts = dirPath.split('/').filter(Boolean);
      const subName = pathParts.length > 0 ? pathParts[pathParts.length - 1] : providerName;
      this.updateActiveTabState(subName, 'provider', dirPath, String(providerId), providerName);
    }

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById(`navProvider_${providerId}`)?.classList.add('active');

    this.renderBreadcrumb();

    try {
      const res = await fetch(`/api/providers/${providerId}/list?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to load cloud drive items');
      }

      const data = await res.json();
      this.items = data.items || [];
      this.render();
    } catch (err) {
      console.error('Error loading provider directory:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  async loadSharedWithMe(updateTab = true, isNavigatingHistory = false) {
    this.currentViewType = 'shared';
    this.pushHistory({ viewType: 'shared', path: '/' }, isNavigatingHistory);
    this.clearSelection();
    if (updateTab) {
      this.updateActiveTabState('Shared with me', 'shared', '/');
    }
    if (this.breadcrumb) {
      this.breadcrumb.innerHTML = `<span class="breadcrumb-item active">Shared with me</span>`;
    }

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';

    try {
      const res = await fetch('/api/shares/internal/shared-with-me');
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to load shared files');
      }

      const data = await res.json();
      const shares = data.shares || [];

      this.items = shares.map(s => ({
        name: s.file_path.split('/').pop() || s.file_path,
        path: s.file_path,
        isDirectory: !!s.is_directory,
        owner: s.owner_display_name || s.owner_username,
        permission: s.read_write ? 'Read/Write' : 'Read Only',
        isSharedItem: true
      }));

      this.render();
    } catch (err) {
      console.error('Error loading shared files:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  async loadTrash(trashId = null, subpath = '/', updateTab = true, isNavigatingHistory = false) {
    this.currentViewType = 'trash';
    this.currentTrashId = trashId;
    this.currentTrashSubpath = subpath;
    this.pushHistory({ viewType: 'trash', trashId, trashSubpath: subpath }, isNavigatingHistory);
    this.clearSelection();
    if (updateTab) {
      this.updateActiveTabState('Trash', 'trash', '/');
    }

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) emptyTrashBtn.style.display = 'inline-flex';

    if (this.breadcrumb) {
      if (!trashId) {
        this.breadcrumb.innerHTML = `<span class="breadcrumb-item active">Trash (Auto-deletes after 30 days)</span>`;
      } else {
        this.breadcrumb.innerHTML = `
          <span class="breadcrumb-item" id="btnBreadcrumbTrashRoot" style="cursor: pointer;">Trash</span>
          <span style="color: var(--ink-muted);">/</span>
          <span class="breadcrumb-item active">${subpath}</span>
        `;
        document.getElementById('btnBreadcrumbTrashRoot')?.addEventListener('click', () => this.loadTrash(null, '/'));
      }
    }

    try {
      let res;
      if (!trashId) {
        res = await fetch('/api/trash');
      } else {
        res = await fetch(`/api/trash/${trashId}/contents?subpath=${encodeURIComponent(subpath)}`);
      }
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to load trash items');
      }

      const data = await res.json();
      if (!trashId) {
        const items = data.items || [];
        this.items = items.map(t => ({
          id: t.id,
          name: t.original_name,
          path: t.original_path,
          isDirectory: !!t.is_directory,
          size: t.size_bytes,
          deletedAt: t.deleted_at,
          expiresAt: t.expires_at,
          isTrashItem: true,
          isTopLevelTrash: true
        }));
      } else {
        const contents = data.contents || [];
        this.items = contents.map(c => ({
          name: c.name,
          path: c.subpath,
          isDirectory: c.isDirectory,
          size: c.size,
          isTrashItem: true,
          isTopLevelTrash: false
        }));
      }

      this.render();
    } catch (err) {
      console.error('Error loading trash:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  async loadActivity(updateTab = true, isNavigatingHistory = false) {
    this.currentViewType = 'activity';
    this.pushHistory({ viewType: 'activity', path: '/' }, isNavigatingHistory);
    this.clearSelection();
    if (updateTab) {
      this.updateActiveTabState('Activity', 'activity', '/');
    }

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';

    if (this.breadcrumb) {
      this.breadcrumb.innerHTML = `<span class="breadcrumb-item active">Activity Log & File Operations</span>`;
    }

    try {
      const res = await fetch('/api/activity?limit=50');
      if (!res.ok) throw new Error('Failed to load activity log');

      const data = await res.json();
      const activities = data.activities || [];

      if (activities.length === 0) {
        this.container.innerHTML = `
          <div class="placeholder-card" style="grid-column: 1 / -1;">
            <span style="font-size: 3rem;">🕒</span>
            <h3 style="margin-top: 0.5rem; color: var(--ink-muted);">No activity recorded yet.</h3>
          </div>
        `;
        return;
      }

      this.container.className = 'list-view';
      this.container.innerHTML = activities.map(act => {
        let actionBadge = '📄';
        let actionTitle = act.action;
        let detailsText = '';

        if (act.details) {
          try {
            const parsed = JSON.parse(act.details);
            if (parsed.dst) detailsText = ` ➔ ${parsed.dst}`;
            if (parsed.sharee) detailsText = ` with ${parsed.sharee}`;
            if (parsed.token) detailsText = ` (Token: ${parsed.token.substring(0, 8)}...)`;
          } catch (e) {
            detailsText = ` (${act.details})`;
          }
        }

        switch (act.action) {
          case 'upload': actionBadge = '📥 Uploaded'; break;
          case 'mkdir': actionBadge = '📁 Created folder'; break;
          case 'move': actionBadge = '🚚 Moved'; break;
          case 'copy': actionBadge = '📋 Copied'; break;
          case 'delete': actionBadge = '🗑️ Trashed'; break;
          case 'delete_permanent': actionBadge = '❌ Permanently deleted'; break;
          case 'restore': actionBadge = '↺ Restored'; break;
          case 'share_internal': actionBadge = '👥 Shared'; break;
          case 'share_public': actionBadge = '🔗 Public link'; break;
          case 'download_zip': actionBadge = '📦 Downloaded Zip'; break;
        }

        const dateFormatted = new Date(act.created_at + 'Z').toLocaleString();

        return `
          <div class="file-card" style="cursor: default; display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
              <span style="font-size: 1.25rem;">${act.is_directory ? '📁' : '📄'}</span>
              <div>
                <div class="file-name" style="font-weight: 500;">${act.file_name} <span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">${act.file_path}${detailsText}</span></div>
                <div style="font-size: 11px; color: var(--ink-muted); font-family: var(--font-mono); margin-top: 2px;">${dateFormatted}</div>
              </div>
            </div>
            <span class="fs-mono text-sm" style="background: rgba(255, 255, 255, 0.06); padding: 4px 10px; border-radius: 4px;">${actionBadge}</span>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Error loading activity:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  renderBreadcrumb() {
    if (!this.breadcrumb) return;

    if (this.currentViewType === 'local') {
      const parts = this.currentPath.split('/').filter(Boolean);
      let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" data-path="/">🏠 Home</span>`;

      let accumulatedPath = '';
      parts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const isActive = index === parts.length - 1;
        html += ` <span style="color: var(--ink-muted);">/</span> `;
        html += `<span class="breadcrumb-item ${isActive ? 'active' : ''}" data-path="${accumulatedPath}">${part}</span>`;
      });

      this.breadcrumb.innerHTML = html;

      this.attachBreadcrumbDragAndClickHandlers((targetPath) => {
        this.loadDirectory(targetPath);
      }, null);

    } else if (this.currentViewType === 'provider' && this.currentProviderId) {
      const providerId = this.currentProviderId;
      const providerName = this.currentProviderName || 'Cloud Drive';
      const pathParts = this.currentPath.split('/').filter(Boolean);
      const provType = providerName.toLowerCase().includes('dropbox') ? 'dropbox' : (providerName.toLowerCase().includes('google') ? 'gdrive' : 'cloud');
      const providerSvg = this.getProviderIconSvg(provType, 16);

      let html = `<span class="breadcrumb-item" data-path="home_root">🏠 Home</span>`;
      html += ` <span style="color: var(--ink-muted);">/</span> `;
      html += `<span class="breadcrumb-item ${pathParts.length === 0 ? 'active' : ''}" data-path="/" style="display: inline-flex; align-items: center; gap: 4px;">${providerSvg} ${providerName}</span>`;

      let accumulatedPath = '';
      pathParts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const isActive = index === pathParts.length - 1;
        html += ` <span style="color: var(--ink-muted);">/</span> `;
        html += `<span class="breadcrumb-item ${isActive ? 'active' : ''}" data-path="${accumulatedPath}">${part}</span>`;
      });

      this.breadcrumb.innerHTML = html;

      this.attachBreadcrumbDragAndClickHandlers((targetPath) => {
        if (targetPath === 'home_root') {
          this.loadDirectory('/');
        } else {
          this.loadProviderDirectory(providerId, providerName, targetPath);
        }
      }, providerId);
    }
  }

  attachBreadcrumbDragAndClickHandlers(navigateFn, destProviderId = null) {
    this.breadcrumb.querySelectorAll('.breadcrumb-item').forEach(item => {
      const targetPath = item.getAttribute('data-path');

      item.addEventListener('click', (e) => {
        if (targetPath && targetPath !== this.currentPath) {
          navigateFn(targetPath);
        }
      });

      item.addEventListener('dragover', (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-target-hover');

        if (targetPath && (targetPath !== this.currentPath || targetPath === 'home_root') && this.springLoadTarget !== item) {
          this.clearSpringLoadTimer();
          this.springLoadTarget = item;
          item.classList.add('drag-spring-loading');
          this.springLoadTimer = setTimeout(() => {
            this.clearSpringLoadTimer();
            if (this.isInternalDragging || this.activeDragPayload) {
              navigateFn(targetPath);
            }
          }, 750);
        }
      });

      item.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();
      });

      item.addEventListener('drop', async (e) => {
        if (!this.isInternalDragging && !this.activeDragPayload) return;
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-target-hover');
        this.clearSpringLoadTimer();

        let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
        let data = null;
        if (rawData) {
          try { data = JSON.parse(rawData); } catch(err){}
        }
        if (!data) data = this.activeDragPayload;
        if (!data) return;

        try {
          const payload = data;
          this.activeDragPayload = null;
          this.isInternalDragging = false;

          let actualTargetDir = targetPath;
          let actualTargetProvId = destProviderId;

          if (targetPath === 'home_root') {
            actualTargetDir = '/';
            actualTargetProvId = null;
          }

          if (payload.srcPath === actualTargetDir || actualTargetDir.startsWith(payload.srcPath + '/')) {
            return;
          }
          await this.handleDragDropMove(payload, actualTargetDir, actualTargetProvId);
          navigateFn(targetPath);
        } catch (err) {
          console.error('Breadcrumb Drag & Drop Error:', err);
          alert(`Move failed: ${err.message}`);
        }
      });
    });
  }

  render() {
    if (!this.container) return;

    if (this.items.length === 0) {
      const msg = this.currentViewType === 'trash' ? 'Trash is empty.' : (this.currentViewType === 'shared' ? 'No files shared with you yet.' : 'Upload files or create a folder to get started.');
      this.container.innerHTML = `
        <div class="placeholder-card" style="grid-column: 1 / -1;">
          <span style="font-size: 3rem;">${this.currentViewType === 'trash' ? '🗑️' : '📂'}</span>
          <h3 style="margin-top: 0.5rem; color: var(--ink-muted);">${msg}</h3>
        </div>
      `;
      return;
    }

    this.container.className = this.viewMode === 'grid' ? 'grid-view' : 'list-view';

    this.container.innerHTML = this.items.map(item => {
      const isCloudDrive = item.isCloudDrive;
      const isDir = item.isDirectory;
      let icon = isDir ? '📁' : this.getFileIcon(item.name);
      if (isCloudDrive) {
        icon = item.providerType === 'dropbox' ? '📦' : '☁️';
      }

      let metaText = '';
      if (isCloudDrive) {
        metaText = 'Cloud Storage Connection';
      } else if (item.isTrashItem) {
        metaText = `${this.formatSize(item.size)} • Original: ${item.path}`;
      } else if (item.isSharedItem) {
        metaText = `Shared by ${item.owner}`;
      } else {
        metaText = isDir ? '' : this.formatSize(item.size);
      }

      const isChecked = this.selectedPaths.has(item.path || item.id);

      return `
        <div class="file-card ${isChecked ? 'selected' : ''}" data-id="${item.id || ''}" data-is-top-level="${item.isTopLevelTrash ? 'true' : 'false'}" data-subpath="${item.subpath || '/'}" data-name="${item.name}" data-is-dir="${isDir}" data-path="${item.path}" data-is-cloud-drive="${isCloudDrive ? 'true' : 'false'}" data-provider-id="${item.providerId || ''}">
          ${item.isTrashItem || isCloudDrive ? '' : `<input type="checkbox" class="file-checkbox" ${isChecked ? 'checked' : ''} />`}
          ${item.isTrashItem ? '' : `<button class="mobile-action-dots" title="Actions" aria-label="Actions">⋮</button>`}
          <div class="file-icon">${icon}</div>
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-meta" style="font-size: 11px;">${metaText}</div>
          ${item.isTrashItem && item.isTopLevelTrash !== false ? `
            <div style="display: flex; gap: 4px; margin-top: 6px;">
              <button class="fs-btn text-sm btn-restore-trash" data-id="${item.id}" style="padding: 2px 6px; font-size: 11px;">↺ Restore</button>
              <button class="fs-btn fs-btn--danger text-sm btn-delete-trash" data-id="${item.id}" style="padding: 2px 6px; font-size: 11px;">🗑️ Delete</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // Trash Item Action Listeners (#18)
    this.container.querySelectorAll('.btn-restore-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        this.restoreTrashItem(id);
      });
    });

    this.container.querySelectorAll('.btn-delete-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        this.deleteTrashItemPermanently(id);
      });
    });

    // Card & Checkbox Event Listeners (#12, #14, #15, #18, #85)
    this.container.querySelectorAll('.file-card').forEach(card => {
      const checkbox = card.querySelector('.file-checkbox');
      const dotsBtn = card.querySelector('.mobile-action-dots');
      const itemPath = card.getAttribute('data-path');
      const isDir = card.getAttribute('data-is-dir') === 'true';
      const isCloudDrive = card.getAttribute('data-is-cloud-drive') === 'true';
      const providerId = card.getAttribute('data-provider-id');
      const trashId = card.getAttribute('data-id');
      const isTopLevel = card.getAttribute('data-is-top-level') === 'true';
      const subpath = card.getAttribute('data-subpath');

      if (checkbox) {
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleItemSelection(itemPath, checkbox.checked, card);
        });
      }

      if (dotsBtn) {
        dotsBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.currentViewType === 'trash' || this.currentViewType === 'activity') return;
          const name = card.getAttribute('data-name');
          const path = card.getAttribute('data-path');
          this.selectedItem = { name, isDirectory: isDir, path };
          const rect = dotsBtn.getBoundingClientRect();
          this.showContextMenu(rect.left, rect.bottom + 4);
        });
      }

      // Touch long-press gesture (500ms) for mobile context menu (#85)
      let cardTouchTimer = null;
      let startX = 0, startY = 0;
      card.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || e.target.closest('.file-checkbox') || e.target.closest('.mobile-action-dots')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        cardTouchTimer = setTimeout(() => {
          if (this.currentViewType === 'trash' || this.currentViewType === 'activity') return;
          const name = card.getAttribute('data-name');
          const path = card.getAttribute('data-path');
          this.selectedItem = { name, isDirectory: isDir, path };
          this.showContextMenu(startX, startY);
        }, 500);
      }, { passive: true });

      card.addEventListener('touchmove', (e) => {
        if (!cardTouchTimer) return;
        const touch = e.touches[0];
        if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > 10) {
          clearTimeout(cardTouchTimer);
          cardTouchTimer = null;
        }
      }, { passive: true });

      card.addEventListener('touchend', () => {
        if (cardTouchTimer) { clearTimeout(cardTouchTimer); cardTouchTimer = null; }
      });
      card.addEventListener('touchcancel', () => {
        if (cardTouchTimer) { clearTimeout(cardTouchTimer); cardTouchTimer = null; }
      });

      const activateItem = () => {
        if (this.currentViewType === 'trash') {
          if (isDir && trashId) {
            if (isTopLevel) {
              this.loadTrash(trashId, '/');
            } else {
              const nextSubpath = subpath === '/' ? `/${card.getAttribute('data-name')}` : `${subpath}/${card.getAttribute('data-name')}`;
              this.loadTrash(trashId, nextSubpath);
            }
          }
          return;
        }

        const name = card.getAttribute('data-name');
        if (isDir) {
          if (isCloudDrive) {
            this.loadProviderDirectory(providerId, name, '/');
          } else if (this.currentViewType === 'provider') {
            this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, itemPath);
          } else {
            this.loadDirectory(itemPath);
          }
        } else {
          const item = this.items.find(i => i.path === itemPath || i.name === name);
          this.openMediaViewer(item || { name, path: itemPath });
        }
      };

      card.addEventListener('click', (e) => {
        if (checkbox && e.target !== checkbox) {
          if (this.selectedPaths.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey) {
            const newState = !this.selectedPaths.has(itemPath);
            checkbox.checked = newState;
            this.toggleItemSelection(itemPath, newState, card);
          } else if (this.clickNavigationMode === 'single') {
            activateItem();
          }
        }
      });

      card.addEventListener('dblclick', () => {
        if (this.clickNavigationMode !== 'single') {
          activateItem();
        }
      });

      card.addEventListener('contextmenu', (e) => {
        if (this.currentViewType === 'trash' || this.currentViewType === 'activity') return;
        e.preventDefault();
        const name = card.getAttribute('data-name');
        const path = card.getAttribute('data-path');

        this.selectedItem = { name, isDirectory: isDir, path };
        this.showContextMenu(e.clientX, e.clientY);
      });

      // HTML5 Drag & Drop File Move (#50, #59)
      if (this.currentViewType !== 'trash') {
        if (!isCloudDrive) {
          card.setAttribute('draggable', 'true');

          card.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            this.isInternalDragging = true;

            let itemsToMove = [];
            if (this.selectedPaths.size > 0 && this.selectedPaths.has(itemPath)) {
              itemsToMove = Array.from(this.selectedPaths).map(p => {
                const itemObj = this.items.find(i => i.path === p);
                const name = itemObj ? itemObj.name : p.split('/').filter(Boolean).pop() || p;
                return { srcPath: p, name };
              });
            } else {
              itemsToMove = [{ srcPath: itemPath, name: card.getAttribute('data-name') }];
            }

            const payload = {
              items: itemsToMove,
              srcPath: itemPath,
              name: card.getAttribute('data-name'),
              isDirectory: isDir,
              isCloudDrive: isCloudDrive,
              viewType: this.currentViewType,
              currentProviderId: this.currentProviderId
            };
            this.activeDragPayload = payload;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
            card.classList.add('dragging');
          });

          card.addEventListener('dragend', () => {
            this.clearSpringLoadTimer();
            card.classList.remove('dragging');
            this.dropOverlay?.classList.remove('active');
            document.querySelectorAll('.drag-target-hover').forEach(el => el.classList.remove('drag-target-hover'));
          });
        }

        // Folder or Cloud Drive card drop target (#50, #59)
        if (isDir || isCloudDrive) {
          card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('drag-target-hover');

            if (this.springLoadTarget !== card) {
              this.clearSpringLoadTimer();
              this.springLoadTarget = card;
              card.classList.add('drag-spring-loading');
              this.springLoadTimer = setTimeout(() => {
                this.clearSpringLoadTimer();
                if (this.isInternalDragging) {
                  if (isCloudDrive) {
                    this.loadProviderDirectory(providerId, card.getAttribute('data-name'), '/');
                  } else if (this.currentViewType === 'provider') {
                    this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, itemPath);
                  } else {
                    this.loadDirectory(itemPath);
                  }
                }
              }, 750);
            }
          });

          card.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-target-hover');
            this.clearSpringLoadTimer();
          });

          card.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-target-hover');
            this.clearSpringLoadTimer();

            let rawData = e.dataTransfer ? e.dataTransfer.getData('application/json') : null;
            let data = null;
            if (rawData) {
              try { data = JSON.parse(rawData); } catch(err){}
            }
            if (!data) data = this.activeDragPayload;
            if (!data) return;

            try {
              const targetFolderPath = isCloudDrive ? '/' : itemPath;
              const targetProvId = isCloudDrive ? providerId : (this.currentViewType === 'provider' ? this.currentProviderId : null);
              await this.handleDragDropMove(data, targetFolderPath, targetProvId);
            } catch (err) {
              console.error('Drag & Drop Move Error:', err);
              alert(`Move failed: ${err.message}`);
            }
          });
        }
      }
    });
  }

  async handleDragDropMove(dragData, targetDirectory, targetProviderId = null) {
    if (this.isTransferring) return;
    this.isTransferring = true;

    try {
      const items = dragData.items && dragData.items.length > 0
        ? dragData.items
        : [{ srcPath: dragData.srcPath, name: dragData.name }];

      const srcViewType = dragData.viewType || 'local';
      const srcProviderId = dragData.currentProviderId;
      const destProviderId = targetProviderId || (this.currentViewType === 'provider' ? this.currentProviderId : null);

      // Pre-transfer file collision detection & Conflict Resolution Wizard
      let destItems = [];
      try {
        const listUrl = destProviderId
          ? `/api/providers/${destProviderId}/list?path=${encodeURIComponent(targetDirectory)}`
          : `/api/files/local/list?path=${encodeURIComponent(targetDirectory)}`;
        const listRes = await fetch(listUrl);
        if (listRes.ok) {
          const listData = await listRes.json();
          destItems = listData.items || [];
        }
      } catch (err) {}

      let rememberedChoice = null;
      const processedItems = [];
      for (const item of items) {
        let finalName = item.name;
        const matchingExisting = destItems.find(i => i.name.toLowerCase() === item.name.toLowerCase());

        if (matchingExisting) {
          let choice = rememberedChoice;
          if (!choice) {
            const srcLocation = srcViewType === 'provider' ? (dragData.providerName || 'Cloud Drive') : 'Local Home';
            const destLocation = destProviderId ? 'Cloud Drive' : 'Local Home';

            const existingPreviewUrl = destProviderId
              ? `/api/providers/${destProviderId}/read?path=${encodeURIComponent(matchingExisting.path)}`
              : `/api/files/local/read?path=${encodeURIComponent(matchingExisting.path)}`;

            const incomingPreviewUrl = srcViewType === 'provider' && srcProviderId
              ? `/api/providers/${srcProviderId}/read?path=${encodeURIComponent(item.srcPath)}`
              : `/api/files/local/read?path=${encodeURIComponent(item.srcPath)}`;

            const res = await this.promptFileConflict(
              {
                name: matchingExisting.name,
                size: matchingExisting.size,
                mtime: matchingExisting.updatedAt || matchingExisting.mtime,
                location: destLocation,
                previewUrl: existingPreviewUrl
              },
              {
                name: item.name,
                size: item.size || 0,
                mtime: Date.now(),
                location: srcLocation,
                previewUrl: incomingPreviewUrl
              }
            );

            choice = typeof res === 'string' ? res : res.choice;
            if (typeof res === 'object' && res.applyToAll) {
              rememberedChoice = choice;
            }
          }

          if (choice === 'cancel') {
            continue;
          } else if (choice === 'rename') {
            finalName = this.generateNonConflictingName(item.name, destItems.map(i => i.name));
            destItems.push({ name: finalName, path: `${targetDirectory}/${finalName}` });
          }
        }
        processedItems.push({ ...item, name: finalName });
      }

      if (processedItems.length === 0) return;

      // Scenario 1: Local to Local Move
      if (srcViewType === 'local' && !destProviderId) {
        if (processedItems.length > 1) {
          const batchItems = processedItems
            .filter(i => i.srcPath !== targetDirectory && !targetDirectory.startsWith(i.srcPath + '/'))
            .map(i => {
              const destPath = targetDirectory === '/' ? `/${i.name}` : `${targetDirectory.replace(/\/+$/, '')}/${i.name}`;
              return { src: i.srcPath, dst: destPath };
            });

          if (batchItems.length === 0) return;

          const res = await fetch('/api/files/local/batch/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: batchItems })
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed batch move');
          }
        } else {
          const item = processedItems[0];
          const destPath = targetDirectory === '/' ? `/${item.name}` : `${targetDirectory.replace(/\/+$/, '')}/${item.name}`;
          if (item.srcPath === destPath || item.srcPath === targetDirectory || targetDirectory.startsWith(item.srcPath + '/')) {
            return;
          }
          const res = await fetch('/api/files/local/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: item.srcPath, dst: destPath })
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to move file');
          }
        }

        this.clearSelection();
        this.loadDirectory(this.currentPath);
        return;
      }

      // Scenario 2: Local to Cloud Upload & Delete Local (Cross-Storage Move)
      if (srcViewType === 'local' && destProviderId) {
        for (const item of processedItems) {
          const readRes = await fetch(`/api/files/local/read?path=${encodeURIComponent(item.srcPath)}`);
          if (!readRes.ok) throw new Error(`Failed to read local file ${item.name}`);
          const blob = await readRes.blob();

          const formData = new FormData();
          formData.append('path', targetDirectory);
          formData.append('file', blob, item.name);

          const uploadRes = await fetch(`/api/providers/${destProviderId}/upload?path=${encodeURIComponent(targetDirectory)}`, {
            method: 'POST',
            body: formData
          });
          if (!uploadRes.ok) {
            const errText = await this.parseResponseError(uploadRes, 'Upload to Cloud failed');
            throw new Error(`Upload to Cloud failed: ${errText}`);
          }

          // Delete source local file after successful upload to cloud
          await fetch(`/api/files/local?path=${encodeURIComponent(item.srcPath)}&permanent=true`, {
            method: 'DELETE'
          });
        }

        this.clearSelection();
        if (this.currentViewType === 'provider') {
          this.loadProviderDirectory(destProviderId, this.currentProviderName, targetDirectory);
        } else {
          this.loadDirectory(this.currentPath);
        }
        return;
      }

      // Scenario 3: Cloud to Local Download & Delete Cloud (Cross-Storage Move)
      if (srcViewType === 'provider' && !destProviderId && srcProviderId) {
        for (const item of processedItems) {
          const readRes = await fetch(`/api/providers/${srcProviderId}/read?path=${encodeURIComponent(item.srcPath)}`);
          if (!readRes.ok) throw new Error(`Failed to read cloud file ${item.name}`);
          const blob = await readRes.blob();

          const formData = new FormData();
          formData.append('path', targetDirectory);
          formData.append('file', blob, item.name);

          const uploadRes = await fetch('/api/files/local/upload', {
            method: 'POST',
            body: formData
          });
          if (!uploadRes.ok) {
            const errText = await this.parseResponseError(uploadRes, 'Cloud to Local Transfer failed');
            throw new Error(`Cloud to Local Transfer failed: ${errText}`);
          }

          // Delete source cloud file after successful download to local
          await fetch(`/api/providers/${srcProviderId}/delete?path=${encodeURIComponent(item.srcPath)}`, {
            method: 'DELETE'
          });
        }

        this.clearSelection();
        this.currentViewType = 'local';
        this.loadDirectory(targetDirectory || '/');
        return;
      }

      // Scenario 4: Provider Internal Move (Within Same Cloud Provider)
      if (srcViewType === 'provider' && destProviderId && String(srcProviderId) === String(destProviderId)) {
        for (const item of processedItems) {
          const destPath = targetDirectory === '/' ? `/${item.name}` : `${targetDirectory.replace(/\/+$/, '')}/${item.name}`;
          if (item.srcPath === destPath || item.srcPath === targetDirectory || targetDirectory.startsWith(item.srcPath + '/')) {
            continue;
          }
          const res = await fetch(`/api/providers/${srcProviderId}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: item.srcPath, dst: destPath })
          });
          if (!res.ok) {
            const errText = await this.parseResponseError(res, 'Failed to move item in cloud');
            throw new Error(`Cloud Move failed: ${errText}`);
          }
        }
        this.clearSelection();
        this.loadProviderDirectory(destProviderId, this.currentProviderName, targetDirectory);
        return;
      }

      // Scenario 5: Cloud to Cloud Transfer (Cross-Provider Move, e.g. Dropbox -> Google Drive)
      if (srcViewType === 'provider' && destProviderId && srcProviderId && String(srcProviderId) !== String(destProviderId)) {
        for (const item of processedItems) {
          const readRes = await fetch(`/api/providers/${srcProviderId}/read?path=${encodeURIComponent(item.srcPath)}`);
          if (!readRes.ok) throw new Error(`Failed to read source cloud file ${item.name}`);
          const blob = await readRes.blob();

          const formData = new FormData();
          formData.append('path', targetDirectory);
          formData.append('file', blob, item.name);

          const uploadRes = await fetch(`/api/providers/${destProviderId}/upload?path=${encodeURIComponent(targetDirectory)}`, {
            method: 'POST',
            body: formData
          });
          if (!uploadRes.ok) {
            const errText = await this.parseResponseError(uploadRes, 'Cloud-to-Cloud Upload failed');
            throw new Error(`Cloud-to-Cloud Upload failed: ${errText}`);
          }

          // Delete source cloud file ONLY after successful upload to destination cloud
          await fetch(`/api/providers/${srcProviderId}/delete?path=${encodeURIComponent(item.srcPath)}`, {
            method: 'DELETE'
          });
        }

        this.clearSelection();
        if (this.currentViewType === 'provider') {
          this.loadProviderDirectory(destProviderId, this.currentProviderName, targetDirectory);
        } else {
          this.loadDirectory(this.currentPath);
        }
        return;
      }
    } finally {
      this.isTransferring = false;
    }
  }

  async parseResponseError(res, fallbackText = 'Operation failed') {
    let errMessage = res.statusText || fallbackText;
    try {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data && data.error) errMessage = data.error;
      } else {
        const text = await res.text();
        if (text) errMessage = text.substring(0, 200);
      }
    } catch (e) {}
    return errMessage;
  }

  async restoreTrashItem(id) {
    try {
      const res = await fetch(`/api/trash/${id}/restore`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to restore item');
      }
      this.loadTrash();
    } catch (err) {
      alert('Error restoring item: ' + err.message);
    }
  }

  async deleteTrashItemPermanently(id) {
    if (!confirm('Permanently delete this item? This action cannot be undone.')) return;
    try {
      const res = await fetch(`/api/trash/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete item');
      }
      this.loadTrash();
    } catch (err) {
      alert('Error deleting item: ' + err.message);
    }
  }

  async emptyTrash() {
    if (!confirm('Empty entire Trash? All items will be permanently deleted.')) return;
    try {
      const res = await fetch('/api/trash', { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to empty trash');
      }
      this.loadTrash();
    } catch (err) {
      alert('Error emptying trash: ' + err.message);
    }
  }

  toggleItemSelection(path, isSelected, cardElement) {
    if (isSelected) {
      this.selectedPaths.add(path);
      if (cardElement) cardElement.classList.add('selected');
    } else {
      this.selectedPaths.delete(path);
      if (cardElement) cardElement.classList.remove('selected');
    }
    this.updateSelectionActionBar();
  }

  clearSelection() {
    this.selectedPaths.clear();
    if (this.container) {
      this.container.querySelectorAll('.file-card').forEach(c => {
        c.classList.remove('selected');
        const cb = c.querySelector('.file-checkbox');
        if (cb) cb.checked = false;
      });
    }
    this.updateSelectionActionBar();
  }

  updateSelectionActionBar() {
    const count = this.selectedPaths.size;
    const btnFileDetails = document.getElementById('btnFileDetails');
    if (btnFileDetails) {
      btnFileDetails.style.display = count === 1 ? 'inline-flex' : 'none';
    }

    if (this.selectionActionBar) {
      if (count > 0) {
        this.selectionActionBar.style.display = 'flex';
        if (this.selectedCountText) {
          this.selectedCountText.textContent = `${count} item${count > 1 ? 's' : ''} selected`;
        }
      } else {
        this.selectionActionBar.style.display = 'none';
      }
    }
  }

  // ── Keyboard Shortcuts — Desktop-Grade File Navigation (#29) ──────────────
  selectItemByIndex(index) {
    if (!this.items || this.items.length === 0) return;
    if (index < 0) index = 0;
    if (index >= this.items.length) index = this.items.length - 1;

    const item = this.items[index];
    this.clearSelection();
    this.selectedItem = item;
    this.selectedPaths.add(item.path);

    if (this.container) {
      const cards = Array.from(this.container.querySelectorAll('.file-card'));
      cards.forEach(c => {
        const cardPath = c.getAttribute('data-path');
        if (cardPath === item.path) {
          c.classList.add('selected');
          const cb = c.querySelector('.file-checkbox');
          if (cb) cb.checked = true;
          c.scrollIntoView({ block: 'nearest' });
        } else {
          c.classList.remove('selected');
          const cb = c.querySelector('.file-checkbox');
          if (cb) cb.checked = false;
        }
      });
    }
    this.updateSelectionActionBar();
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

  selectAll() {
    if (!this.items || this.items.length === 0) return;
    this.selectedPaths.clear();
    this.items.forEach(i => this.selectedPaths.add(i.path));
    if (this.items.length > 0) {
      this.selectedItem = this.items[0];
    }
    if (this.container) {
      this.container.querySelectorAll('.file-card').forEach(c => {
        c.classList.add('selected');
        const cb = c.querySelector('.file-checkbox');
        if (cb) cb.checked = true;
      });
    }
    this.updateSelectionActionBar();
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
    const pathsToPaste = this.internalClipboard.paths;

    for (const srcPath of pathsToPaste) {
      const filename = srcPath.split('/').filter(Boolean).pop() || 'copied_file';
      const dstPath = targetDir === '/' ? `/${filename}` : `${targetDir}/${filename}`;
      if (srcPath === dstPath) continue;

      try {
        await fetch('/api/files/local/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: srcPath, dst: dstPath })
        });
      } catch (err) {
        console.error('Paste failed for', srcPath, err);
      }
    }
    this.loadDirectory(this.currentPath);
  }

  handleKeyDown(e) {
    const activeEl = document.activeElement;
    const tag = activeEl ? activeEl.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || activeEl?.isContentEditable) {
      return;
    }

    if (e.key === 'Escape') {
      this.closeMediaViewer();
      this.hideModal('modalNewFolder');
      this.hideModal('modalRename');
      this.hideModal('modalShareInternal');
      this.hideModal('modalSharePublic');
      this.hideModal('modalSettings');
      this.hideModal('modalFileDetails');
      this.hideContextMenu();
      this.clearSelection();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.selectAll();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      this.copySelection();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      this.pasteSelection();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (this.selectedPaths.size > 0) {
        this.batchDelete();
      } else if (this.selectedItem) {
        this.deleteSelectedItem();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      this.openSelectedItem();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.selectNextItem();
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      this.selectPreviousItem();
      return;
    }
  }

  showShareInternalModal() {
    this.hideContextMenu();
    if (!this.selectedItem) return;
    const nameEl = document.getElementById('shareItemNameText');
    if (nameEl) nameEl.textContent = `Target item: ${this.selectedItem.path}`;
    this.showModal('modalShareInternal');
  }

  showSharePublicModal() {
    this.hideContextMenu();
    if (!this.selectedItem) return;
    const nameEl = document.getElementById('publicShareItemNameText');
    if (nameEl) nameEl.textContent = `Target item: ${this.selectedItem.path}`;

    const resultBox = document.getElementById('publicLinkResultBox');
    if (resultBox) resultBox.style.display = 'none';

    this.showModal('modalSharePublic');
  }

  async createInternalShare() {
    if (!this.selectedItem) return;
    const usernameInput = document.getElementById('inputShareeUsername');
    const permSelect = document.getElementById('selectSharePermission');
    const shareeUsername = usernameInput?.value.trim();
    const readWrite = parseInt(permSelect?.value || '0', 10);

    if (!shareeUsername) {
      return alert('Please enter a username to share with.');
    }

    const providerType = this.currentViewType === 'provider' ? (this.currentProviderName?.toLowerCase().includes('dropbox') ? 'dropbox' : 'gdrive') : 'local';
    const providerConnectionId = this.currentViewType === 'provider' ? this.currentProviderId : null;

    try {
      const res = await fetch('/api/shares/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sharee_username: shareeUsername,
          file_path: this.selectedItem.path,
          is_directory: this.selectedItem.isDirectory ? 1 : 0,
          read_write: readWrite,
          provider_type: providerType,
          provider_connection_id: providerConnectionId
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to share item');
      }

      usernameInput.value = '';
      this.hideModal('modalShareInternal');
      alert(`Successfully shared "${this.selectedItem.name}" with ${shareeUsername}!`);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async createPublicShareLink() {
    if (!this.selectedItem) return;

    const label = document.getElementById('inputPublicLabel')?.value.trim();
    const password = document.getElementById('inputPublicPassword')?.value;
    const expiresAt = document.getElementById('inputPublicExpiresAt')?.value;
    const maxDownloads = document.getElementById('inputPublicMaxDownloads')?.value;

    const providerType = this.currentViewType === 'provider' ? (this.currentProviderName?.toLowerCase().includes('dropbox') ? 'dropbox' : 'gdrive') : 'local';
    const providerConnectionId = this.currentViewType === 'provider' ? this.currentProviderId : null;

    try {
      const res = await fetch('/api/shares/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_path: this.selectedItem.path,
          is_directory: this.selectedItem.isDirectory ? 1 : 0,
          label: label || null,
          password: password ? password.trim() : null,
          expires_at: expiresAt || null,
          max_downloads: maxDownloads ? parseInt(maxDownloads, 10) : null,
          provider_type: providerType,
          provider_connection_id: providerConnectionId
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create public share link');
      }

      const data = await res.json();
      const generatedInput = document.getElementById('inputGeneratedLink');
      const resultBox = document.getElementById('publicLinkResultBox');

      if (generatedInput) generatedInput.value = data.share_url;
      if (resultBox) resultBox.style.display = 'block';
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  copyGeneratedLink() {
    const generatedInput = document.getElementById('inputGeneratedLink');
    if (generatedInput && generatedInput.value) {
      navigator.clipboard.writeText(generatedInput.value);
      alert('Public share link copied to clipboard!');
    }
  }

  async batchDownloadZip() {
    if (this.selectedPaths.size === 0) return;
    const pathsArray = Array.from(this.selectedPaths);
    const query = pathsArray.map(p => encodeURIComponent(p)).join(',');
    window.location.href = `/api/files/local/batch/zip?paths=${query}`;
  }

  async batchDelete() {
    if (this.selectedPaths.size === 0) return;
    const pathsArray = Array.from(this.selectedPaths);
    if (!confirm(`Move ${pathsArray.length} selected item(s) to Trash?`)) return;

    try {
      const res = await fetch('/api/files/local/batch/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: pathsArray })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to move items to trash');
      }

      this.clearSelection();
      this.loadDirectory(this.currentPath);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async setViewMode(mode) {
    this.viewMode = mode;
    localStorage.setItem('fs-view-mode', mode);
    document.getElementById('btnGridView')?.classList.toggle('active', mode === 'grid');
    document.getElementById('btnListView')?.classList.toggle('active', mode === 'list');
    this.render();

    if (this.isSplitViewActive && this.secondaryState) {
      this.loadSecondaryDirectory(
        this.secondaryState.path,
        this.secondaryState.viewType,
        this.secondaryState.providerId,
        this.secondaryState.providerName
      );
    }

    try {
      await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredViewMode: mode })
      });
    } catch (err) {
      console.warn('Failed to save preferred view mode:', err.message);
    }
  }

  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
    if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return '🎥';
    if (['mp3', 'wav', 'flac'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📕';
    if (['zip', 'tar', 'gz', '7z'].includes(ext)) return '📦';
    if (['js', 'ts', 'py', 'json', 'html', 'css', 'txt', 'md'].includes(ext)) return '📄';
    return '📝';
  }

  getFileIconEmoji(filename) {
    return this.getFileIcon(filename);
  }

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  formatBytes(bytes) {
    return this.formatSize(bytes);
  }

  async openMediaViewer(item) {
    if (!this.mediaModal || !this.mediaViewerBody) return;

    this.currentMediaItem = item;
    if (this.mediaTitle) this.mediaTitle.textContent = item.name;

    const fileUrl = this.currentViewType === 'provider'
      ? `/api/providers/${this.currentProviderId}/read?path=${encodeURIComponent(item.path)}`
      : `/api/files/local/read?path=${encodeURIComponent(item.path)}`;

    const ext = item.name.split('.').pop().toLowerCase();

    this.mediaViewerBody.innerHTML = '<div style="color: var(--ink-muted);">Loading preview...</div>';
    this.mediaModal.style.display = 'flex';

    const imageToolbar = document.getElementById('imageEditToolbar');
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
      if (imageToolbar) imageToolbar.style.display = 'flex';
      this.mediaViewerBody.innerHTML = `<img id="previewImage" src="${fileUrl}" alt="${item.name}" style="max-width: 100%; max-height: 80vh; transition: transform 0.2s ease;" />`;
      this.initImageEditor(item, fileUrl);
    } else {
      if (imageToolbar) imageToolbar.style.display = 'none';
      if (['mp4', 'webm', 'mov'].includes(ext)) {
        this.mediaViewerBody.innerHTML = `<video controls autoplay src="${fileUrl}"></video>`;
      } else if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
        this.mediaViewerBody.innerHTML = `<audio controls autoplay src="${fileUrl}"></audio>`;
      } else if (['pdf'].includes(ext)) {
        this.mediaViewerBody.innerHTML = `<iframe src="${fileUrl}"></iframe>`;
      } else if (['txt', 'json', 'js', 'ts', 'py', 'html', 'css', 'md', 'sh', 'yml', 'yaml'].includes(ext)) {
        try {
          const res = await fetch(fileUrl);
          const text = await res.text();
          const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          this.mediaViewerBody.innerHTML = `<pre class="media-text-preview">${safeText}</pre>`;
        } catch (err) {
          this.mediaViewerBody.innerHTML = `<div style="color: var(--danger);">Failed to load text content</div>`;
        }
      } else {
        this.mediaViewerBody.innerHTML = `
          <div class="placeholder-card">
            <span style="font-size: 3rem;">📝</span>
            <h3 style="margin-top: 0.5rem; color: var(--ink);">No preview available</h3>
            <p style="font-size: 0.85rem; color: var(--ink-muted); margin-bottom: 1rem;">Direct in-browser preview is not supported for this file type.</p>
            <button class="fs-btn fs-btn--primary" onclick="window.fileBrowser.downloadFile('${item.path}')">⬇️ Download File</button>
          </div>
        `;
      }
    }
  }

  initImageEditor(item, fileUrl) {
    let rotation = 0;
    let flipH = false;

    const img = document.getElementById('previewImage');
    const updateTransform = () => {
      if (!img) return;
      let transformStr = `rotate(${rotation}deg)`;
      if (flipH) transformStr += ` scaleX(-1)`;
      img.style.transform = transformStr;
    };

    const btnRotate = document.getElementById('btnRotateImage');
    if (btnRotate) {
      btnRotate.onclick = () => {
        rotation = (rotation + 90) % 360;
        updateTransform();
      };
    }

    const btnFlip = document.getElementById('btnFlipImage');
    if (btnFlip) {
      btnFlip.onclick = () => {
        flipH = !flipH;
        updateTransform();
      };
    }

    const btnCrop = document.getElementById('btnCropImage');
    if (btnCrop) {
      btnCrop.onclick = () => {
        alert('Crop selection mode activated');
      };
    }

    const btnSave = document.getElementById('btnSaveImageTransform');
    if (btnSave) {
      btnSave.onclick = async () => {
        try {
          const ops = [];
          if (rotation) ops.push({ type: 'rotate', angle: rotation });
          if (flipH) ops.push({ type: 'flip', direction: 'horizontal' });

          const res = await fetch('/api/files/image/transform', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: item.path,
              operations: ops,
              rotate: rotation,
              flip: flipH ? 'horizontal' : undefined
            })
          });

          const data = await res.json();
          if (data.success) {
            alert('Image saved successfully!');
            this.fetchFiles();
          } else {
            alert(data.error || 'Failed to save image');
          }
        } catch (e) {
          alert('Error saving image: ' + e.message);
        }
      };
    }
  }

  async rotatePdf(itemPath, angle = 90) {
    try {
      const res = await fetch('/api/files/pdf/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: itemPath, angle })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to rotate PDF');
      }
      this.showToast ? this.showToast('PDF rotated successfully', 'success') : alert('PDF rotated successfully');
      this.fetchFiles();
      return data;
    } catch (err) {
      alert(`Error rotating PDF: ${err.message}`);
    }
  }

  async splitPdf(itemPath, ranges = null) {
    try {
      const res = await fetch('/api/files/pdf/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: itemPath, ranges })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to split PDF');
      }
      alert(`PDF split into ${data.createdFiles.length} file(s)`);
      this.fetchFiles();
      return data;
    } catch (err) {
      alert(`Error splitting PDF: ${err.message}`);
    }
  }

  async mergePdfs(filePaths, targetPath) {
    try {
      const res = await fetch('/api/files/pdf/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: filePaths, targetPath })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to merge PDFs');
      }
      alert('PDFs merged successfully');
      this.fetchFiles();
      return data;
    } catch (err) {
      alert(`Error merging PDFs: ${err.message}`);
    }
  }

  downloadSelectedItem() {
    this.hideContextMenu();
    if (this.selectedItem && !this.selectedItem.isDirectory) {
      this.downloadFile(this.selectedItem.path);
    }
  }

  downloadFile(filePath) {
    if (this.currentViewType === 'provider') {
      window.location.href = `/api/providers/${this.currentProviderId}/read?path=${encodeURIComponent(filePath)}`;
    } else {
      window.location.href = `/api/files/local/read?path=${encodeURIComponent(filePath)}`;
    }
  }

  /**
   * Ingest selected file into Paperless-ngx (#62)
   */
  async ingestPaperless() {
    this.hideContextMenu();
    if (!this.selectedItem || this.selectedItem.isDirectory) {
      return alert('Please select a file (not a folder) to import into Paperless-ngx.');
    }
    const filePath = this.selectedItem.path;
    try {
      const res = await fetch('/api/ecosystem/ingest/paperless', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const body = await res.json();
      if (res.status === 503) {
        alert('Paperless-ngx ist nicht konfiguriert. Bitte PAPERLESS_URL in der Serverkonfiguration setzen.');
        return;
      }
      if (!res.ok || !body.success) {
        alert(`Fehler beim Import in Paperless-ngx: ${body.error || 'Unbekannter Fehler'}`);
        return;
      }
      const msg = body.remoteId
        ? `✅ "${body.fileName}" wurde in Paperless-ngx importiert (ID: ${body.remoteId}).`
        : `✅ "${body.fileName}" wurde in Paperless-ngx übertragen.`;
      this._showToast(msg, 'success');
    } catch (err) {
      alert(`Netzwerkfehler beim Import in Paperless-ngx: ${err.message}`);
    }
  }

  /**
   * Ingest selected file into Immich (#62)
   */
  async ingestImmich() {
    this.hideContextMenu();
    if (!this.selectedItem || this.selectedItem.isDirectory) {
      return alert('Please select a file (not a folder) to import into Immich.');
    }
    const filePath = this.selectedItem.path;
    try {
      const res = await fetch('/api/ecosystem/ingest/immich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const body = await res.json();
      if (res.status === 503) {
        alert('Immich ist nicht konfiguriert. Bitte IMMICH_URL in der Serverkonfiguration setzen.');
        return;
      }
      if (!res.ok || !body.success) {
        alert(`Fehler beim Import in Immich: ${body.error || 'Unbekannter Fehler'}`);
        return;
      }
      const msg = body.remoteId
        ? `✅ "${body.fileName}" wurde in Immich importiert (Asset-ID: ${body.remoteId}).`
        : `✅ "${body.fileName}" wurde in Immich übertragen.`;
      this._showToast(msg, 'success');
    } catch (err) {
      alert(`Netzwerkfehler beim Import in Immich: ${err.message}`);
    }
  }

  /**
   * Show a transient toast notification.
   * Falls back gracefully if toast infrastructure is unavailable.
   */
  _showToast(message, type = 'info') {
    // Use existing toast if available, else console-log
    if (typeof this.showToast === 'function') {
      this.showToast(message, type);
    } else if (typeof window._showToast === 'function') {
      window._showToast(message, type);
    } else {
      console.info(`[Toast][${type}] ${message}`);
    }
  }

  promptFileConflict(existingFile, incomingFile) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modalFileConflict');
      const chkApplyToAll = document.getElementById('chkConflictApplyToAll');
      if (chkApplyToAll) chkApplyToAll.checked = false;

      if (!modal) return resolve({ choice: 'overwrite', applyToAll: false });

      const conflictFileName = document.getElementById('conflictFileName');
      if (conflictFileName) conflictFileName.textContent = incomingFile.name || 'Datei';

      // Existing File Card
      const existingNameEl = document.getElementById('existingFileName');
      const existingSizeEl = document.getElementById('existingFileSize');
      const existingMtimeEl = document.getElementById('existingFileMtime');
      const existingLocEl = document.getElementById('existingFileLocation');
      const existingPreviewEl = document.getElementById('existingFilePreview');

      if (existingNameEl) { existingNameEl.textContent = existingFile.name; existingNameEl.title = existingFile.name; }
      if (existingSizeEl) existingSizeEl.textContent = existingFile.size ? (this.formatBytes ? this.formatBytes(existingFile.size) : this.formatSize(existingFile.size)) : 'Unbekannt';
      if (existingMtimeEl) existingMtimeEl.textContent = existingFile.mtime ? new Date(existingFile.mtime).toLocaleString() : 'Vorhanden';
      if (existingLocEl) existingLocEl.textContent = existingFile.location || 'Zielort';

      if (existingPreviewEl) {
        const ext = (existingFile.name || '').split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext) && existingFile.previewUrl) {
          existingPreviewEl.innerHTML = `<img src="${existingFile.previewUrl}" style="max-height: 100%; max-width: 100%; object-fit: contain;">`;
        } else {
          existingPreviewEl.innerHTML = `<span style="font-size: 32px;">📄</span>`;
        }
      }

      // Incoming File Card
      const incomingNameEl = document.getElementById('incomingFileName');
      const incomingSizeEl = document.getElementById('incomingFileSize');
      const incomingMtimeEl = document.getElementById('incomingFileMtime');
      const incomingLocEl = document.getElementById('incomingFileLocation');
      const incomingPreviewEl = document.getElementById('incomingFilePreview');

      if (incomingNameEl) { incomingNameEl.textContent = incomingFile.name; incomingNameEl.title = incomingFile.name; }
      if (incomingSizeEl) incomingSizeEl.textContent = incomingFile.size ? (this.formatBytes ? this.formatBytes(incomingFile.size) : this.formatSize(incomingFile.size)) : 'Unbekannt';
      if (incomingMtimeEl) incomingMtimeEl.textContent = incomingFile.mtime ? new Date(incomingFile.mtime).toLocaleString() : 'Heute';
      if (incomingLocEl) incomingLocEl.textContent = incomingFile.location || 'Quelle';

      if (incomingPreviewEl) {
        const ext = (incomingFile.name || '').split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext) && incomingFile.previewUrl) {
          incomingPreviewEl.innerHTML = `<img src="${incomingFile.previewUrl}" style="max-height: 100%; max-width: 100%; object-fit: contain;">`;
        } else {
          incomingPreviewEl.innerHTML = `<span style="font-size: 32px;">📄</span>`;
        }
      }

      const btnCancel = document.getElementById('btnConflictCancel');
      const btnClose = document.getElementById('btnCancelConflictClose');
      const btnRename = document.getElementById('btnConflictRename');
      const btnOverwrite = document.getElementById('btnConflictOverwrite');

      const cleanup = () => {
        this.hideModal('modalFileConflict');
        btnCancel?.removeEventListener('click', onCancel);
        btnClose?.removeEventListener('click', onCancel);
        btnRename?.removeEventListener('click', onRename);
        btnOverwrite?.removeEventListener('click', onOverwrite);
      };

      const getApplyToAll = () => (document.getElementById('chkConflictApplyToAll')?.checked || false);

      const onCancel = () => { cleanup(); resolve({ choice: 'cancel', applyToAll: getApplyToAll() }); };
      const onRename = () => { cleanup(); resolve({ choice: 'rename', applyToAll: getApplyToAll() }); };
      const onOverwrite = () => { cleanup(); resolve({ choice: 'overwrite', applyToAll: getApplyToAll() }); };

      btnCancel?.addEventListener('click', onCancel);
      btnClose?.addEventListener('click', onCancel);
      btnRename?.addEventListener('click', onRename);
      btnOverwrite?.addEventListener('click', onOverwrite);

      this.showModal('modalFileConflict');
    });
  }

  generateNonConflictingName(originalName, existingNames) {
    const extIndex = originalName.lastIndexOf('.');
    let baseName = originalName;
    let ext = '';
    if (extIndex > 0) {
      baseName = originalName.substring(0, extIndex);
      ext = originalName.substring(extIndex);
    }

    let counter = 1;
    let candidate = `${baseName} (${counter})${ext}`;
    const nameSet = new Set(existingNames.map(n => n.toLowerCase()));
    while (nameSet.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${baseName} (${counter})${ext}`;
    }
    return candidate;
  }

  async readDroppedEntries(items) {
    const files = [];
    const traverseEntry = (entry, pathPrefix = '') => {
      return new Promise((resolve) => {
        if (!entry) return resolve();
        if (entry.isFile) {
          entry.file((file) => {
            const relPath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
            try {
              Object.defineProperty(file, 'relativePath', { value: relPath, writable: true, configurable: true });
            } catch (e) {
              file.relativePath = relPath;
            }
            files.push(file);
            resolve();
          }, () => resolve());
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const currentPrefix = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
          const readAll = () => {
            dirReader.readEntries(async (entries) => {
              if (!entries || !entries.length) {
                resolve();
              } else {
                for (const subEntry of entries) {
                  await traverseEntry(subEntry, currentPrefix);
                }
                readAll();
              }
            }, () => resolve());
          };
          readAll();
        } else {
          resolve();
        }
      });
    };

    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) {
        await traverseEntry(entry);
      }
    }
    return files;
  }

  renderUploadProgressQueue(fileList) {
    const queueEl = document.getElementById('uploadProgressQueue');
    const queueTitle = document.getElementById('queueTitle');
    const queueList = document.getElementById('queueItemsList');

    if (!queueEl || !queueList) return;
    queueEl.style.display = 'block';
    if (queueTitle) queueTitle.textContent = `Uploading ${fileList.length} item(s)...`;
    queueList.innerHTML = '';

    fileList.forEach((file, index) => {
      const fileName = file.name || file.filename || file.relativePath || `Item ${index + 1}`;
      const row = document.createElement('div');
      row.id = `queue-item-${index}`;
      row.className = 'queue-item';
      row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;';
      row.innerHTML = `
        <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; color: var(--text, #f8fafc);" title="${fileName}">
          ${fileName}
        </div>
        <div class="queue-item-status" id="queue-status-${index}" style="font-weight: bold; color: var(--accent-primary, #3b82f6);">⏳</div>
      `;
      queueList.appendChild(row);
    });
  }

  async handleUrlImportSubmit() {
    const inputUrl = document.getElementById('inputImportUrl')?.value?.trim();
    const inputFilename = document.getElementById('inputImportFilename')?.value?.trim();

    if (!inputUrl) return;

    this.hideModal('modalUrlImport');
    const displayFilename = inputFilename || inputUrl.split('/').filter(Boolean).pop() || 'imported_file';
    this.renderUploadProgressQueue([{ name: displayFilename }]);

    try {
      const res = await fetch('/api/files/local/url-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: inputUrl,
          path: this.currentPath,
          filename: inputFilename
        })
      });

      const queueStatusEl = document.getElementById('queue-status-0');
      const queueTitle = document.getElementById('queueTitle');
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (queueStatusEl) { queueStatusEl.textContent = '✖'; queueStatusEl.style.color = '#ef4444'; }
        if (queueTitle) queueTitle.textContent = 'Import failed';
        alert('URL Import Error: ' + (errData.error || 'Failed to import file from URL'));
      } else {
        if (queueStatusEl) { queueStatusEl.textContent = '✓'; queueStatusEl.style.color = '#10b981'; }
        if (queueTitle) queueTitle.textContent = 'Import complete';
      }
    } catch (err) {
      const queueStatusEl = document.getElementById('queue-status-0');
      if (queueStatusEl) { queueStatusEl.textContent = '✖'; queueStatusEl.style.color = '#ef4444'; }
      alert('URL Import Error: ' + err.message);
    } finally {
      if (document.getElementById('inputImportUrl')) document.getElementById('inputImportUrl').value = '';
      if (document.getElementById('inputImportFilename')) document.getElementById('inputImportFilename').value = '';
      if (this.currentViewType === 'provider') {
        this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, this.currentPath);
      } else {
        this.loadDirectory(this.currentPath);
      }
    }
  }

  async handleFileUpload(files) {
    if (!files || !files.length) return;

    const fileList = Array.from(files);
    this.renderUploadProgressQueue(fileList);

    const existingNames = this.items.map(i => i.name.toLowerCase());
    let rememberedChoice = null;

    for (let index = 0; index < fileList.length; index++) {
      const file = fileList[index];
      let finalFile = file;
      let finalName = file.name;
      const statusEl = document.getElementById(`queue-status-${index}`);

      if (existingNames.includes(file.name.toLowerCase())) {
        const existingItem = this.items.find(i => i.name.toLowerCase() === file.name.toLowerCase());
        const previewUrl = URL.createObjectURL(file);

        let choice = rememberedChoice;
        if (!choice) {
          const res = await this.promptFileConflict(
            {
              name: existingItem.name,
              size: existingItem.size,
              mtime: existingItem.updatedAt || existingItem.mtime,
              location: this.currentViewType === 'provider' ? this.currentProviderName : 'Local Home',
              previewUrl: this.currentViewType === 'provider'
                ? `/api/providers/${this.currentProviderId}/read?path=${encodeURIComponent(existingItem.path)}`
                : `/api/files/local/read?path=${encodeURIComponent(existingItem.path)}`
            },
            {
              name: file.name,
              size: file.size,
              mtime: file.lastModified,
              location: 'Browser Upload',
              previewUrl
            }
          );
          choice = typeof res === 'string' ? res : res.choice;
          if (typeof res === 'object' && res.applyToAll) {
            rememberedChoice = choice;
          }
        }

        if (choice === 'cancel') {
          if (statusEl) statusEl.textContent = '⏭';
          continue;
        } else if (choice === 'rename') {
          finalName = this.generateNonConflictingName(file.name, this.items.map(i => i.name));
          existingNames.push(finalName.toLowerCase());
        }
      }

      const uploadUrl = this.currentViewType === 'provider'
        ? `/api/providers/${this.currentProviderId}/upload`
        : '/api/files/local/upload';

      const formData = new FormData();
      formData.append('path', this.currentPath);
      const relPath = file.relativePath || file.webkitRelativePath || '';
      if (relPath) {
        formData.append('relativePath', relPath);
      }
      formData.append('file', finalFile, finalName);

      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          body: formData
        });

        if (!res.ok) {
          const err = await res.json();
          if (statusEl) { statusEl.textContent = '✖'; statusEl.style.color = '#ef4444'; }
          throw new Error(err.error || `Upload failed for ${finalName}`);
        }
        if (statusEl) { statusEl.textContent = '✓'; statusEl.style.color = '#10b981'; }
      } catch (err) {
        if (statusEl) { statusEl.textContent = '✖'; statusEl.style.color = '#ef4444'; }
        alert('Upload Error: ' + err.message);
      }
    }

    const queueTitle = document.getElementById('queueTitle');
    if (queueTitle) queueTitle.textContent = `Upload complete (${fileList.length} items)`;

    if (this.currentViewType === 'provider') {
      this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, this.currentPath);
    } else {
      this.loadDirectory(this.currentPath);
    }
  }

  closeMediaViewer() {
    if (this.mediaModal) {
      this.mediaModal.style.display = 'none';
      if (this.mediaViewerBody) this.mediaViewerBody.innerHTML = '';
      this.currentMediaItem = null;
    }
  }

  showContextMenu(x, y) {
    if (!this.contextMenu) return;
    this.contextMenu.style.left = `${x}px`;
    this.contextMenu.style.top = `${y}px`;
    this.contextMenu.style.display = 'block';
  }

  hideContextMenu() {
    if (this.contextMenu) this.contextMenu.style.display = 'none';
  }

  showTabContextMenu(x, y, tabObj) {
    const menu = document.getElementById('tabContextMenu');
    if (!menu) return;
    this.selectedTabForContext = tabObj;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
  }

  hideTabContextMenu() {
    const menu = document.getElementById('tabContextMenu');
    if (menu) menu.style.display = 'none';
  }

  showProviderContextMenu(x, y, conn) {
    const menu = document.getElementById('providerContextMenu');
    if (!menu) return;
    this.selectedProviderForContext = conn;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
  }

  hideProviderContextMenu() {
    const menu = document.getElementById('providerContextMenu');
    if (menu) menu.style.display = 'none';
  }

  async deleteProviderPermanently(connId, name) {
    if (!confirm(`Möchtest du die Kopplung mit "${name}" aufheben?\n\nDie Verbindung wird gelöscht, deine Freigaben bleiben für 90 Tage für eine erneute Kopplung im Hintergrund aufbewahrt.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/providers/${connId}`, { method: 'DELETE' });
      if (!res.ok) {
        const errText = await this.parseResponseError(res, 'Failed to unlink provider connection');
        throw new Error(errText);
      }
      await this.loadSidebarProviders();
      this.loadDirectory('/');
      alert('Kopplung wurde aufgehoben. Freigaben werden 90 Tage lang für eine erneute Reaktivierung aufbewahrt.');
    } catch (err) {
      alert('Fehler beim Aufheben der Kopplung: ' + err.message);
    }
  }

  async disconnectProvider(connId, name) {
    return this.deleteProviderPermanently(connId, name);
  }

  async reconnectProvider(connId) {
    this.showModal('modalAddProvider');
  }

  async openShareReconciliationWizard(connId) {
    const modal = document.getElementById('modalShareReconciliation');
    const countText = document.getElementById('reconcileCountText');
    const daysText = document.getElementById('reconcileDaysText');
    const listEl = document.getElementById('reconcileShareList');
    if (!modal || !listEl) return;

    try {
      const res = await fetch(`/api/providers/${connId}/reconcile-shares`);
      if (!res.ok) throw new Error('Failed to fetch orphaned shares');
      const data = await res.json();

      const internalShares = data.internalShares || [];
      const publicShares = data.publicShares || [];
      const totalCount = internalShares.length + publicShares.length;

      if (totalCount === 0) return;

      if (countText) countText.textContent = totalCount;
      if (daysText) daysText.textContent = data.retentionDays || 90;

      let html = '';

      internalShares.forEach(s => {
        html += `
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px; padding: 6px 10px; background: var(--surface); border-radius: var(--radius-sm); border: var(--border-w) solid var(--border);">
            <span>👥 Intern: <strong>${s.file_path}</strong> (Empfänger: ${s.sharee_display_name || s.sharee_username})</span>
            <span class="fs-mono" style="color: var(--ink-muted); font-size: 10px;">Aufbewahrt</span>
          </div>
        `;
      });

      publicShares.forEach(s => {
        html += `
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px; padding: 6px 10px; background: var(--surface); border-radius: var(--radius-sm); border: var(--border-w) solid var(--border);">
            <span>🔗 Öffentlicher Link: <strong>${s.file_path}</strong> ${s.label ? `(${s.label})` : ''}</span>
            <span class="fs-mono" style="color: var(--ink-muted); font-size: 10px;">Token: ${s.token.substring(0, 8)}...</span>
          </div>
        `;
      });

      listEl.innerHTML = html;

      const btnRestore = document.getElementById('btnReconcileRestore');
      const btnDiscard = document.getElementById('btnReconcileDiscard');

      const cleanup = () => {
        this.hideModal('modalShareReconciliation');
        btnRestore?.removeEventListener('click', onRestore);
        btnDiscard?.removeEventListener('click', onDiscard);
      };

      const onRestore = async () => {
        cleanup();
        try {
          const res = await fetch(`/api/providers/${connId}/reconcile-shares/restore`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to restore shares');
          alert('🎉 Freigaben wurden erfolgreich an das neue Konto gekoppelt!');
        } catch (e) {
          alert('Fehler beim Wiederherstellen: ' + e.message);
        }
      };

      const onDiscard = async () => {
        cleanup();
        try {
          const res = await fetch(`/api/providers/${connId}/reconcile-shares/discard`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to discard shares');
          alert('Aufbewahrte Freigaben wurden verworfen.');
        } catch (e) {
          alert('Fehler beim Verwerfen: ' + e.message);
        }
      };

      btnRestore?.addEventListener('click', onRestore);
      btnDiscard?.addEventListener('click', onDiscard);

      this.showModal('modalShareReconciliation');
    } catch (err) {
      console.warn('Share Reconciliation Wizard check skipped:', err.message);
    }
  }

  setActivePane(paneName) {
    this.store.dispatch('SET_ACTIVE_PANE', { pane: paneName });
    const priPane = document.getElementById('primaryPane');
    const secPane = document.getElementById('secondaryPane');

    if (paneName === 'primary') {
      priPane?.classList.add('active-pane');
      secPane?.classList.remove('active-pane');
    } else {
      secPane?.classList.add('active-pane');
      priPane?.classList.remove('active-pane');
    }
  }

  toggleSplitView(targetTab = null) {
    const wrapper = document.getElementById('panesWrapper');
    const secPane = document.getElementById('secondaryPane');
    const btn = document.getElementById('btnToggleSplitView');
    if (!wrapper || !secPane) return;

    this.store.dispatch('TOGGLE_SPLIT_VIEW', { targetTab });

    if (this.isSplitViewActive) {
      wrapper.classList.add('split-view-active');
      secPane.style.display = 'flex';
      if (btn) btn.classList.add('active');

      const secondaryTabObj = targetTab || this.tabs.find(t => t.id !== this.activeTabId) || this.tabs[0];

      this.loadSecondaryDirectory(
        secondaryTabObj ? secondaryTabObj.path : '/',
        secondaryTabObj ? secondaryTabObj.viewType : 'local',
        secondaryTabObj ? secondaryTabObj.providerId : null,
        secondaryTabObj ? secondaryTabObj.providerName : null
      );
      this.setActivePane('secondary');
    } else {
      wrapper.classList.remove('split-view-active');
      secPane.style.display = 'none';
      if (btn) btn.classList.remove('active');
      this.setActivePane('primary');
    }
  }

  renderSecondaryBreadcrumb(path, viewType = 'local', providerId = null, providerName = null) {
    const secBreadcrumb = document.getElementById('secondaryBreadcrumb');
    if (!secBreadcrumb) return;

    if (viewType === 'local') {
      const parts = (path || '/').split('/').filter(Boolean);
      let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" data-path="/">🏠 Home</span>`;

      let accumulatedPath = '';
      parts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const isActive = index === parts.length - 1;
        html += ` <span style="color: var(--ink-muted);">/</span> `;
        html += `<span class="breadcrumb-item ${isActive ? 'active' : ''}" data-path="${accumulatedPath}">${part}</span>`;
      });

      secBreadcrumb.innerHTML = html;

      secBreadcrumb.querySelectorAll('.breadcrumb-item').forEach(el => {
        const targetPath = el.getAttribute('data-path');
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
          this.loadSecondaryDirectory(targetPath, 'local');
        });
      });
    } else if (viewType === 'provider' && providerId) {
      const pName = providerName || 'Cloud Drive';
      const pathParts = (path || '/').split('/').filter(Boolean);
      const provType = pName.toLowerCase().includes('dropbox') ? 'dropbox' : (pName.toLowerCase().includes('google') ? 'gdrive' : 'cloud');
      const providerSvg = this.getProviderIconSvg(provType, 16);

      let html = `<span class="breadcrumb-item" data-path="home_root">🏠 Home</span>`;
      html += ` <span style="color: var(--ink-muted);">/</span> `;
      html += `<span class="breadcrumb-item ${pathParts.length === 0 ? 'active' : ''}" data-path="/" style="display: inline-flex; align-items: center; gap: 4px;">${providerSvg} ${pName}</span>`;

      let accumulatedPath = '';
      pathParts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const isActive = index === pathParts.length - 1;
        html += ` <span style="color: var(--ink-muted);">/</span> `;
        html += `<span class="breadcrumb-item ${isActive ? 'active' : ''}" data-path="${accumulatedPath}">${part}</span>`;
      });

      secBreadcrumb.innerHTML = html;

      secBreadcrumb.querySelectorAll('.breadcrumb-item').forEach(el => {
        const targetPath = el.getAttribute('data-path');
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
          if (targetPath === 'home_root') {
            this.loadSecondaryDirectory('/', 'local');
          } else {
            this.loadSecondaryDirectory(targetPath, 'provider', providerId, pName);
          }
        });
      });
    }
  }

  async loadSecondaryDirectory(path, viewType = 'local', providerId = null, providerName = null) {
    const secContainer = document.getElementById('secondaryFileContainer');
    if (!secContainer) return;

    const normProviderId = (providerId && providerId !== 'null' && providerId !== 'undefined') ? String(providerId) : null;
    this.secondaryState = { viewType, path, providerId: normProviderId, providerName };

    const activeTab = this.getActiveTab();
    if (activeTab) {
      activeTab.secondaryPath = path;
      activeTab.secondaryViewType = viewType;
      activeTab.secondaryProviderId = normProviderId;
      activeTab.secondaryProviderName = providerName;
      this.saveTabsToSession();
    }

    this.renderSecondaryBreadcrumb(path, viewType, normProviderId, providerName);

    try {
      let listUrl = (viewType === 'provider' && normProviderId)
        ? `/api/providers/${normProviderId}/list?path=${encodeURIComponent(path)}`
        : `/api/files/local/list?path=${encodeURIComponent(path)}`;

      const res = await fetch(listUrl);
      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || 'Failed to load secondary pane directory');
      }
      const data = await res.json();
      const items = data.items || [];
      this.secondaryItems = items;

      secContainer.className = this.viewMode === 'grid' ? 'grid-view' : 'list-view';

      if (this.viewMode === 'list') {
        secContainer.innerHTML = items.map(item => `
          <div class="file-card" data-name="${item.name}" data-path="${item.path}" data-is-dir="${item.isDirectory}" style="display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 12px; margin-bottom: 4px; border-radius: var(--radius-sm); border: var(--border-w) solid var(--border);">
            <div style="display: flex; align-items: center; gap: 12px;">
              <span class="file-icon" style="font-size: 20px;">${item.isDirectory ? '📁' : this.getFileIcon(item.name)}</span>
              <span class="file-name" style="font-size: 13px; font-weight: 500;">${item.name}</span>
            </div>
            <span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">${item.isDirectory ? '' : this.formatSize(item.size)}</span>
          </div>
        `).join('');
      } else {
        secContainer.innerHTML = items.map(item => `
          <div class="file-card" data-name="${item.name}" data-path="${item.path}" data-is-dir="${item.isDirectory}">
            <div class="file-icon" style="font-size: 24px;">${item.isDirectory ? '📁' : this.getFileIcon(item.name)}</div>
            <div class="file-name" style="font-size: 11px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</div>
          </div>
        `).join('');
      }

      secContainer.querySelectorAll('.file-card').forEach(card => {
        const isDir = card.getAttribute('data-is-dir') === 'true';
        const itemPath = card.getAttribute('data-path');
        const itemName = card.getAttribute('data-name');

        const activateSecItem = () => {
          if (isDir) {
            this.loadSecondaryDirectory(itemPath, viewType, normProviderId, providerName);
          } else {
            const item = items.find(i => i.path === itemPath || i.name === itemName);
            this.openMediaViewer(item || { name: itemName, path: itemPath });
          }
        };

        card.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
          if (this.clickNavigationMode === 'single') {
            activateSecItem();
          }
        });

        card.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
          if (this.clickNavigationMode !== 'single') {
            activateSecItem();
          }
        });
      });
    } catch (err) {
      console.error('Error in secondary pane:', err);
      secContainer.innerHTML = `<div style="padding: 12px; color: var(--danger); font-size: 12px;">Ordner konnte nicht geladen werden (${err.message})</div>`;
    }
  }

  showModal(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'flex';
  }

  hideModal(id) {
    const m = document.getElementById(id);
    if (m) m.style.display = 'none';
  }

  async createFolder() {
    const input = document.getElementById('inputFolderName');
    const folderName = input?.value.trim();
    if (!folderName) return;

    const targetPath = this.currentPath === '/' ? `/${folderName}` : `${this.currentPath}/${folderName}`;

    try {
      if (this.currentViewType === 'provider') {
        const res = await fetch(`/api/providers/${this.currentProviderId}/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to create folder in Cloud');
        }
        input.value = '';
        this.hideModal('modalNewFolder');
        this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, this.currentPath);
      } else {
        const res = await fetch('/api/files/local/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to create folder');
        }
        input.value = '';
        this.hideModal('modalNewFolder');
        this.loadDirectory(this.currentPath);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  showRenameModal() {
    this.hideContextMenu();
    if (!this.selectedItem) return;
    const input = document.getElementById('inputRenameName');
    if (input) input.value = this.selectedItem.name;
    this.showModal('modalRename');
  }

  async renameSelectedItem() {
    if (!this.selectedItem) return;
    const input = document.getElementById('inputRenameName');
    const newName = input?.value.trim();
    if (!newName || newName === this.selectedItem.name) {
      return this.hideModal('modalRename');
    }

    // Uniqueness & Collision Protection: Block renaming if target name already exists (#COLLISION-RENAME)
    const duplicateExists = this.items.some(i => i.name.toLowerCase() === newName.toLowerCase() && i.name !== this.selectedItem.name);
    if (duplicateExists) {
      alert(`Eine Datei oder ein Ordner mit dem Namen "${newName}" existiert bereits in diesem Verzeichnis.`);
      return;
    }

    const currentItemPath = this.selectedItem.path;
    const parts = currentItemPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.length === 0 ? '/' : '/' + parts.join('/');
    const dstPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;

    try {
      if (this.currentViewType === 'provider') {
        const res = await fetch(`/api/providers/${this.currentProviderId}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: currentItemPath, dst: dstPath })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to rename in Cloud');
        }

        this.hideModal('modalRename');
        this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, this.currentPath);
      } else {
        const res = await fetch('/api/files/local/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src: currentItemPath, dst: dstPath })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to rename');
        }

        this.hideModal('modalRename');
        this.loadDirectory(this.currentPath);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async deleteSelectedItem() {
    this.hideContextMenu();
    if (!this.selectedItem) return;

    if (this.currentViewType === 'provider') {
      if (!confirm(`Permanently delete "${this.selectedItem.name}" from Cloud Storage?`)) return;

      try {
        const res = await fetch(`/api/providers/${this.currentProviderId}/delete?path=${encodeURIComponent(this.selectedItem.path)}`, {
          method: 'DELETE'
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to delete from Cloud');
        }

        this.loadProviderDirectory(this.currentProviderId, this.currentProviderName, this.currentPath);
      } catch (err) {
        alert('Error: ' + err.message);
      }
      return;
    }

    if (!confirm(`Move "${this.selectedItem.name}" to Trash?`)) return;

    try {
      const res = await fetch(`/api/files/local?path=${encodeURIComponent(this.selectedItem.path)}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }

      this.loadDirectory(this.currentPath);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  openSelectedItem() {
    this.hideContextMenu();
    if (!this.selectedItem) return;
    if (this.selectedItem.isDirectory) {
      this.loadDirectory(this.selectedItem.path);
    } else {
      this.openMediaViewer(this.selectedItem);
    }
  }

  downloadSelectedItem() {
    this.hideContextMenu();
    if (this.selectedItem && !this.selectedItem.isDirectory) {
      this.downloadFile(this.selectedItem.path);
    }
  }

  downloadFile(filePath) {
    window.location.href = `/api/files/local/read?path=${encodeURIComponent(filePath)}`;
  }

  showFileDetailsModalFromContextMenu() {
    this.hideContextMenu();
    if (this.selectedItem) {
      this.showFileDetailsModal(this.selectedItem);
    }
  }

  showFileDetailsModalFromToolbar() {
    if (this.selectedPaths.size === 1) {
      const selectedPath = Array.from(this.selectedPaths)[0];
      const item = this.items.find(i => i.path === selectedPath);
      if (item) {
        this.showFileDetailsModal(item);
      }
    } else if (this.selectedItem) {
      this.showFileDetailsModal(this.selectedItem);
    }
  }

  async showFileDetailsModal(item) {
    if (!item) return;

    this.selectedItem = item;
    const modal = document.getElementById('modalFileDetails');
    if (!modal) return;

    document.getElementById('detailsFileName').textContent = item.name;
    document.getElementById('detailsFilePath').textContent = item.path;
    document.getElementById('detailsFileIcon').textContent = item.isDirectory ? '📁' : '📄';
    document.getElementById('detailsFileSize').textContent = item.size ? this.formatSize(item.size) : (item.isDirectory ? 'Directory' : '-');
    document.getElementById('detailsFileType').textContent = item.isDirectory ? 'Directory' : (item.mimeType || 'File');
    const createdEl = document.getElementById('detailsFileCreated');
    if (createdEl) createdEl.textContent = item.created ? new Date(item.created).toLocaleString() : (item.created_at ? new Date(item.created_at).toLocaleString() : '-');
    const mtimeEl = document.getElementById('detailsFileMtime');
    if (mtimeEl) mtimeEl.textContent = item.mtime ? new Date(item.mtime).toLocaleString() : (item.updated_at ? new Date(item.updated_at).toLocaleString() : '-');
    const providerEl = document.getElementById('detailsFileProvider');
    if (providerEl) providerEl.textContent = item.provider || item.provider_type || 'Local Shard';
    const ownerEl = document.getElementById('detailsFileOwner');
    if (ownerEl) ownerEl.textContent = item.owner || 'You';

    const internalList = document.getElementById('detailsInternalSharesList');
    const publicList = document.getElementById('detailsPublicSharesList');
    if (internalList) internalList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">Loading shares...</span>';
    if (publicList) publicList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">Loading links...</span>';

    this.showModal('modalFileDetails');

    try {
      const res = await fetch(`/api/shares/overview?path=${encodeURIComponent(item.path)}`);
      if (!res.ok) throw new Error('Failed to load sharing overview');
      const data = await res.json();

      if (data.file_metadata) {
        const meta = data.file_metadata;
        if (createdEl && meta.created_at) createdEl.textContent = new Date(meta.created_at).toLocaleString();
        if (mtimeEl && meta.updated_at) mtimeEl.textContent = new Date(meta.updated_at).toLocaleString();
        if (providerEl && meta.provider) providerEl.textContent = meta.provider;
        const sizeEl = document.getElementById('detailsFileSize');
        if (sizeEl && meta.size) sizeEl.textContent = this.formatSize(meta.size);
        const typeEl = document.getElementById('detailsFileType');
        if (typeEl && meta.mimeType) typeEl.textContent = meta.mimeType;
      }

      if (internalList) {
        if (data.internal_shares && data.internal_shares.length > 0) {
          internalList.innerHTML = data.internal_shares.map(s => `
            <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg); padding: 6px 10px; border-radius: var(--radius-control); border: var(--border-w) solid var(--border-cool); font-size: 12px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="fs-mono" style="font-weight: 600;">${s.sharee_display_name || s.sharee_username}</span>
                <span style="font-size: 10px; color: var(--ink-muted); font-family: var(--font-mono);">(${s.read_write ? 'Read/Write' : 'Read Only'})</span>
              </div>
              <button class="fs-btn fs-btn--danger text-sm btn-revoke-internal-share" data-id="${s.id}" style="padding: 2px 6px; font-size: 10px;">Revoke</button>
            </div>
          `).join('');

          internalList.querySelectorAll('.btn-revoke-internal-share').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const shareId = e.target.getAttribute('data-id');
              await fetch(`/api/shares/internal/${shareId}`, { method: 'DELETE' });
              this.showFileDetailsModal(item);
            });
          });
        } else {
          internalList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">Not shared with any users</span>';
        }
      }

      if (publicList) {
        if (data.public_shares && data.public_shares.length > 0) {
          publicList.innerHTML = data.public_shares.map(p => {
            const labelText = p.label ? `<span class="fs-mono" style="font-weight: 600; color: var(--ink); margin-right: 6px;">🏷️ ${p.label}</span>` : '';
            const expiresFormatted = p.expires_at ? new Date(p.expires_at).toLocaleString() : 'Never';
            const safeShareJson = JSON.stringify(p).replace(/'/g, "&#39;");

            return `
              <div style="display: flex; flex-direction: column; gap: 4px; background: var(--bg); padding: 8px 10px; border-radius: var(--radius-control); border: var(--border-w) solid var(--border-cool); font-size: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div>
                    ${labelText}
                    <span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">${p.share_url}</span>
                  </div>
                  <div style="display: flex; gap: 4px;">
                    <button class="fs-btn text-sm btn-edit-public-link" data-share='${safeShareJson}' style="padding: 2px 6px; font-size: 10px;">✏️ Edit</button>
                    <button class="fs-btn fs-btn--primary text-sm btn-copy-public-link" data-url="${p.share_url}" style="padding: 2px 6px; font-size: 10px;">📋 Copy</button>
                    <button class="fs-btn fs-btn--danger text-sm btn-revoke-public-link" data-id="${p.id}" style="padding: 2px 6px; font-size: 10px;">Revoke</button>
                  </div>
                </div>
                <div style="display: flex; gap: 12px; font-size: 10px; color: var(--ink-muted); font-family: var(--font-mono);">
                  <span>🔒 Password: ${p.password_protected ? 'Yes' : 'No'}</span>
                  <span>📅 Expires: ${expiresFormatted}</span>
                  <span>📥 Downloads: ${p.download_count}${p.max_downloads ? `/${p.max_downloads}` : ''}</span>
                </div>
              </div>
            `;
          }).join('');

          publicList.querySelectorAll('.btn-edit-public-link').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const shareData = JSON.parse(btn.getAttribute('data-share'));
              this.showEditPublicShareModal(shareData, item);
            });
          });

          publicList.querySelectorAll('.btn-copy-public-link').forEach(btn => {
            btn.addEventListener('click', (e) => {
              const url = e.target.getAttribute('data-url');
              navigator.clipboard.writeText(url);
              alert('📋 Link copied to clipboard!');
            });
          });

          publicList.querySelectorAll('.btn-revoke-public-link').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              const shareId = e.target.getAttribute('data-id');
              await fetch(`/api/shares/public/${shareId}`, { method: 'DELETE' });
              this.showFileDetailsModal(item);
            });
          });
        } else {
          publicList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">No active public share links</span>';
        }
      }
    } catch (err) {
      console.error('Error loading overview:', err);
    }
  }

  showEditPublicShareModal(shareData, item) {
    this.currentEditShare = shareData;
    this.currentEditItem = item;

    document.getElementById('editPublicShareId').value = shareData.id;
    document.getElementById('inputEditPublicLabel').value = shareData.label || '';
    document.getElementById('inputEditPublicPassword').value = '';
    document.getElementById('checkRemovePassword').checked = false;
    document.getElementById('inputEditPublicExpiresAt').value = shareData.expires_at ? shareData.expires_at.substring(0, 16) : '';
    document.getElementById('inputEditPublicMaxDownloads').value = shareData.max_downloads || '';

    this.showModal('modalEditPublicShare');
  }

  async updatePublicShareLink() {
    const shareId = document.getElementById('editPublicShareId')?.value;
    if (!shareId) return;

    const label = document.getElementById('inputEditPublicLabel')?.value.trim();
    const password = document.getElementById('inputEditPublicPassword')?.value;
    const removePassword = document.getElementById('checkRemovePassword')?.checked;
    const expiresAt = document.getElementById('inputEditPublicExpiresAt')?.value;
    const maxDownloads = document.getElementById('inputEditPublicMaxDownloads')?.value;

    try {
      const res = await fetch(`/api/shares/public/${shareId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label || null,
          password: password ? password.trim() : undefined,
          remove_password: removePassword,
          expires_at: expiresAt || null,
          max_downloads: maxDownloads ? parseInt(maxDownloads, 10) : null
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update public share link');
      }

      this.hideModal('modalEditPublicShare');
      if (this.currentEditItem) {
        this.showFileDetailsModal(this.currentEditItem);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }
}

if (typeof window !== 'undefined') {
  window.FileBrowser = FileBrowser;
  window.FileBrowserStore = FileBrowserStore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FileBrowser, FileBrowserStore };
}

