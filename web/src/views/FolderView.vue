<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { CollisionPolicy, Entry } from '@files/shared';
import { useFolderStore } from '../stores/folder.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import FileList from '../components/FileList.vue';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';
import CollisionDialog, { type CollisionChoice } from '../components/CollisionDialog.vue';

const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const folder = useFolderStore();
type Failure = { name: string; reason: string };
const status = ref('');
const source = computed(() => String(route.params.source));
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
const failures = ref<Failure[]>([]);
watch([source, path], ([s, p]) => { status.value = ''; failures.value = []; void folder.open(p, { source: s }); }, { immediate: true });

const folderName = computed(() => path.value === '/' ? t('nav.home') : path.value.split('/').pop()!);
function open(e: Entry) {
  if (e.type === 'directory') void router.push(folderRoute(source.value, e.path));
}
// The open collision question; answering it resolves the promise the upload loop waits on.
const conflict = ref<{ name: string; remaining: number; answer: (c: CollisionChoice) => void } | null>(null);
const uploadButton = ref<InstanceType<typeof UploadButton>>();
const ask = (name: string, remaining: number) => new Promise<CollisionChoice>((resolve) => {
  conflict.value = { name, remaining, answer: (c) => { conflict.value = null; resolve(c); } };
});

async function upload(files: File[]) {
  const at = { source: folder.source, dir: folder.path }; // captured: navigating away mid-batch must not redirect the remaining files
  failures.value = [];
  let done = 0; let skipped = 0;
  let forAll: CollisionChoice['policy'] | null = null; // "apply to all remaining"
  try {
    for (const [i, f] of files.entries()) {
      const send = (policy: CollisionPolicy) =>
        folder.upload(f, at, policy, (x) => { status.value = t('upload.progress', { name: f.name, percent: Math.round(x * 100) }); });
      try {
        // With "replace" or "keep both" for all, send straight away; otherwise ask the server first (it fails before the body).
        if (forAll === 'replace' || forAll === 'keep-both') { await send(forAll); done++; continue; }
        const taken = await send('fail').then(() => null, (e: unknown) => {
          if (e instanceof ApiFailure && e.code === 'FILE_EXISTS') return e; // handled: the collision is resolved below
          throw e;
        });
        if (!taken) { done++; continue; }
        let policy: CollisionChoice['policy'] = 'skip'; // forAll is null or "skip" here
        if (!forAll) {
          const c = await ask(typeof taken.params?.name === 'string' ? taken.params.name : f.name, files.length - i - 1);
          policy = c.policy; if (c.all) forAll = c.policy;
        }
        if (policy === 'skip') { skipped++; continue; }
        await send(policy); done++;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        failures.value.push({ name: f.name, reason: t('upload.failedItem', { name: f.name, reason: t(`errors.${e.code}`) }) });
      }
    }
    status.value = skipped ? t('upload.summarySkipped', { done, total: files.length, skipped }) : t('upload.summary', { done, total: files.length });
  } finally {
    if (at.dir === folder.path && at.source === folder.source) await folder.open(at.dir, { refresh: true }); // once per batch, list stays mounted
  }
}
</script>

<template>
  <section class="folder">
    <div class="toolbar">
      <Breadcrumbs
        :source="source"
        :path="path"
      />
      <UploadButton
        ref="uploadButton"
        @files="upload"
      />
    </div>
    <CollisionDialog
      v-if="conflict"
      :name="conflict.name"
      :remaining="conflict.remaining"
      :return-focus="uploadButton?.input"
      @choose="conflict.answer"
    />
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <div
      v-if="failures.length"
      class="upload-failures"
    >
      <p>{{ $t('upload.failedHeading') }}</p>
      <ul>
        <li
          v-for="(f, i) in failures"
          :key="i"
        >
          {{ f.reason }}
        </li>
      </ul>
    </div>
    <p v-if="folder.loading">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="folder.error"
      role="alert"
    >
      {{ $t(`errors.${folder.error.code}`) }}
    </p>
    <p v-else-if="folder.entries.length === 0">
      {{ $t('folder.empty') }}
    </p>
    <FileList
      v-else
      :entries="folder.entries"
      :folder-name="folderName"
      :source="source"
      @open="open"
    />
  </section>
</template>
