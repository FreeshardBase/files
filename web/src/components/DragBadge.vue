<script setup lang="ts">
// The badge at the pointer while our items are dragged (#338): what a drop on the target under it does ("Copy to Google
// Drive", "Move to Projects") or that the target refuses it. It follows the dragover events that reach the window, ends
// with the drag, and Esc cancels the drag. Pointer only: keyboard members use "Move to…" / "Copy to…".
import { onMounted, onUnmounted } from 'vue';
import { cancelDrag, drag, endDrag, trackPointer } from '../dnd.ts';

// dragenter counts as well: the browser may send the next dragover only on a later move.
const onOver = (e: DragEvent) => { if (drag.items) trackPointer(e); };
// A leave to nowhere is out of the window: no badge there.
const onLeave = (e: DragEvent) => { if (e.relatedTarget === null) drag.hint = null; };
const onEnd = () => { endDrag(); };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.items) cancelDrag(); };
onMounted(() => {
  window.addEventListener('dragenter', onOver);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onEnd);
  // capture: the row that started the drag may be gone by now (a spring-loaded target opened another folder)
  document.addEventListener('dragend', onEnd, true);
  window.addEventListener('keydown', onKey, true);
});
onUnmounted(() => {
  window.removeEventListener('dragenter', onOver);
  window.removeEventListener('dragover', onOver);
  window.removeEventListener('dragleave', onLeave);
  window.removeEventListener('drop', onEnd);
  document.removeEventListener('dragend', onEnd, true);
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <div
    v-if="drag.items && drag.hint"
    class="drag-badge"
    aria-hidden="true"
    :data-refused="'refused' in drag.hint"
    :style="{ left: `${drag.x + 14}px`, top: `${drag.y + 18}px` }"
  >
    {{ 'refused' in drag.hint ? $t('dnd.refused') : $t(drag.hint.mode === 'move' ? 'dnd.moveTo' : 'dnd.copyTo', { target: drag.hint.target }) }}
  </div>
</template>
