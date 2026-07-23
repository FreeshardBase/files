// FreeShard Files - Main Application Frontend JavaScript
document.addEventListener('DOMContentLoaded', async () => {
  const userMenu = document.getElementById('userMenu');

  // Initialize File Browser UI (#10)
  if (typeof FileBrowser !== 'undefined') {
    window.fileBrowser = new FileBrowser();
  }

  // Check current auth status (#2, #48)
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated && data.user) {
      const shownName = data.user.displayName || data.user.username || 'User';
      if (userMenu) {
        userMenu.innerHTML = `
          <div style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 4px 8px; border-radius: var(--radius-md); background: var(--color-bg-secondary); border: 1px solid var(--color-border);">
            <span style="width: 32px; height: 32px; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; color: #ffffff; font-weight: 700; font-size: 0.95rem;">
              ${shownName.charAt(0).toUpperCase()}
            </span>
            <span style="font-weight: 600; font-size: 0.95rem; color: var(--color-text-primary); display: inline-block;">${shownName}</span>
          </div>
        `;
      }
    } else {
      if (userMenu) {
        userMenu.innerHTML = `<a href="/api/auth/login" class="btn btn-primary">Log in</a>`;
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
  }
});
