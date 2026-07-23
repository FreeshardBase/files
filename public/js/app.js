document.addEventListener('DOMContentLoaded', async () => {
  // Load initial locale (detect from navigator.language)
  const lang = (navigator.language || 'en').split('-')[0];
  await window.i18n.loadLocale(lang === 'de' ? 'de' : 'en');
  
  // Translate static data-i18n attributes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = window.i18n.t(key);
  });

  // Check Auth State
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    const userMenu = document.getElementById('userMenu');

    if (data.authenticated) {
      userMenu.innerHTML = `<span style="font-size:0.875rem; color: var(--color-text-secondary);">👤 ${data.user.username}</span>`;
    } else {
      userMenu.innerHTML = `<a href="/api/auth/login" style="color: var(--color-accent); text-decoration: none;">Log in</a>`;
    }
  } catch (err) {
    console.warn('Auth check error:', err);
  }
});
