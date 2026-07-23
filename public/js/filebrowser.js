class FileBrowser {
  constructor() {
    this.currentPath = '/';
    this.viewMode = 'grid'; // 'grid' or 'list'
    this.items = [];
    this.selectedItem = null;

    this.container = document.getElementById('fileContainer');
    this.breadcrumb = document.getElementById('breadcrumb');
    this.contentArea = document.getElementById('contentArea');
    this.dropOverlay = document.getElementById('dropOverlay');
    this.contextMenu = document.getElementById('contextMenu');

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.loadDirectory(this.currentPath);
  }

  setupEventListeners() {
    // View Toggle
    document.getElementById('btnGridView')?.addEventListener('click', () => this.setViewMode('grid'));
    document.getElementById('btnListView')?.addEventListener('click', () => this.setViewMode('list'));

    // Upload Input
    document.getElementById('fileInput')?.addEventListener('change', (e) => this.handleFileUpload(e.target.files));

    // New Folder Modal
    document.getElementById('btnNewFolder')?.addEventListener('click', () => this.showModal('modalNewFolder'));
    document.getElementById('btnCancelNewFolder')?.addEventListener('click', () => this.hideModal('modalNewFolder'));
    document.getElementById('btnConfirmNewFolder')?.addEventListener('click', () => this.createFolder());

    // Rename Modal
    document.getElementById('btnCancelRename')?.addEventListener('click', () => this.hideModal('modalRename'));
    document.getElementById('btnConfirmRename')?.addEventListener('click', () => this.renameSelectedItem());

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
    document.getElementById('ctxDownload')?.addEventListener('click', () => this.downloadSelectedItem());
    document.getElementById('ctxRename')?.addEventListener('click', () => this.showRenameModal());
    document.getElementById('ctxDelete')?.addEventListener('click', () => this.deleteSelectedItem());
  }

  async loadDirectory(dirPath) {
    this.currentPath = dirPath;
    this.renderBreadcrumb();

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
      this.container.innerHTML = `<div class="placeholder-card"><p style="color: var(--color-error);">${err.message}</p></div>`;
    }
  }

  renderBreadcrumb() {
    if (!this.breadcrumb) return;

    const parts = this.currentPath.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item ${parts.length === 0 ? 'active' : ''}" data-path="/">Home</span>`;

    let accumulatedPath = '';
    parts.forEach((part, index) => {
      accumulatedPath += '/' + part;
      const isActive = index === parts.length - 1;
      html += ` <span style="color: var(--color-text-muted);">/</span> `;
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
      this.container.innerHTML = `
        <div class="placeholder-card" style="grid-column: 1 / -1;">
          <span style="font-size: 3rem;">📂</span>
          <h3 style="margin-top: 0.5rem; color: var(--color-text-secondary);">This folder is empty</h3>
          <p style="font-size: 0.85rem; color: var(--color-text-muted);">Upload files or create a subfolder to get started.</p>
        </div>
      `;
      return;
    }

    this.container.className = this.viewMode === 'grid' ? 'grid-view' : 'list-view';

    this.container.innerHTML = this.items.map(item => {
      const isDir = item.isDirectory;
      const icon = isDir ? '📁' : this.getFileIcon(item.name);
      const sizeStr = isDir ? '' : this.formatSize(item.size);

      return `
        <div class="file-card" data-name="${item.name}" data-is-dir="${isDir}" data-path="${item.path}">
          <div class="file-icon">${icon}</div>
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-meta">${sizeStr}</div>
        </div>
      `;
    }).join('');

    // Card Event Listeners
    this.container.querySelectorAll('.file-card').forEach(card => {
      card.addEventListener('dblclick', () => {
        const isDir = card.getAttribute('data-is-dir') === 'true';
        const itemPath = card.getAttribute('data-path');
        if (isDir) {
          this.loadDirectory(itemPath);
        } else {
          this.downloadFile(itemPath);
        }
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const name = card.getAttribute('data-name');
        const isDir = card.getAttribute('data-is-dir') === 'true';
        const path = card.getAttribute('data-path');

        this.selectedItem = { name, isDirectory: isDir, path };
        this.showContextMenu(e.clientX, e.clientY);
      });
    });
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
    if (['js', 'ts', 'py', 'json', 'html', 'css'].includes(ext)) return '📄';
    return '📝';
  }

  formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
    if (!confirm(`Delete "${this.selectedItem.name}"?`)) return;

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
      this.downloadFile(this.selectedItem.path);
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
