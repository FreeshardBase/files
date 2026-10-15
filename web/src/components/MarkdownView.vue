<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { renderMarkdown } from '../markdown.ts';

const props = defineProps<{ source: string }>();
const { t } = useI18n();
const Rendered = () => renderMarkdown(props.source, (alt) => t('preview.markdownImage', { alt }));
</script>

<template>
  <div class="markdown">
    <Rendered />
  </div>
</template>
