<script setup lang="ts">
// A usage gauge (#156): `used` of `total` as a thin teal line on a hairline track, red from 90 % on. A meter for
// assistive technology, with the figures as its text.
import { computed } from 'vue';

const props = defineProps<{ used: number; total: number; label: string; text: string }>();
const percent = computed(() => (props.total > 0 ? Math.min(100, (props.used / props.total) * 100) : 100));
const high = computed(() => props.used >= props.total * 0.9);
</script>

<template>
  <div
    class="usage-bar"
    role="meter"
    aria-valuemin="0"
    :aria-valuemax="total"
    :aria-valuenow="Math.min(used, total)"
    :aria-valuetext="text"
    :aria-label="label"
    :data-high="high ? 'true' : undefined"
  >
    <span :style="{ width: `${percent}%` }" />
  </div>
</template>
