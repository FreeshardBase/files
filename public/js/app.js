// FreeShard Files - Main Application Frontend JavaScript
document.addEventListener('DOMContentLoaded', async () => {
  const userMenu = document.getElementById('userMenu');
  const pathBreadcrumb = document.getElementById('path-breadcrumb');
  const fileGrid = document.getElementById('file-grid');

  // Check current auth status (#2, #48)
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated && data.user) {
      const shownName = data.user.displayName || data.user.username || 'User';
      if (userMenu) {
        userMenu.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <span style="width: 32px; height: 32px; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: 0.9rem;">
              ${shownName.charAt(0).toUpperCase()}
            </span>
            <span style="font-weight: 500; font-size: 0.95rem; color: var(--color-text);">${shownName}</span>
          </div>
        `;
      }
    } else {
      if (userMenu) {
        userMenu.innerHTML = `<a href="/api/auth/login" class="btn btn-primary" style="padding: 6px 14px; font-size: 0.9rem;">Log in</a>`;
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
  }
});
