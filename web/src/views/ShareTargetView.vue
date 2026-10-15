<script setup lang="ts">
// The Web Share Target's page (#158): files shared from the phone wait in the browser (shareInbox.ts) until the member
// picks a folder in "My storage"; then they go through the upload flow (#140) and the folder opens. Without a share
// (already saved, or it never reached the service worker) the page says so.
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useUploadsStore } from '../stores/uploads.ts';
import { deleteShare, getShare, type Share } from '../shareInbox.ts';
import { folderRoute } from '../api/paths.ts';
import { formatSize, intlLocale } from '../format.ts';
import FolderPicker from '../components/FolderPicker.vue';

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const uploads = useUploadsStore();
const id = typeof route.params.id === 'string' ? route.params.id : '';
const share = ref<Share | null>(null);
const loading = ref(id !== '');
const busy = ref(false);
const dir = ref('/');
const target = computed(() => `${t('nav.home')}${dir.value === '/' ? '' : dir.value}`);

onMounted(async () => {
  if (!id) return;
  share.value = (await getShare(id)) ?? null;
  loading.value = false;
});

function save() {
  const s = share.value!;
  const at = { source: 'home', dir: dir.value };
  busy.value = true;
  let opened = false;
  // The upload panel reports progress and failures (with retry); the share leaves the browser once nothing failed.
  uploads.enqueue(s.files.map((file) => ({ file, rel: file.name })), at, { settled: (r) => {
    void (async () => {
      if (r.failed === 0) await deleteShare(s.id);
      if (!opened) { opened = true; await router.push(folderRoute(at.source, at.dir)); }
    })();
  } });
}

async function discard() {
  await deleteShare(share.value!.id);
  await router.push('/home');
}
</script>

<template>
  <section class="share-target">
    <div class="toolbar">
      <h1 class="view-title">
        {{ t('shareTarget.title') }}
      </h1>
    </div>
    <p v-if="loading">
      {{ t('folder.loading') }}
    </p>
    <p
      v-else-if="!share"
      class="recent-empty"
    >
      {{ t('shareTarget.missing') }}
      <RouterLink to="/home">
        {{ t('nav.home') }}
      </RouterLink>
    </p>
    <template v-else>
      <p class="trash-note">
        {{ t('shareTarget.intro', { count: share.files.length }, share.files.length) }}
      </p>
      <ul
        class="share-target-files"
        data-testid="share-files"
      >
        <li
          v-for="(f, i) in share.files"
          :key="i"
        >
          <span class="share-target-name">{{ f.name }}</span>
          <span class="share-target-size">{{ formatSize(f.size, intlLocale(locale)) }}</span>
        </li>
      </ul>
      <FolderPicker
        v-model="dir"
        source="home"
        :root-label="t('nav.home')"
        :label="t('shareTarget.picker')"
      />
      <p class="migrate-choice">
        {{ t('shareTarget.target', { folder: target }) }}
      </p>
      <div class="migrate-actions">
        <button
          type="button"
          class="button primary"
          :disabled="busy"
          @click="save"
        >
          {{ t('shareTarget.save') }}
        </button>
        <button
          type="button"
          class="button"
          :disabled="busy"
          @click="discard"
        >
          {{ t('shareTarget.discard') }}
        </button>
      </div>
    </template>
  </section>
</template>
