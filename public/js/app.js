// FreeShard Files - Main Application Frontend JavaScript
document.addEventListener('DOMContentLoaded', async () => {
  const userMenu = document.getElementById('user-menu');
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
          <div class="flex items-center gap-2">
            <span class="user-avatar" style="width: 28px; height: 28px; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 0.8rem;">
              ${shownName.charAt(0).toUpperCase()}
            </span>
            <span class="font-medium text-sm">${shownName}</span>
          </div>
        `;
      }
    } else {
      if (userMenu) {
        userMenu.innerHTML = `<a href="/api/auth/login" class="btn btn-primary text-sm">Log in</a>`;
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
  }
});
