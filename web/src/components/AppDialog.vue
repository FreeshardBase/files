<script setup lang="ts">
// The only dialog in the app (spec §3.8, lint-enforced): open while mounted. Traps focus, makes the page behind
// inert, locks its scroll, closes on Esc (emits `close`, the parent unmounts it) and restores focus on unmount.
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';

const props = defineProps<{ title: string; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const host = ref<HTMLElement>();
const box = ref<HTMLElement>();
const titleId = useId();

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusables = () => Array.from(box.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
const focusFirst = () => (box.value?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? box.value)?.focus();

let restoreTo: HTMLElement | null = null;
let madeInert: HTMLElement[] = [];
let overflowBefore = '';

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); emit('close'); return; }
  if (e.key !== 'Tab') return;
  const all = focusables();
  if (!all.length) { e.preventDefault(); return; }
  const first = all[0]!; const last = all[all.length - 1]!;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !box.value?.contains(at))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (at === last || !box.value?.contains(at))) { e.preventDefault(); first.focus(); }
}
// Backstop for focus that arrives from outside anyway (a click on the scrim, script focus).
function onFocusin(e: FocusEvent) {
  if (box.value && e.target instanceof Node && !box.value.contains(e.target)) focusFirst();
}

onMounted(async () => {
  restoreTo = props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  overflowBefore = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  madeInert = Array.from(document.body.children).filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el !== host.value && !el.inert);
  for (const el of madeInert) el.inert = true;
  document.addEventListener('focusin', onFocusin);
  await nextTick();
  focusFirst();
});
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusin);
  for (const el of madeInert) el.inert = false;
  document.documentElement.style.overflow = overflowBefore;
  if (restoreTo?.isConnected) restoreTo.focus();
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="host"
      class="app-dialog-scrim"
    >
      <div
        ref="box"
        class="app-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <h2
          :id="titleId"
          class="app-dialog-title"
        >
          {{ title }}
        </h2>
        <slot />
        <div class="app-dialog-actions">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
