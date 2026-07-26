class FileBrowser {
  constructor(initialViewMode = 'grid') {
    this.currentPath = '/';
    this.currentViewType = 'local'; // 'local', 'shared', 'trash', or 'activity'
    this.currentTrashId = null;
    this.currentTrashSubpath = '/';
    this.viewMode = localStorage.getItem('fs-view-mode') || initialViewMode || 'grid';
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

    // Multi-Tab UI System (#60)
    this.tabs = [];
    this.activeTabId = null;

    this.init();
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
    this.loadSidebarProviders();
    this.loadTabsFromSession();

    const activeTab = this.getActiveTab();
    if (activeTab) {
      this.switchTab(activeTab.id);
    } else {
      this.loadDirectory(this.currentPath);
    }
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
      return this.getProviderIconSvg('cloud', size);
    }
    if (tab.viewType === 'shared') return '🔗';
    if (tab.viewType === 'trash') return '🗑️';
    if (tab.viewType === 'activity') return '🕒';
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

    const newTab = {
      id: newId,
      title,
      viewType,
      path,
      providerId,
      providerName
    };
    this.tabs.push(newTab);
    this.switchTab(newId);
  }

  switchTab(tabId) {
    const targetTab = this.tabs.find(t => t.id === tabId);
    if (!targetTab) return;

    if (this.isSplitViewActive) {
      if (tabId === this.secondaryTabId) {
        this.setActivePane('secondary');
        this.renderTabBar();
        return;
      } else if (tabId === this.primaryTabId) {
        this.setActivePane('primary');
        this.renderTabBar();
        return;
      }

      if (this.activePane === 'secondary') {
        this.secondaryTabId = tabId;
        this.loadSecondaryDirectory(
          targetTab.path || '/',
          targetTab.viewType,
          targetTab.providerId,
          targetTab.providerName
        );
        this.renderTabBar();
        return;
      } else {
        this.primaryTabId = tabId;
        this.activeTabId = tabId;
      }
    } else {
      this.activeTabId = tabId;
    }

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

    this.renderTabBar();
  }

  closeTab(tabId, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (this.tabs.length <= 1) {
      const lastTab = this.tabs[0];
      lastTab.title = 'Home';
      lastTab.viewType = 'local';
      lastTab.path = '/';
      lastTab.providerId = null;
      lastTab.providerName = null;
      this.switchTab(lastTab.id);
      return;
    }

    const index = this.tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    this.tabs.splice(index, 1);
    if (this.activeTabId === tabId) {
      const nextTab = this.tabs[Math.max(0, index - 1)];
      this.activeTabId = nextTab.id;
      this.switchTab(nextTab.id);
    } else {
      this.saveTabsToSession();
      this.renderTabBar();
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
            const [movedTab] = this.tabs.splice(fromIdx, 1);
            this.tabs.splice(toIdx, 0, movedTab);
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

  checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('gdrive_connected') === 'true') {
      alert('🎉 Successfully connected Google Drive account via OAuth 2.0!');
      window.history.replaceState({}, document.title, window.location.pathname);
      this.loadSidebarProviders();
    } else if (urlParams.get('dropbox_connected') === 'true') {
      alert('🎉 Successfully connected Dropbox account via OAuth 2.0!');
      window.history.replaceState({}, document.title, window.location.pathname);
      this.loadSidebarProviders();
    }
  }

  getProviderIconSvg(providerType, size = 18) {
    if (providerType === 'gdrive') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; flex-shrink: 0;"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.2-2.1 7.4-12.8c.8-1.4 1.2-2.95 1.2-4.5h-27.5l6.85 11.85z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.95-1.2-4.5-1.2h-18.5c-1.55 0-3.15.4-4.5 1.2z" fill="#00832d"/><path d="m59.8 50h27.5c0-1.55-.4-3.1-1.2-4.5l-13.75-23.8c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8z" fill="#ffba00"/><path d="m27.5 50 13.75 23.8c1.35.8 2.95 1.2 4.5 1.2h27.5c1.55 0 3.15-.4 4.5-1.2l-13.75-23.8z" fill="#2684fc"/></svg>`;
    }
    if (providerType === 'dropbox') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#0061FF" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle; flex-shrink: 0;"><path d="M6 2L0 6l6 4 6-4-6-4zm12 0l-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4l-6 4 6 4 6-4-6-4zM6 19.5l6 4 6-4-6-3.5-6 3.5z"/></svg>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; flex-shrink: 0;"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
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
            <a href="#/provider/${conn.id}">
              <span class="nav-icon" style="display: flex; align-items: center; justify-content: center;">${icon}</span>
              <span class="fs-label" style="text-transform: none; letter-spacing: normal;">${name} ${!isEnabled ? '<small style="font-size: 10px; color: var(--ink-muted);">(Entkoppelt)</small>' : ''}</span>
            </a>
          </li>
        `;
      }).join('');

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
        if (this.selectedProviderForContext.enabled !== 0) {
          this.disconnectProvider(this.selectedProviderForContext.id);
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

    // Upload Input
    document.getElementById('fileInput')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));

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

    // Rename Modal
    document.getElementById('btnCancelRename')?.addEventListener('click', () => this.hideModal('modalRename'));
    document.getElementById('btnConfirmRename')?.addEventListener('click', () => this.renameSelectedItem());

    // Internal Share Modal (#14)
    document.getElementById('btnCancelShare')?.addEventListener('click', () => this.hideModal('modalShareInternal'));
    document.getElementById('btnConfirmShare')?.addEventListener('click', () => this.createInternalShare());

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

    // Keyboard Shortcuts (Esc to close modal & clear selection)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeMediaViewer();
        this.hideModal('modalNewFolder');
        this.hideModal('modalRename');
        this.hideModal('modalShareInternal');
        this.hideModal('modalSharePublic');
        this.hideContextMenu();
        this.clearSelection();
      }
    });

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

    this.dropOverlay?.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropOverlay.classList.remove('active');
      if (this.isInternalDragging || this.activeDragPayload) return;
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

  async loadDirectory(dirPath, updateTab = true) {
    this.currentViewType = 'local';
    this.currentPath = dirPath;
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

  async loadProviderDirectory(providerId, providerName, dirPath, updateTab = true) {
    this.currentViewType = 'provider';
    this.currentProviderId = String(providerId);
    this.currentProviderName = providerName;
    this.currentPath = dirPath;
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

  async loadSharedWithMe(updateTab = true) {
    this.currentViewType = 'shared';
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

  async loadTrash(trashId = null, subpath = '/', updateTab = true) {
    this.currentViewType = 'trash';
    this.currentTrashId = trashId;
    this.currentTrashSubpath = subpath;
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

  async loadActivity(updateTab = true) {
    this.currentViewType = 'activity';
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

    // Card & Checkbox Event Listeners (#12, #14, #15, #18)
    this.container.querySelectorAll('.file-card').forEach(card => {
      const checkbox = card.querySelector('.file-checkbox');
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

      card.addEventListener('click', (e) => {
        if (checkbox && e.target !== checkbox) {
          if (this.selectedPaths.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey) {
            const newState = !this.selectedPaths.has(itemPath);
            checkbox.checked = newState;
            this.toggleItemSelection(itemPath, newState, card);
          }
        }
      });

      card.addEventListener('dblclick', () => {
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

      const processedItems = [];
      for (const item of items) {
        let finalName = item.name;
        const matchingExisting = destItems.find(i => i.name.toLowerCase() === item.name.toLowerCase());

        if (matchingExisting) {
          const srcLocation = srcViewType === 'provider' ? (dragData.providerName || 'Cloud Drive') : 'Local Home';
          const destLocation = destProviderId ? 'Cloud Drive' : 'Local Home';

          const existingPreviewUrl = destProviderId
            ? `/api/providers/${destProviderId}/read?path=${encodeURIComponent(matchingExisting.path)}`
            : `/api/files/local/read?path=${encodeURIComponent(matchingExisting.path)}`;

          const incomingPreviewUrl = srcViewType === 'provider' && srcProviderId
            ? `/api/providers/${srcProviderId}/read?path=${encodeURIComponent(item.srcPath)}`
            : `/api/files/local/read?path=${encodeURIComponent(item.srcPath)}`;

          const choice = await this.promptFileConflict(
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

          if (choice === 'cancel') {
            continue;
          } else if (choice === 'rename') {
            finalName = this.generateNonConflictingName(item.name, destItems.map(i => i.name));
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

    try {
      const res = await fetch('/api/shares/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sharee_username: shareeUsername,
          file_path: this.selectedItem.path,
          is_directory: this.selectedItem.isDirectory ? 1 : 0,
          read_write: readWrite
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
          max_downloads: maxDownloads ? parseInt(maxDownloads, 10) : null
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

    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) {
      this.mediaViewerBody.innerHTML = `<img src="${fileUrl}" alt="${item.name}" />`;
    } else if (['mp4', 'webm', 'mov'].includes(ext)) {
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

  promptFileConflict(existingFile, incomingFile) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modalFileConflict');
      if (!modal) return resolve('overwrite');

      const conflictFileName = document.getElementById('conflictFileName');
      if (conflictFileName) conflictFileName.textContent = incomingFile.name || 'Datei';

      // Existing File Card
      const existingNameEl = document.getElementById('existingFileName');
      const existingSizeEl = document.getElementById('existingFileSize');
      const existingMtimeEl = document.getElementById('existingFileMtime');
      const existingLocEl = document.getElementById('existingFileLocation');
      const existingPreviewEl = document.getElementById('existingFilePreview');

      if (existingNameEl) { existingNameEl.textContent = existingFile.name; existingNameEl.title = existingFile.name; }
      if (existingSizeEl) existingSizeEl.textContent = existingFile.size ? this.formatBytes(existingFile.size) : 'Unbekannt';
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
      if (incomingSizeEl) incomingSizeEl.textContent = incomingFile.size ? this.formatBytes(incomingFile.size) : 'Unbekannt';
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

      const onCancel = () => { cleanup(); resolve('cancel'); };
      const onRename = () => { cleanup(); resolve('rename'); };
      const onOverwrite = () => { cleanup(); resolve('overwrite'); };

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

  async handleFileUpload(files) {
    if (!files || !files.length) return;

    const existingNames = this.items.map(i => i.name.toLowerCase());

    for (const file of files) {
      let finalFile = file;
      let finalName = file.name;

      if (existingNames.includes(file.name.toLowerCase())) {
        const existingItem = this.items.find(i => i.name.toLowerCase() === file.name.toLowerCase());
        const previewUrl = URL.createObjectURL(file);

        const choice = await this.promptFileConflict(
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

        if (choice === 'cancel') {
          continue;
        } else if (choice === 'rename') {
          finalName = this.generateNonConflictingName(file.name, this.items.map(i => i.name));
        }
      }

      const uploadUrl = this.currentViewType === 'provider'
        ? `/api/providers/${this.currentProviderId}/upload`
        : '/api/files/local/upload';

      const formData = new FormData();
      formData.append('path', this.currentPath);
      formData.append('file', finalFile, finalName);

      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          body: formData
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Upload failed for ${finalName}`);
        }
      } catch (err) {
        alert('Upload Error: ' + err.message);
      }
    }

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

    const toggleItem = document.getElementById('ctxProviderToggleState');
    if (toggleItem) {
      toggleItem.textContent = conn.enabled !== 0 ? '🔌 Entkoppeln (Soft Disconnect)' : '⚡ Reaktivieren (Reconnect)';
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = 'block';
  }

  hideProviderContextMenu() {
    const menu = document.getElementById('providerContextMenu');
    if (menu) menu.style.display = 'none';
  }

  async disconnectProvider(connId) {
    try {
      const res = await fetch(`/api/providers/${connId}/disconnect`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to disconnect provider');
      await this.loadSidebarProviders();
      alert('Cloud-Speicher wurde entkoppelt. Zugehörige Freigabelinks wurden pausiert.');
    } catch (err) {
      alert('Fehler beim Entkoppeln: ' + err.message);
    }
  }

  async reconnectProvider(connId) {
    try {
      const res = await fetch(`/api/providers/${connId}/reconnect`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to reconnect provider');
      const data = await res.json();

      await this.loadSidebarProviders();

      if (data.requiresReconciliation) {
        this.openShareReconciliationWizard(connId, data.suspendedCount);
      } else {
        alert('Cloud-Speicher erfolgreich reaktiviert.');
      }
    } catch (err) {
      alert('Fehler beim Reaktivieren: ' + err.message);
    }
  }

  async deleteProviderPermanently(connId, name) {
    if (!confirm(`Möchtest du den Cloud-Speicher "${name}" und ALLE zugehörigen Freigaben wirklich ENDGÜLTIG löschen?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/providers/${connId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete provider connection');
      await this.loadSidebarProviders();
      this.loadDirectory('/');
      alert('Cloud-Speicher wurde endgültig entfernt.');
    } catch (err) {
      alert('Fehler beim Löschen: ' + err.message);
    }
  }

  async openShareReconciliationWizard(connId, suspendedCount) {
    const modal = document.getElementById('modalShareReconciliation');
    const countText = document.getElementById('reconcileCountText');
    const listEl = document.getElementById('reconcileShareList');
    if (!modal || !listEl) return;

    if (countText) countText.textContent = suspendedCount;

    try {
      const res = await fetch(`/api/providers/${connId}/reconcile-shares`);
      if (!res.ok) throw new Error('Failed to fetch suspended shares');
      const data = await res.json();

      const internalShares = data.internalShares || [];
      const publicShares = data.publicShares || [];

      let html = '';

      internalShares.forEach(s => {
        html += `
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px; padding: 6px 10px; background: var(--surface); border-radius: var(--radius-sm); border: var(--border-w) solid var(--border);">
            <span>👥 Intern: <strong>${s.file_path}</strong> (Empfänger: ${s.sharee_display_name || s.sharee_username})</span>
            <span class="fs-mono" style="color: var(--ink-muted); font-size: 10px;">Pausiert</span>
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

      listEl.innerHTML = html || '<div style="font-size: 12px; color: var(--ink-muted);">Keine pausierten Freigaben gefunden.</div>';

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
          alert('🎉 Alle pausierten Freigaben wurden erfolgreich wiederhergestellt!');
        } catch (e) {
          alert('Fehler beim Wiederherstellen: ' + e.message);
        }
      };

      const onDiscard = async () => {
        cleanup();
        try {
          const res = await fetch(`/api/providers/${connId}/reconcile-shares/discard`, { method: 'POST' });
          if (!res.ok) throw new Error('Failed to discard shares');
          alert('Pausierte Freigaben wurden verworfen.');
        } catch (e) {
          alert('Fehler beim Verwerfen: ' + e.message);
        }
      };

      btnRestore?.addEventListener('click', onRestore);
      btnDiscard?.addEventListener('click', onDiscard);

      this.showModal('modalShareReconciliation');
    } catch (err) {
      alert('Wizard Error: ' + err.message);
    }
  }

  setActivePane(paneName) {
    this.activePane = paneName;
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

    this.isSplitViewActive = !this.isSplitViewActive;

    if (this.isSplitViewActive) {
      wrapper.classList.add('split-view-active');
      secPane.style.display = 'flex';
      if (btn) btn.classList.add('active');

      this.primaryTabId = this.activeTabId;

      const secondaryTabObj = targetTab || this.tabs.find(t => t.id !== this.activeTabId) || this.tabs[0];
      this.secondaryTabId = secondaryTabObj ? secondaryTabObj.id : this.activeTabId;

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

        card.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
        });

        card.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.setActivePane('secondary');
          if (isDir) {
            this.loadSecondaryDirectory(itemPath, viewType, normProviderId, providerName);
          } else {
            const item = items.find(i => i.path === itemPath || i.name === itemName);
            this.openMediaViewer(item || { name: itemName, path: itemPath });
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

  async handleFileUpload(files) {
    if (!files || !files.length) return;

    for (const file of files) {
      const formData = new FormData();
      formData.append('path', this.currentPath);
      formData.append('file', file);

      try {
        const res = await fetch('/api/files/local/upload', {
          method: 'POST',
          body: formData
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Upload failed for ${file.name}`);
        }
      } catch (err) {
        alert('Upload Error: ' + err.message);
      }
    }

    this.loadDirectory(this.currentPath);
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
    document.getElementById('detailsFileMtime').textContent = item.mtime ? new Date(item.mtime).toLocaleString() : '-';
    document.getElementById('detailsFileOwner').textContent = item.owner || 'You';

    const internalList = document.getElementById('detailsInternalSharesList');
    const publicList = document.getElementById('detailsPublicSharesList');
    if (internalList) internalList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">Loading shares...</span>';
    if (publicList) publicList.innerHTML = '<span class="fs-mono" style="font-size: 11px; color: var(--ink-muted);">Loading links...</span>';

    this.showModal('modalFileDetails');

    try {
      const res = await fetch(`/api/shares/overview?path=${encodeURIComponent(item.path)}`);
      if (!res.ok) throw new Error('Failed to load sharing overview');
      const data = await res.json();

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

window.FileBrowser = FileBrowser;
