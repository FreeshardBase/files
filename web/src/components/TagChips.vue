<script setup lang="ts">
// An item's tags as chips (#212): each a link to the tag view, an outlined pill with a dot in the tag's colour (a design
// token, picked from the name, `tagColor`). Inside a list row or a tile the links leave the row's single tab stop alone
// (`tabindex -1`; the details drawer reaches every tag by keyboard). `max` shows that many and counts the rest.
import { computed } from 'vue';
import { tagColor } from '@files/shared';
import { tagRoute } from '../api/paths.ts';

const props = withDefaults(defineProps<{ tags: string[]; name: string; inRow?: boolean; max?: number }>(), { inRow: false, max: Infinity });
const shown = computed(() => props.tags.slice(0, props.max));
const rest = computed(() => props.tags.length - shown.value.length);
</script>

<template>
  <ul
    v-if="tags.length"
    class="tag-chips"
    :aria-label="$t('tags.ofItem', { name })"
  >
    <li
      v-for="tag in shown"
      :key="tag"
    >
      <RouterLink
        class="tag-chip"
        :to="tagRoute(tag)"
        :tabindex="inRow ? -1 : undefined"
        :title="tag"
        :data-color="tagColor(tag)"
        draggable="false"
        @click.stop
        @dblclick.stop
      >
        <span
          class="tag-dot"
          aria-hidden="true"
        />
        <span class="tag-chip-text">{{ tag }}</span>
      </RouterLink>
    </li>
    <li
      v-if="rest > 0"
      class="tag-more"
    >
      {{ $t('tags.more', { count: rest }) }}
    </li>
  </ul>
</template>
