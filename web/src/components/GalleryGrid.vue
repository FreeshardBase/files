<script setup lang="ts">
// The gallery view (#144): the folder as a grid of tiles. Images, videos and PDFs show their thumbnail, everything else
// its line icon. A folder tile opens the folder, a file tile the preview overlay, which is the lightbox (←/→ step).
import { reactive, ref } from 'vue';
import type { Entry } from '@files/shared';
import { hasThumbnail, thumbnailHref } from '../preview.ts';

const props = defineProps<{ entries: Entry[]; folderName: string; source: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const tiles = ref<HTMLElement[]>([]);
// A thumbnail that could not be loaded (corrupt file, say) falls back to the icon instead of a broken image.
const failed = reactive(new Set<string>());

defineExpose({
  focusPath: (path: string) => { tiles.value[props.entries.findIndex((e) => e.path === path)]?.focus(); }, // after the preview
});
</script>

<template>
  <ul
    class="gallery"
    :aria-label="$t('a11y.gallery', { folder: folderName })"
  >
    <li
      v-for="(e, i) in entries"
      :key="e.path"
    >
      <button
        :ref="(el) => { if (el) tiles[i] = el as HTMLElement }"
        type="button"
        class="gallery-tile"
        :data-type="e.type"
        @click="emit('open', e)"
      >
        <img
          v-if="hasThumbnail(e) && !failed.has(e.path)"
          class="gallery-thumb"
          :src="thumbnailHref(source, e, 256)"
          alt=""
          loading="lazy"
          @error="failed.add(e.path)"
        >
        <span
          v-else
          class="gallery-icon"
        ><span
          class="icon"
          :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'"
          aria-hidden="true"
        /></span>
        <span class="gallery-name">{{ e.name }}</span>
      </button>
    </li>
  </ul>
</template>
