class FileBrowser {
  constructor() {
    this.currentPath = '/';
    this.currentViewType = 'local'; // 'local', 'shared', or 'trash'
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

    // Sidebar Navigation (#14, #18)
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
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      document.getElementById('navTrash')?.classList.add('active');
      this.loadTrash();
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
    document.getElementById('ctxShareInternal')?.addEventListener('click', () => this.showShareInternalModal());
    document.getElementById('ctxSharePublic')?.addEventListener('click', () => this.showSharePublicModal());
    document.getElementById('ctxDownload')?.addEventListener('click', () => this.downloadSelectedItem());
    document.getElementById('ctxRename')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('ctxDelete')?.addEventListener('click', () => this.deleteSelectedItem());
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
      this.render();
    } catch (err) {
      console.error('Error loading directory:', err);
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

  async loadTrash() {
    this.currentViewType = 'trash';
    this.clearSelection();
    if (this.breadcrumb) {
      this.breadcrumb.innerHTML = `<span class="breadcrumb-item active">Trash (Auto-deletes after 30 days)</span>`;
    }

    const emptyTrashBtn = document.getElementById('btnEmptyTrash');
    if (emptyTrashBtn) emptyTrashBtn.style.display = 'inline-flex';

    try {
      const res = await fetch('/api/trash');
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to load trash');
      }

      const data = await res.json();
      const trashItems = data.items || [];

      this.items = trashItems.map(t => ({
        id: t.id,
        name: t.original_name,
        path: t.original_path,
        isDirectory: !!t.is_directory,
        size: t.size_bytes,
        deletedAt: t.deleted_at,
        expiresAt: t.expires_at,
        isTrashItem: true
      }));

      this.render();
    } catch (err) {
      console.error('Error loading trash:', err);
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
      const isDir = item.isDirectory;
      const icon = isDir ? '📁' : this.getFileIcon(item.name);
      
      let metaText = '';
      if (item.isTrashItem) {
        metaText = `Original: ${item.path}`;
      } else if (item.isSharedItem) {
        metaText = `Shared by ${item.owner}`;
      } else {
        metaText = isDir ? '' : this.formatSize(item.size);
      }

      const isChecked = this.selectedPaths.has(item.path || item.id);

      return `
        <div class="file-card ${isChecked ? 'selected' : ''}" data-id="${item.id || ''}" data-name="${item.name}" data-is-dir="${isDir}" data-path="${item.path}">
          ${item.isTrashItem ? '' : `<input type="checkbox" class="file-checkbox" ${isChecked ? 'checked' : ''} />`}
          <div class="file-icon">${icon}</div>
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-meta" style="font-size: 11px;">${metaText}</div>
          ${item.isTrashItem ? `
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

    // Card & Checkbox Event Listeners (#12, #14, #15)
    this.container.querySelectorAll('.file-card').forEach(card => {
      const checkbox = card.querySelector('.file-checkbox');
      const itemPath = card.getAttribute('data-path');

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
        if (this.currentViewType === 'trash') return;
        const isDir = card.getAttribute('data-is-dir') === 'true';
        const name = card.getAttribute('data-name');
        if (isDir) {
          this.loadDirectory(itemPath);
        } else {
          this.openMediaViewer({ name, path: itemPath });
        }
      });

      card.addEventListener('contextmenu', (e) => {
        if (this.currentViewType === 'trash') return;
        e.preventDefault();
        const name = card.getAttribute('data-name');
        const isDir = card.getAttribute('data-is-dir') === 'true';
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

  // ── Media & File Viewer Overlay (#11) ───────────────────────────────────────
  async openMediaViewer(item) {
    if (!this.mediaModal || !this.mediaViewerBody) return;

    this.currentMediaItem = item;
    if (this.mediaTitle) this.mediaTitle.textContent = item.name;

    const fileUrl = `/api/files/local/read?path=${encodeURIComponent(item.path)}`;
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
}

window.FileBrowser = FileBrowser;
