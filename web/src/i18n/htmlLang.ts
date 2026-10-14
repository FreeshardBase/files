import { watch, type WatchHandle, type WatchSource } from 'vue';

/** Language tag for <html lang>: both German variants are `de`. */
export const htmlLangFor = (locale: string): string => (locale.startsWith('de') ? 'de' : 'en');

/** Keeps document.documentElement.lang in sync with the active locale, now and on every change. */
export function syncHtmlLang(locale: WatchSource<string>, doc: Document = document): WatchHandle {
  return watch(locale, (l) => { doc.documentElement.lang = htmlLangFor(l); }, { immediate: true });
}
