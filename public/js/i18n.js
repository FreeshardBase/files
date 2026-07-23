let currentLocale = 'en';
let messages = {};

async function loadLocale(locale) {
  try {
    const res = await fetch(`/locales/${locale}.json`);
    if (!res.ok) {
      if (locale !== 'en') return loadLocale('en');
      return;
    }
    messages = await res.json();
    currentLocale = locale;
    document.documentElement.lang = locale;
  } catch (err) {
    console.warn(`[i18n] Failed to load locale ${locale}:`, err);
  }
}

function t(key, params = {}) {
  const template = key.split('.').reduce((obj, k) => obj?.[k], messages);
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
}

function formatDate(date, style = 'medium') {
  return new Intl.DateTimeFormat(currentLocale, { dateStyle: style }).format(new Date(date));
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 1 }).format(size) + ' ' + units[i];
}

window.i18n = { loadLocale, t, formatDate, formatFileSize, currentLocale };
