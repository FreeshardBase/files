const path = require('path');
const fs = require('fs');

const translations = {};
const supportedLocales = ['en', 'de'];
const defaultLocale = 'en';

function loadTranslations() {
  const localesDir = path.join(__dirname, '..', '..', 'locales');
  for (const lang of supportedLocales) {
    const filePath = path.join(localesDir, `${lang}.json`);
    if (fs.existsSync(filePath)) {
      translations[lang] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
      translations[lang] = {};
    }
  }
}

loadTranslations();

function getNestedValue(obj, keyPath) {
  return keyPath.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : null), obj);
}

function resolveLocale(req) {
  if (req.query && req.query.lang && supportedLocales.includes(req.query.lang)) {
    return req.query.lang;
  }
  if (req.session && req.session.preferredLocale && supportedLocales.includes(req.session.preferredLocale)) {
    return req.session.preferredLocale;
  }
  const acceptLang = req.headers ? req.headers['accept-language'] : '';
  if (acceptLang) {
    if (acceptLang.includes('de')) return 'de';
    if (acceptLang.includes('en')) return 'en';
  }
  return defaultLocale;
}

function translate(locale, key, params = {}) {
  const targetLocale = supportedLocales.includes(locale) ? locale : defaultLocale;
  let text = getNestedValue(translations[targetLocale], key);

  if (!text && targetLocale !== defaultLocale) {
    text = getNestedValue(translations[defaultLocale], key);
  }

  if (!text) return key;

  Object.keys(params).forEach(param => {
    text = text.replace(new RegExp(`{${param}}`, 'g'), params[param]);
  });

  return text;
}

function i18nMiddleware(req, res, next) {
  req.locale = resolveLocale(req);
  req.t = (key, params) => translate(req.locale, key, params);
  next();
}

function getTranslations(locale) {
  const target = supportedLocales.includes(locale) ? locale : defaultLocale;
  return translations[target] || translations[defaultLocale];
}

module.exports = {
  loadTranslations,
  resolveLocale,
  translate,
  i18nMiddleware,
  getTranslations,
  supportedLocales
};
