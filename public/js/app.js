// FreeShard Files — Main Application Frontend JavaScript
document.addEventListener('DOMContentLoaded', async () => {
  const userMenu = document.getElementById('userMenu');
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const loginScreen = document.getElementById('loginScreen');
  const mainApp = document.getElementById('app');

  // Theme Switcher (Light <-> Dark / Dusk)
  const currentTheme = localStorage.getItem('fs-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);

  btnThemeToggle?.addEventListener('click', () => {
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fs-theme', theme);
  });

  // Local Auth Login Form Handler
  const localLoginForm = document.getElementById('localLoginForm');
  const loginErrorMsg = document.getElementById('loginErrorMsg');

  localLoginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername')?.value.trim();
    const password = document.getElementById('loginPassword')?.value;

    if (!username || !password) return;
    if (loginErrorMsg) loginErrorMsg.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Login failed');
      }

      // Reload page on successful login to initialize session
      window.location.reload();
    } catch (err) {
      if (loginErrorMsg) {
        loginErrorMsg.textContent = err.message;
        loginErrorMsg.style.display = 'block';
      }
    }
  });

  // Check current auth status (#2, #48)
  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();

      if (data.authenticated && data.user) {
        // Authenticated State: Show App Dashboard, Hide Login Screen
        if (loginScreen) loginScreen.style.display = 'none';
        if (mainApp) mainApp.style.display = 'flex';

        // Initialize File Browser UI
        if (typeof FileBrowser !== 'undefined' && !window.fileBrowser) {
          window.fileBrowser = new FileBrowser();
        }

        const shownName = data.user.displayName || data.user.username || 'User';
        if (userMenu) {
          userMenu.innerHTML = `
            <div style="display: flex; align-items: center; gap: var(--space-3);">
              <div style="display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: var(--radius-control); background: var(--bg); border: var(--border-w) solid var(--border-cool);">
                <span class="fs-avatar" style="width: 24px; height: 24px; border-radius: 50%; background: var(--line); font-size: 11px; font-weight: 600; color: #fff; display: flex; align-items: center; justify-content: center;">
                  ${shownName.charAt(0).toUpperCase()}
                </span>
                <span class="fs-mono" style="font-weight: 500; font-size: var(--fs-mono); color: var(--ink);">${shownName}</span>
              </div>
              <button id="btnLogout" class="fs-btn text-sm" style="padding: 4px 10px; font-size: 12px;">Log out</button>
            </div>
          `;

          document.getElementById('btnLogout')?.addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.reload();
          });
        }
      } else {
        // Unauthenticated State: Show Login Screen, Hide App Dashboard
        if (mainApp) mainApp.style.display = 'none';
        if (loginScreen) loginScreen.style.display = 'flex';
      }
    } catch (err) {
      console.error('Auth check error:', err);
      if (mainApp) mainApp.style.display = 'none';
      if (loginScreen) loginScreen.style.display = 'flex';
    }
  }

  await checkAuth();
});
