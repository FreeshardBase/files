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

  // Fetch Public Auth Config (#2, #54, #55)
  async function loadAuthConfig() {
    try {
      const res = await fetch('/api/auth/config');
      if (!res.ok) return null;

      const config = await res.json();
      const ssoContainer = document.getElementById('ssoLoginContainer');
      const ssoText = document.getElementById('btnSsoLoginText');
      const divider = document.getElementById('loginDivider');
      const localForm = document.getElementById('localLoginForm');

      // 1. Customize SSO Button Label
      if (ssoText && config.oidcButtonLabel) {
        ssoText.textContent = config.oidcButtonLabel;
      }

      // 2. Hide SSO Button if OIDC is disabled
      if (ssoContainer && config.enableOidcAuth === false) {
        ssoContainer.style.display = 'none';
      }

      // 3. Hide Local Auth Form if ENABLE_LOCAL_AUTH is false
      if (localForm && config.enableLocalAuth === false) {
        localForm.style.display = 'none';
      }

      // 4. Hide Divider if either auth method is disabled
      if (divider && (config.enableLocalAuth === false || config.enableOidcAuth === false)) {
        divider.style.display = 'none';
      }

      return config;
    } catch (err) {
      console.warn('Could not load auth config:', err.message);
      return null;
    }
  }

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

  // Check current auth status (#2, #48, #55)
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
        // Unauthenticated State: Check for Auto-OIDC Redirect (#55)
        const config = await loadAuthConfig();
        if (config && config.enableAutoOidcAuth && !sessionStorage.getItem('fs_oidc_redirecting')) {
          sessionStorage.setItem('fs_oidc_redirecting', 'true');
          window.location.href = '/api/auth/login';
          return;
        }

        if (mainApp) mainApp.style.display = 'none';
        if (loginScreen) loginScreen.style.display = 'flex';
      }
    } catch (err) {
      console.error('Auth check error:', err);
      if (mainApp) mainApp.style.display = 'none';
      if (loginScreen) loginScreen.style.display = 'flex';
      await loadAuthConfig();
    }
  }

  await checkAuth();
});
