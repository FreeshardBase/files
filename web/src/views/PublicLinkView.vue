<script setup lang="ts">
// The share page of a public link (#147), for visitors without an account. Everything about the item comes from
// `/s/<token>/info` as data and is shown as text (no v-html), under the app's strict CSP. A locked link asks for its
// password first. A download is a plain link to the content route; a refused one comes back here with `?error=<code>`.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Entry, ErrorCode, PublicLinkInfo } from '@files/shared';
import { ApiFailure } from '../api/client.ts';
import { linkContentHref, linkInfo, linkList, pageError, unlockLink } from '../api/publicLink.ts';
import { previewKind } from '../preview.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';

const route = useRoute();
const { t, locale } = useI18n();
const token = computed(() => String(route.params.token));
const path = computed(() => (typeof route.query.path === 'string' && route.query.path.startsWith('/') ? route.query.path : '/'));
const refused = computed(() => pageError(route.query.error));
const info = ref<PublicLinkInfo | null>(null);
const entries = ref<Entry[] | null>(null);
const failure = ref<ErrorCode | 'NETWORK' | null>(null);
const password = ref('');
const passwordError = ref('');
const busy = ref(false);
const passwordInput = ref<HTMLInputElement>();

const code = (e: unknown) => { if (!(e instanceof ApiFailure)) throw e; return e.code; };
async function load() {
  failure.value = null;
  try {
    info.value = await linkInfo(token.value);
    entries.value = !info.value.locked && info.value.type === 'directory' ? await linkList(token.value, path.value) : null;
  } catch (e) { failure.value = code(e); }
}
watch([token, path], load, { immediate: true });

async function unlock() {
  if (busy.value) return;
  busy.value = true; passwordError.value = '';
  try {
    await unlockLink(token.value, password.value);
    password.value = '';
    await load();
  } catch (e) {
    passwordError.value = t(`errors.${code(e)}`);
    passwordInput.value?.focus();
  } finally { busy.value = false; }
}

// Opened in a new tab only where the server serves it inline (its allowlist); a PDF under `CSP: sandbox` is not shown
// by Chromium's viewer, so it downloads.
const opensInline = (mime: string | undefined) =>
  ['image', 'video', 'audio'].includes(previewKind(mime)) || (mime ?? '').split(';')[0]!.trim() === 'text/plain';
const href = (p: string, inline = false) => linkContentHref(token.value, p, inline);
const parent = computed(() => path.value.slice(0, path.value.lastIndexOf('/')) || '/');
const fmtDate = (iso: string) => formatDate(iso, intlLocale(locale.value));
const fmtSize = (n: number) => formatSize(n, intlLocale(locale.value));
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <span class="app-title">{{ t('app.name') }}</span>
    </header>
    <main class="app-main link-page">
      <p
        v-if="refused"
        class="link-alert"
        role="alert"
      >
        {{ t(`errors.${refused}`) }}
      </p>
      <section v-if="failure">
        <h1 class="view-title">
          {{ t('link.page.unavailable') }}
        </h1>
        <p role="alert">
          {{ t(`errors.${failure}`) }}
        </p>
      </section>
      <p v-else-if="!info">
        {{ t('folder.loading') }}
      </p>
      <section v-else>
        <p class="link-kind">
          {{ info.type === 'directory' ? t('link.page.folder') : t('link.page.file') }}
        </p>
        <h1
          class="view-title link-name"
          data-testid="link-name"
        >
          {{ info.name }}
        </h1>
        <form
          v-if="info.locked"
          class="link-unlock"
          @submit.prevent="unlock"
        >
          <p class="share-note">
            {{ t('link.page.passwordPrompt') }}
          </p>
          <div class="fs-field">
            <label
              class="fs-label"
              for="link-password"
            >{{ t('link.page.password') }}</label>
            <input
              id="link-password"
              ref="passwordInput"
              v-model="password"
              class="fs-input"
              type="password"
              autocomplete="current-password"
              required
              :aria-invalid="passwordError !== ''"
              :aria-describedby="passwordError ? 'link-password-error' : undefined"
            >
            <p
              v-if="passwordError"
              id="link-password-error"
              class="fs-field__error"
              role="alert"
            >
              {{ passwordError }}
            </p>
          </div>
          <button
            type="submit"
            class="button primary"
            :aria-disabled="busy"
          >
            {{ t('link.page.unlock') }}
          </button>
        </form>
        <template v-else>
          <dl class="details-facts link-facts">
            <template v-if="info.type === 'file' && info.size !== undefined">
              <dt>{{ t('link.page.size') }}</dt>
              <dd class="value-mono">
                {{ fmtSize(info.size) }}
              </dd>
            </template>
            <template v-if="info.expiresAt">
              <dt>{{ t('link.page.expires') }}</dt>
              <dd class="value-mono">
                {{ fmtDate(info.expiresAt) }}
              </dd>
            </template>
            <template v-if="info.downloadsLeft !== null && info.downloadsLeft !== undefined">
              <dt>{{ t('link.page.downloadsLeft') }}</dt>
              <dd class="value-mono">
                {{ info.downloadsLeft }}
              </dd>
            </template>
          </dl>
          <p
            v-if="info.downloadsLeft === 0"
            class="link-alert"
          >
            {{ t('errors.DOWNLOAD_LIMIT_REACHED') }}
          </p>
          <div
            v-if="info.type === 'file'"
            class="link-actions"
          >
            <a
              class="button primary"
              :href="href('/')"
            >{{ t('link.page.download') }}</a>
            <a
              v-if="opensInline(info.mime)"
              class="button"
              :href="href('/', true)"
              target="_blank"
              rel="noopener noreferrer"
            >{{ t('link.page.preview') }}</a>
          </div>
          <template v-else-if="entries">
            <RouterLink
              v-if="path !== '/'"
              class="button"
              :to="{ query: { path: parent } }"
            >
              {{ t('link.page.up') }}
            </RouterLink>
            <p
              v-if="entries.length === 0"
              class="recent-empty"
            >
              {{ t('folder.empty') }}
            </p>
            <ul
              v-else
              class="share-list link-entries"
              :aria-label="t('link.page.contents', { name: info.name })"
            >
              <li
                v-for="e in entries"
                :key="e.path"
              >
                <span
                  class="icon"
                  :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'"
                  aria-hidden="true"
                />
                <span class="share-name">{{ e.name }}</span>
                <template v-if="e.type === 'directory'">
                  <RouterLink
                    class="button"
                    :to="{ query: { path: e.path } }"
                    :aria-label="t('link.page.openLabel', { name: e.name })"
                  >
                    {{ t('link.page.open') }}
                  </RouterLink>
                </template>
                <template v-else>
                  <span class="share-level value-mono">{{ fmtSize(e.size) }}</span>
                  <a
                    class="button"
                    :href="href(e.path)"
                    :aria-label="t('link.page.downloadLabel', { name: e.name })"
                  >{{ t('link.page.download') }}</a>
                  <a
                    v-if="opensInline(e.mime)"
                    class="button"
                    :href="href(e.path, true)"
                    :aria-label="t('link.page.previewLabel', { name: e.name })"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ t('link.page.preview') }}</a>
                </template>
              </li>
            </ul>
          </template>
          <p class="share-note">
            {{ t('link.page.countNote') }}
          </p>
        </template>
      </section>
    </main>
  </div>
</template>
