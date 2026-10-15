import { THEMES, type Theme } from '@files/shared';

// The theme (#159): `data-theme` on <html> selects the token set in styles/tokens.css. "system" follows the device's
// preference, also when it changes while the app is open.

export const themeFor = (setting: Theme, prefersDark: boolean): 'light' | 'dark' =>
  setting === 'system' ? (prefersDark ? 'dark' : 'light') : setting;

const CACHE_KEY = 'files.theme';
let chosen: Theme = 'system';
let media: MediaQueryList | undefined;

function render() {
  media ??= window.matchMedia('(prefers-color-scheme: dark)');
  document.documentElement.dataset.theme = themeFor(chosen, media.matches);
}

/** Applies the setting and remembers it on the device for the next first paint. */
export function applyTheme(setting: Theme) {
  chosen = setting;
  render();
  try { localStorage.setItem(CACHE_KEY, setting); }
  catch { /* handled: storage blocked → the next start paints the system theme until /api/v1/me answers */ }
}

/** At startup, before the server answers: the device's last known setting, else "system". Watches the device. */
export function startTheme() {
  let stored: string | null = null;
  try { stored = localStorage.getItem(CACHE_KEY); }
  catch { /* handled: storage blocked → "system" */ }
  chosen = (THEMES as readonly string[]).includes(stored ?? '') ? stored as Theme : 'system';
  render();
  media!.addEventListener('change', render);
}
