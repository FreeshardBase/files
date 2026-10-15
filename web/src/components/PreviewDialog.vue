<script setup lang="ts">
// The preview overlay (#142): one file of the folder at a time, ←/→ for the previous/next file, Esc closes.
// Closing reports the file shown last, so the list can put focus back on its row.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import AppDialog from './AppDialog.vue';
import MarkdownView from './MarkdownView.vue';
import PdfView from './PdfView.vue';
import { ApiFailure } from '../api/client.ts';
import { downloadHref } from '../api/paths.ts';
import { contentHref, fetchText, previewKind, TEXT_CAP } from '../preview.ts';
import { formatSize, intlLocale } from '../format.ts';

const props = defineProps<{ files: Entry[]; start: number; source: string }>();
const emit = defineEmits<{ close: [path: string] }>();
const { locale } = useI18n();

const index = ref(Math.max(0, Math.min(props.start, props.files.length - 1)));
const entry = computed(() => props.files[index.value]!);
const kind = computed(() => previewKind(entry.value.mime));
const href = computed(() => contentHref(props.source, entry.value.path));
const failed = ref(false);
const text = ref<{ text: string; truncated: boolean } | null>(null);
let loading = 0; // only the newest text request may land

watch(entry, async (e) => {
  failed.value = false; text.value = null;
  if (kind.value !== 'text' && kind.value !== 'markdown') return;
  const mine = ++loading;
  try {
    const r = await fetchText(props.source, e.path, e.size);
    if (mine === loading) text.value = r;
  } catch (err) {
    if (!(err instanceof ApiFailure)) throw err;
    if (mine === loading) failed.value = true; // handled: the overlay says so and offers the download
  }
}, { immediate: true });

function go(by: number) {
  const n = index.value + by;
  if (n >= 0 && n < props.files.length) index.value = n;
}
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Arrows on a player seek or change the volume.
  if (e.target instanceof HTMLMediaElement || e.target instanceof HTMLInputElement) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));

const close = () => emit('close', entry.value.path);
const size = (n: number) => formatSize(n, intlLocale(locale.value));
</script>

<template>
  <AppDialog
    :title="entry.name"
    wide
    @close="close"
  >
    <div
      :key="entry.path"
      class="preview-body"
      :data-kind="kind"
    >
      <p
        v-if="failed"
        class="preview-note"
        role="alert"
      >
        {{ $t('preview.failed') }}
      </p>
      <img
        v-else-if="kind === 'image'"
        class="preview-media"
        :src="href"
        :alt="entry.name"
        @error="failed = true"
      >
      <video
        v-else-if="kind === 'video'"
        class="preview-media"
        :src="href"
        :aria-label="entry.name"
        controls
        preload="metadata"
        @error="failed = true"
      />
      <audio
        v-else-if="kind === 'audio'"
        class="preview-audio"
        :src="href"
        :aria-label="entry.name"
        controls
        preload="metadata"
        @error="failed = true"
      />
      <PdfView
        v-else-if="kind === 'pdf'"
        :url="href"
        @failed="failed = true"
      />
      <template v-else-if="kind === 'text' || kind === 'markdown'">
        <p v-if="!text">
          {{ $t('preview.loading') }}
        </p>
        <template v-else>
          <p
            v-if="text.truncated"
            class="preview-note"
          >
            {{ $t('preview.truncated', { shown: size(TEXT_CAP), size: size(entry.size) }) }}
          </p>
          <MarkdownView
            v-if="kind === 'markdown'"
            :source="text.text"
          />
          <pre
            v-else
            class="preview-text"
          >{{ text.text }}</pre>
        </template>
      </template>
      <p
        v-else
        class="preview-note"
      >
        {{ $t('preview.unsupported') }}
      </p>
    </div>
    <template #actions>
      <div class="preview-nav">
        <button
          type="button"
          class="button"
          :aria-disabled="index === 0"
          @click="go(-1)"
        >
          {{ $t('preview.previous') }}
        </button>
        <span class="preview-position">{{ $t('preview.position', { n: index + 1, total: files.length }) }}</span>
        <button
          type="button"
          class="button"
          :aria-disabled="index === files.length - 1"
          @click="go(1)"
        >
          {{ $t('preview.next') }}
        </button>
      </div>
      <a
        class="button"
        :class="{ primary: kind === 'none' || failed }"
        :href="downloadHref(source, [entry])"
        download
      >{{ $t('preview.download') }}</a>
      <button
        type="button"
        class="button"
        data-autofocus
        @click="close"
      >
        {{ $t('preview.close') }}
      </button>
    </template>
  </AppDialog>
</template>
