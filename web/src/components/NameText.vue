<script lang="ts">
import { ref } from 'vue';

// The bundled fonts change the line breaks once the page has loaded; every name is measured again then.
const loaded = ref(0);
addEventListener('load', () => { loaded.value++; });
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { nameParts } from '../format.ts';

// A row's name (#237, #336): two lines at most. A name that needs more is cut in the middle like a gallery tile's: the
// head takes the ellipsis at the end of its second line and the tail (the end and the extension, `nameParts`) stays whole
// beside it. The two parts are hidden from assistive technology and the full name is there as hidden text instead: the
// head is a block, and a browser would put a space between the parts in the accessible name. The title is the full name.
// The name is measured again when its cell changes width (a turned phone, tag chips arriving beside it). The cell's
// width does not depend on whether the name is cut, so cutting it never feeds back into the measurement.
const props = defineProps<{ name: string }>();
const el = ref<HTMLElement>();
const cut = ref(false);
const parts = computed(() => nameParts(props.name));

async function measure() {
  cut.value = false;
  await nextTick();
  const e = el.value;
  if (e) cut.value = e.scrollHeight > e.clientHeight + 1;
}
let width = -1;
const resized = new ResizeObserver(([entry]) => {
  const w = Math.round(entry!.contentRect.width);
  if (w === width) return;
  width = w;
  void measure();
});
onMounted(() => {
  const cell = el.value!.parentElement!.closest('td, li') ?? el.value!.parentElement!;
  resized.observe(cell);
  void measure();
});
onBeforeUnmount(() => resized.disconnect());
watch([() => props.name, loaded], () => { void measure(); });
</script>

<template>
  <span
    ref="el"
    class="name-text"
    :title="name"
    :data-cut="cut || undefined"
  ><template v-if="cut"><span class="visually-hidden">{{ name }}</span><span
    class="name-head"
    aria-hidden="true"
  >{{ parts[0] }}</span><span
    class="name-tail"
    aria-hidden="true"
  >{{ parts[1] }}</span></template><template v-else>{{ name }}</template></span>
</template>
