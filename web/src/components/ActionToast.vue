<script setup lang="ts">
// The guide's toast (PDF p.16, #241) for the feedback of an action: a surface sheet at the bottom right with a 3 px edge,
// teal for a success and danger for an outcome with failures, and a close X. A success fades after 5 s; an error stays
// until it is closed or replaced. The text is the page's polite live region, so it is in the DOM even when empty.
import { onBeforeUnmount, watch } from 'vue';

export type Toast = { text: string; kind: 'success' | 'error'; id: number };
const props = defineProps<{ toast: Toast | null }>();
const emit = defineEmits<{ dismiss: [] }>();
const SUCCESS_MS = 5000;

let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.toast?.id, () => {
  clearTimeout(timer);
  if (props.toast?.kind === 'success') timer = setTimeout(() => emit('dismiss'), SUCCESS_MS);
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div
    class="toast"
    :class="{ shown: toast }"
    :data-kind="toast?.kind"
  >
    <p
      class="toast-text"
      role="status"
      aria-live="polite"
    >
      {{ toast?.text ?? '' }}
    </p>
    <button
      v-if="toast"
      type="button"
      class="icon-button toast-close"
      :aria-label="$t('toast.close')"
      @click="emit('dismiss')"
    >
      <span
        class="icon icon-close"
        aria-hidden="true"
      />
    </button>
  </div>
</template>
