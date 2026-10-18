<script setup lang="ts">
// A file request's page (#217), for visitors without an account: the request's title, a drop zone and a file picker,
// and the visitor's own files of this browser session with their progress. Nothing of the folder is ever shown; the
// server sends nothing of it. A locked request asks for its password first.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ErrorCode, FileRequestInfo } from '@files/shared';
import { ApiFailure } from '../api/client.ts';
import { requestInfo, sendFile, unlockRequest } from '../api/fileRequest.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import StateAlert from '../components/StateAlert.vue';
import AppTitle from '../components/AppTitle.vue';

const route = useRoute();
const { t, locale } = useI18n();
const token = computed(() => String(route.params.token));
const info = ref<FileRequestInfo | null>(null);
const failure = ref<ErrorCode | 'NETWORK' | null>(null);
const password = ref('');
const passwordError = ref('');
const busy = ref(false);
const passwordInput = ref<HTMLInputElement>();
const picker = ref<HTMLInputElement>();
const uploader = ref('');
const dragging = ref(false);

// Files picked on this page that are not saved yet; a saved one is shown from the server's list instead.
type Local = { key: number; file: File; sent: number; state: 'waiting' | 'sending' | 'failed'; error?: ErrorCode | 'NETWORK' };
const local = ref<Local[]>([]);
let nextKey = 0;
let running = false;

const code = (e: unknown) => { if (!(e instanceof ApiFailure)) throw e; return e.code; };
async function load() {
  try { info.value = await requestInfo(token.value); failure.value = null; }
  catch (e) { failure.value = code(e); }
}
watch(token, load, { immediate: true });

async function unlock() {
  if (busy.value) return;
  busy.value = true; passwordError.value = '';
  try {
    await unlockRequest(token.value, password.value);
    password.value = '';
    await load();
  } catch (e) {
    passwordError.value = t(`errors.${code(e)}`);
    passwordInput.value?.focus();
  } finally { busy.value = false; }
}

function add(files: FileList | null | undefined) {
  for (const file of Array.from(files ?? [])) local.value.push({ key: nextKey++, file, sent: 0, state: 'waiting' });
  void run();
}
// One file at a time, in the order they were picked; each saved file brings the server's list (and limits) up to date.
async function run() {
  if (running) return;
  running = true;
  try {
    for (let item = local.value.find((l) => l.state === 'waiting'); item; item = local.value.find((l) => l.state === 'waiting')) {
      const current = item;
      current.state = 'sending';
      try {
        await sendFile(token.value, current.file, uploader.value, (sent) => { current.sent = sent; });
        local.value = local.value.filter((l) => l !== current);
      } catch (e) {
        current.state = 'failed'; current.error = code(e);
      }
      await load();
    }
  } finally { running = false; }
}
function retry(item: Local) { item.state = 'waiting'; item.sent = 0; item.error = undefined; void run(); }
function onPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  add(input.files);
  input.value = '';
}
function onDrop(e: DragEvent) { dragging.value = false; add(e.dataTransfer?.files); }

const fmtDate = (iso: string) => formatDate(iso, intlLocale(locale.value));
const fmtSize = (n: number) => formatSize(n, intlLocale(locale.value));
const known = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const sentUploads = computed(() => (info.value?.uploads ?? []).filter((u) => u.done));
const empty = computed(() => sentUploads.value.length === 0 && local.value.length === 0);
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <AppTitle />
    </header>
    <main class="app-main link-page">
      <section v-if="failure">
        <StateAlert
          class="link-alert"
          :title="t('request.page.unavailable')"
          :text="failure === 'NOT_FOUND' ? t('request.page.notFound') : t(`errors.${failure}`)"
        />
      </section>
      <p v-else-if="!info">
        {{ t('folder.loading') }}
      </p>
      <section v-else>
        <p class="link-kind">
          {{ t('request.page.kind') }}
        </p>
        <h1
          class="view-title link-name"
          data-testid="request-title"
        >
          {{ info.label || t('requests.unnamed') }}
        </h1>
        <form
          v-if="info.locked"
          class="link-unlock"
          @submit.prevent="unlock"
        >
          <p class="share-note">
            {{ t('request.page.passwordPrompt') }}
          </p>
          <div class="fs-field">
            <label
              class="fs-label"
              for="request-password"
            >{{ t('request.page.password') }}</label>
            <input
              id="request-password"
              ref="passwordInput"
              v-model="password"
              class="fs-input"
              type="password"
              autocomplete="current-password"
              required
              :aria-invalid="passwordError !== ''"
              :aria-describedby="passwordError ? 'request-password-error' : undefined"
            >
            <p
              v-if="passwordError"
              id="request-password-error"
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
            {{ t('request.page.unlock') }}
          </button>
        </form>
        <template v-else>
          <p class="share-note">
            {{ t('request.page.intro') }}
          </p>
          <dl
            v-if="info.expiresAt || known(info.filesLeft) || known(info.bytesLeft)"
            class="details-facts link-facts"
          >
            <template v-if="info.expiresAt">
              <dt>{{ t('request.page.expires') }}</dt>
              <dd class="value-mono">
                {{ fmtDate(info.expiresAt) }}
              </dd>
            </template>
            <template v-if="known(info.filesLeft)">
              <dt>{{ t('request.page.filesLeft') }}</dt>
              <dd
                class="value-mono"
                data-testid="files-left"
              >
                {{ info.filesLeft }}
              </dd>
            </template>
            <template v-if="known(info.bytesLeft)">
              <dt>{{ t('request.page.sizeLeft') }}</dt>
              <dd class="value-mono">
                {{ fmtSize(info.bytesLeft) }}
              </dd>
            </template>
          </dl>
          <div
            v-if="info.askName"
            class="fs-field request-name"
          >
            <label
              class="fs-label"
              for="request-uploader"
            >{{ t('request.page.name') }}</label>
            <input
              id="request-uploader"
              v-model="uploader"
              class="fs-input"
              type="text"
              maxlength="100"
              autocomplete="name"
            >
          </div>
          <div
            class="request-drop"
            :class="{ dragging }"
            data-testid="request-drop"
            @dragenter.prevent="dragging = true"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <span>{{ t('request.page.drop') }}</span>
            <button
              type="button"
              class="button primary"
              @click="picker?.click()"
            >
              {{ t('request.page.choose') }}
            </button>
            <input
              ref="picker"
              class="visually-hidden"
              type="file"
              multiple
              tabindex="-1"
              aria-hidden="true"
              data-testid="request-picker"
              @change="onPicked"
            >
          </div>
          <h2 class="fs-section-heading">
            {{ t('request.page.yours') }}
          </h2>
          <p
            v-if="empty"
            class="recent-empty"
          >
            {{ t('request.page.none') }}
          </p>
          <ul
            v-else
            class="fs-entry-list request-uploads"
            :aria-label="t('request.page.yours')"
          >
            <li
              v-for="u in sentUploads"
              :key="u.id"
            >
              <span
                class="icon icon-file"
                aria-hidden="true"
              />
              <span class="share-name">{{ u.name }}</span>
              <span class="share-level value-mono">{{ fmtSize(u.size) }}</span>
              <span class="share-level">{{ t('request.page.sent') }}</span>
            </li>
            <li
              v-for="l in local"
              :key="`local-${l.key}`"
            >
              <span
                class="icon icon-file"
                aria-hidden="true"
              />
              <span class="share-name">{{ l.file.name }}</span>
              <template v-if="l.state === 'failed'">
                <span
                  class="share-level fs-field__error"
                  role="alert"
                >{{ t('request.page.failed', { reason: t(`errors.${l.error}`) }) }}</span>
                <button
                  type="button"
                  class="button"
                  :aria-label="t('request.page.retryLabel', { name: l.file.name })"
                  @click="retry(l)"
                >
                  {{ t('request.page.retry') }}
                </button>
              </template>
              <template v-else>
                <progress
                  class="request-progress"
                  :value="l.sent"
                  :max="Math.max(1, l.file.size)"
                  :aria-label="t('request.page.progress', { name: l.file.name })"
                />
                <span class="share-level value-mono">{{ l.state === 'waiting' ? t('request.page.waiting')
                  : t('request.page.sending', { done: fmtSize(l.sent), total: fmtSize(l.file.size) }) }}</span>
              </template>
            </li>
          </ul>
        </template>
      </section>
    </main>
  </div>
</template>
