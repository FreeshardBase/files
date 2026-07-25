class FileBrowser {
  constructor() {
    this.currentPath = '/';
    this.currentViewType = 'local'; // 'local', 'shared', 'trash', or 'activity'
    this.currentTrashId = null;
    this.currentTrashSubpath = '/';
    this.viewMode = 'grid'; // 'grid' or 'list'
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

    this.init();
  }

  init() {
    this.checkOAuthCallback();
    this.setupEventListeners();
    this.loadDirectory(this.currentPath);
  }

  checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('gdrive_connected') === 'true') {
      alert('🎉 Successfully connected Google Drive account via OAuth 2.0!');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  setupEventListeners() {
    // View Toggle
    document.getElementById('btnGridView')?.addEventListener('click', () => this.setViewMode('grid'));
    document.getElementById('btnListView')?.addEventListener('click', () => this.setViewMode('list'));

    // Upload Input
    document.getElementById('fileInput')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));

    // 1-Click Google OAuth Provider Connection (#7)
    document.getElementById('btnAddCloudDrive')?.addEventListener('click', () => {
      window.location.href = '/api/providers/gdrive/auth';
    });

    // Sidebar Navigation (#14, #18, #22)
    document.getElementById('navHome')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.currentViewType = 'local';
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('navHome')?.classList.add('active');
      this.loadDirectory('/');
    });

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

    // Drag & Drop Upload Overlay
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropOverlay?.classList.add('active');
    });

    this.dropOverlay?.addEventListener('dragleave', (e) => {
      e.preventDefault();
      this.dropOverlay.classList.remove('active');
    });

    this.dropOverlay?.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropOverlay.classList.remove('active');
      if (e.dataTransfer.files.length) {
        this.handleFileUpload(e.dataTransfer.files);
      }
    });

    // Close Context Menu on Global Click
    document.addEventListener('click', () => this.hideContextMenu());

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

  async loadDirectory(dirPath) {
    this.currentViewType = 'local';
    this.currentPath = dirPath;
    this.clearSelection();
    this.renderBreadcrumb();

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

      // If viewing root directory, also fetch connected Cloud Drives (#7)
      if (dirPath === '/') {
        try {
          const connRes = await fetch('/api/providers/connections');
          if (connRes.ok) {
            const connData = await connRes.json();
            const connections = connData.connections || [];
            connections.forEach(conn => {
              this.items.unshift({
                name: conn.display_name || 'Google Drive',
                path: '/',
                isDirectory: true,
                isCloudDrive: true,
                providerId: conn.id,
                providerType: conn.provider_type,
                mimeType: 'cloud/drive'
              });
            });
          }
        } catch (e) {
          console.error('Error fetching provider connections:', e);
        }
      }

      this.render();
    } catch (err) {
      console.error('Error loading directory:', err);
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--danger);">${err.message}</p></div>`;
    }
  }

  async loadProviderDirectory(providerId, providerName, dirPath) {
    this.currentViewType = 'provider';
    this.currentProviderId = providerId;
    this.currentProviderName = providerName;
    this.currentPath = dirPath;
    this.clearSelection();

    if (this.breadcrumb) {
      const pathParts = dirPath.split('/').filter(Boolean);
      let crumbHtml = `<span class="breadcrumb-item"><a href="#/files" onclick="window.fileBrowser.loadDirectory('/')">🏠 Home</a></span>`;
      crumbHtml += ` <span class="breadcrumb-separator">/</span> `;
      crumbHtml += `<span class="breadcrumb-item ${pathParts.length === 0 ? 'active' : ''}"><a href="#" onclick="window.fileBrowser.loadProviderDirectory(${providerId}, '${providerName}', '/')">☁️ ${providerName}</a></span>`;

      let accumPath = '';
      pathParts.forEach((part, index) => {
        accumPath += '/' + part;
        const isLast = index === pathParts.length - 1;
        crumbHtml += ` <span class="breadcrumb-separator">/</span> `;
        if (isLast) {
          crumbHtml += `<span class="breadcrumb-item active">${part}</span>`;
        } else {
          crumbHtml += `<span class="breadcrumb-item"><a href="#" onclick="window.fileBrowser.loadProviderDirectory(${providerId}, '${providerName}', '${accumPath}')">${part}</a></span>`;
        }
      });
      this.breadcrumb.innerHTML = crumbHtml;
    }

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

  async loadSharedWithMe() {
    this.currentViewType = 'shared';
    this.clearSelection();
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

  async loadTrash(trashId = null, subpath = '/') {
    this.currentViewType = 'trash';
    this.currentTrashId = trashId;
    this.currentTrashSubpath = subpath;
    this.clearSelection();

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
      if (!trashId) {
        const res = await fetch('/api/trash');
        if (!res.ok) throw new Error('Failed to load trash items');
        const data = await res.json();

        this.items = (data.items || []).map(t => ({
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
        const res = await fetch(`/api/trash/inspect?id=${encodeURIComponent(trashId)}&subpath=${encodeURIComponent(subpath)}`);
        if (!res.ok) throw new Error('Failed to inspect trash folder');
        const data = await res.json();

        this.items = (data.items || []).map(item => ({
          id: trashId,
          name: item.name,
          path: item.path,
          subpath: item.subpath,
          isDirectory: !!item.isDirectory,
          size: item.size,
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

  async loadActivity() {
    this.currentViewType = 'activity';
    this.clearSelection();

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
    if (!this.breadcrumb || this.currentViewType !== 'local') return;

    const parts = this.currentPath.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" data-path="/">Home</span>`;

    let accumulatedPath = '';
    parts.forEach((part, index) => {
      accumulatedPath += '/' + part;
      const isActive = index === parts.length - 1;
      html += ` <span style="color: var(--ink-muted);">/</span> `;
      html += `<span class="breadcrumb-item ${isActive ? 'active' : ''}" data-path="${accumulatedPath}">${part}</span>`;
    });

    this.breadcrumb.innerHTML = html;

    this.breadcrumb.querySelectorAll('.breadcrumb-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const targetPath = e.target.getAttribute('data-path');
        if (targetPath && targetPath !== this.currentPath) {
          this.loadDirectory(targetPath);
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
      const icon = isCloudDrive ? '☁️' : (isDir ? '📁' : this.getFileIcon(item.name));

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
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
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
    });
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

  setViewMode(mode) {
    this.viewMode = mode;
    document.getElementById('btnGridView')?.classList.toggle('active', mode === 'grid');
    document.getElementById('btnListView')?.classList.toggle('active', mode === 'list');
    this.render();
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

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

  async handleFileUpload(files) {
    if (!files || !files.length) return;

    const uploadUrl = this.currentViewType === 'provider'
      ? `/api/providers/${this.currentProviderId}/upload`
      : '/api/files/local/upload';

    for (const file of files) {
      const formData = new FormData();
      formData.append('path', this.currentPath);
      formData.append('file', file);

      try {
        const res = await fetch(uploadUrl, {
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

    const parentPath = this.currentPath;
    const dstPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;

    try {
      const res = await fetch('/api/files/local/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: this.selectedItem.path, dst: dstPath })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to rename');
      }

      this.hideModal('modalRename');
      this.loadDirectory(this.currentPath);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async deleteSelectedItem() {
    this.hideContextMenu();
    if (!this.selectedItem) return;
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
