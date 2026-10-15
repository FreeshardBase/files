<script setup lang="ts">
// The upload panel (spec §3.8): one row per file with progress, pause/resume, cancel and retry, and one summary of
// everything that failed with a single "retry all", never one message per file (#119). It also asks the collision
// question for uploads, so an answer is possible wherever the user has navigated meanwhile.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUploadsStore, type UploadItem } from '../stores/uploads.ts';
import CollisionDialog from './CollisionDialog.vue';

const uploads = useUploadsStore();
const { t } = useI18n();
const percent = (i: UploadItem) => (i.size === 0 ? (i.state === 'done' ? 100 : 0) : Math.min(100, Math.round((i.sent / i.size) * 100)));
const stateText = (i: UploadItem) => {
  if (i.state === 'uploading') return t('upload.state.uploading', { percent: percent(i) });
  if (i.state === 'failed') return t('upload.state.failed', { reason: t(`errors.${i.error ?? 'INTERNAL'}`) });
  return t(`upload.state.${i.state}`);
};
const finished = computed(() => uploads.items.some((i) => ['done', 'skipped', 'failed', 'cancelled'].includes(i.state)));
</script>

<template>
  <section
    v-if="uploads.items.length"
    class="upload-panel"
    :aria-label="t('upload.panelTitle')"
    data-testid="upload-panel"
  >
    <div class="upload-panel-head">
      <h2 class="fs-label">
        {{ t('upload.panelTitle') }}
      </h2>
      <button
        v-if="finished"
        type="button"
        class="button"
        @click="uploads.clearFinished()"
      >
        {{ t('upload.clear') }}
      </button>
    </div>
    <div
      v-if="uploads.failed.length"
      class="upload-summary"
      aria-live="polite"
      data-testid="upload-summary"
    >
      <p>{{ t('upload.failedSummary', uploads.failed.length) }}</p>
      <ul>
        <li
          v-for="i in uploads.failed"
          :key="i.id"
        >
          {{ t('upload.failedItem', { name: i.name, reason: t(`errors.${i.error ?? 'INTERNAL'}`) }) }}
        </li>
      </ul>
      <button
        type="button"
        class="button primary"
        @click="uploads.retryFailed()"
      >
        {{ t('upload.retryAll') }}
      </button>
    </div>
    <ul class="upload-items">
      <li
        v-for="i in uploads.items"
        :key="i.id"
        class="upload-item"
        :data-state="i.state"
      >
        <span class="upload-name">{{ i.name }}</span>
        <span class="upload-state">{{ stateText(i) }}</span>
        <div
          class="upload-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent(i)"
          :aria-label="t('upload.progressLabel', { name: i.name })"
        >
          <span :style="{ width: `${percent(i)}%` }" />
        </div>
        <span class="upload-actions">
          <button
            v-if="i.state === 'uploading' || i.state === 'queued'"
            type="button"
            class="button"
            :aria-label="t('upload.pauseLabel', { name: i.name })"
            @click="uploads.pause(i.id)"
          >
            {{ t('upload.pause') }}
          </button>
          <button
            v-if="i.state === 'paused'"
            type="button"
            class="button"
            :aria-label="t('upload.resumeLabel', { name: i.name })"
            @click="uploads.resume(i.id)"
          >
            {{ t('upload.resume') }}
          </button>
          <button
            v-if="i.state === 'failed'"
            type="button"
            class="button"
            :aria-label="t('upload.retryLabel', { name: i.name })"
            @click="uploads.retry(i.id)"
          >
            {{ t('upload.retry') }}
          </button>
          <button
            v-if="i.state === 'uploading' || i.state === 'queued' || i.state === 'paused'"
            type="button"
            class="button danger"
            :aria-label="t('upload.cancelLabel', { name: i.name })"
            @click="uploads.cancel(i.id)"
          >
            {{ t('upload.cancel') }}
          </button>
        </span>
      </li>
    </ul>
  </section>
  <CollisionDialog
    v-if="uploads.question"
    :key="uploads.question.id"
    :name="uploads.question.name"
    :remaining="uploads.question.remaining"
    :return-focus="uploads.question.returnFocus"
    @choose="uploads.question.answer"
  />
</template>
