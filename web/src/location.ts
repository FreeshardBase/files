// Where an item lives, written one way everywhere (#244): the source's root name, then the folders, joined by " › "
// ("My storage › Projects", "Dropbox › Reports"), never a path with a leading slash.
import { useI18n } from 'vue-i18n';
import { useConnectionsStore } from './stores/connections.ts';

export const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';

/** A root name and a folder path as one label: `joinLocation('My storage', '/Projects/2026')` is "My storage › Projects › 2026". */
export const joinLocation = (root: string, path: string): string => [root, ...path.split('/').filter(Boolean)].join(' › ');

export function useLocations() {
  const { t } = useI18n();
  const connections = useConnectionsStore();
  /** The root's name: "My storage", a cloud's provider ("Dropbox"; the account is shown apart), "Shared with me". */
  const sourceName = (source: string): string => {
    if (source === 'home') return t('nav.home');
    const c = connections.bySource(source);
    if (c) return c.providerName;
    return source.startsWith('share:') ? t('nav.shared') : t('nav.connections');
  };
  /** The account of a cloud source, shown muted beside its provider; null for every other source. */
  const sourceAccount = (source: string): string | null => connections.bySource(source)?.account ?? null;
  const folderLabel = (source: string, path: string): string => joinLocation(sourceName(source), path);
  return { sourceName, sourceAccount, folderLabel };
}
