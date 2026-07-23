// FreeShard Files — Main Application Frontend JavaScript
document.addEventListener('DOMContentLoaded', async () => {
  const userMenu = document.getElementById('userMenu');
  const btnThemeToggle = document.getElementById('btnThemeToggle');

  // Theme Switcher (Light <-> Dark / Dusk)
  const currentTheme = localStorage.getItem('fs-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);

  btnThemeToggle?.addEventListener('click', () => {
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fs-theme', theme);
  });

  // Initialize File Browser UI (#10, #11, #12)
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
          <div style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 10px; border-radius: var(--radius-control); background: var(--bg); border: var(--border-w) solid var(--border-cool);">
            <span class="fs-avatar" style="width: 28px; height: 28px; font-size: 12px; font-weight: 600; color: var(--ink);">
              ${shownName.charAt(0).toUpperCase()}
            </span>
            <span class="fs-mono" style="font-weight: 500; font-size: var(--fs-mono); color: var(--ink);">${shownName}</span>
          </div>
        `;
      }
    } else {
      if (userMenu) {
        userMenu.innerHTML = `<a href="/api/auth/login" class="fs-btn fs-btn--primary">Log in</a>`;
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
  }
});
