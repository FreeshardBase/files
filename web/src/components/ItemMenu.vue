<script setup lang="ts">
// The action menu of one list item: a menu button plus a menu (WAI-ARIA menu button pattern). It is how touch users
// reach every action; the context menu and Shift+F10 open the same menu. Esc or choosing closes it and emits `closed`,
// so the list can put focus back on the row before an action opens a dialog.
import { nextTick, onBeforeUnmount, ref } from 'vue';

export type MenuItem = { id: string; label: string };
const props = defineProps<{ label: string; items: MenuItem[] }>();
const emit = defineEmits<{ select: [string]; closed: [] }>();
const open = ref(false);
const up = ref(false);
const root = ref<HTMLElement>();
const menu = ref<HTMLElement>();
const entries = ref<HTMLElement[]>([]);

function onOutside(e: Event) {
  if (root.value && e.target instanceof Node && !root.value.contains(e.target)) close(false);
}
// The menu opens below its button unless it would run past the viewport there and there is more room above (#224).
function place() {
  const button = root.value!.getBoundingClientRect();
  const below = window.innerHeight - button.bottom;
  up.value = menu.value!.offsetHeight > below && button.top > below;
}
async function show() {
  up.value = false;
  open.value = true;
  document.addEventListener('pointerdown', onOutside, true);
  await nextTick();
  place();
  entries.value[0]?.focus();
}
function close(refocus: boolean) {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  if (refocus) emit('closed');
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));

function choose(id: string) { close(true); emit('select', id); }
function onKey(e: KeyboardEvent) {
  e.stopPropagation(); // the row's own keys (arrows, F2, Delete) must not fire while the menu is open
  const i = entries.value.indexOf(document.activeElement as HTMLElement);
  const n = props.items.length;
  const to = (j: number) => { e.preventDefault(); entries.value[(j + n) % n]?.focus(); };
  if (e.key === 'ArrowDown') to(i + 1);
  else if (e.key === 'ArrowUp') to(i - 1);
  else if (e.key === 'Home') to(0);
  else if (e.key === 'End') to(n - 1);
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(true); }
}
defineExpose({ show });
</script>

<template>
  <div
    ref="root"
    class="item-menu"
  >
    <button
      type="button"
      class="icon-button"
      tabindex="-1"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click.stop="open ? close(true) : show()"
      @dblclick.stop
    >
      <span
        class="icon icon-more"
        aria-hidden="true"
      />
    </button>
    <ul
      v-if="open"
      ref="menu"
      class="menu"
      :class="{ 'menu-up': up }"
      role="menu"
      :aria-label="label"
      @keydown="onKey"
      @click.stop
      @dblclick.stop
    >
      <li
        v-for="item in items"
        :key="item.id"
        role="none"
      >
        <button
          :ref="(el) => { if (el) entries[items.indexOf(item)] = el as HTMLElement }"
          type="button"
          role="menuitem"
          tabindex="-1"
          @click="choose(item.id)"
        >
          {{ item.label }}
        </button>
      </li>
    </ul>
  </div>
</template>
