<script setup lang="ts">
// A usage gauge (#156): `used` of `total` as a thin teal line on a hairline track, red from 90 % on. A meter for
// assistive technology, with the figures as its text. The percentage beside it (#243) repeats the meter for the eye
// only; any usage shows at least a sliver of fill and "< 1 %" rather than an empty bar and "0 %".
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ used: number; total: number; label: string; text: string }>();
const { t } = useI18n();
const percent = computed(() => (props.total > 0 ? Math.min(100, (props.used / props.total) * 100) : 100));
const high = computed(() => props.used >= props.total * 0.9);
const percentText = computed(() => (props.used > 0 && percent.value < 1
  ? t('storage.percentBelowOne')
  : t('storage.percent', { percent: Math.round(percent.value) })));
</script>

<template>
  <div class="usage">
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
      <span
        :style="{ width: `${percent}%` }"
        :data-used="used > 0 ? 'true' : undefined"
      />
    </div>
    <span
      class="usage-percent value-mono"
      aria-hidden="true"
    >{{ percentText }}</span>
  </div>
</template>
