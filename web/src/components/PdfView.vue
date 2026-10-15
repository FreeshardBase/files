<script setup lang="ts">
// PDF preview with pdf.js on a canvas, one page at a time. The browser's own viewer is no option: it refuses a
// document with `CSP: sandbox`, and mobile browsers do not show PDFs inline at all. pdf.js loads with Range requests,
// so a large PDF is not fetched whole before the first page shows.
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const props = defineProps<{ url: string }>();
const emit = defineEmits<{ failed: [] }>();
const canvas = ref<HTMLCanvasElement>();
const doc = shallowRef<PDFDocumentProxy | null>(null);
const page = ref(1);
const rendered = ref(0); // the page on the canvas, 0 while none is
let task: PDFDocumentLoadingTask | null = null;
let queue: Promise<void> = Promise.resolve(); // pdf.js allows one render per canvas at a time

function fail(e: unknown) {
  emit('failed'); // handled: the overlay shows that the preview failed and offers the download
  console.warn('pdf preview failed', e);
}

async function draw() {
  const d = doc.value; const c = canvas.value;
  if (!d || !c) return;
  const n = page.value;
  const p = await d.getPage(n);
  const natural = p.getViewport({ scale: 1 });
  const fit = Math.min(2, (c.parentElement?.clientWidth || natural.width) / natural.width);
  const ratio = window.devicePixelRatio || 1;
  const vp = p.getViewport({ scale: fit * ratio });
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  c.style.width = `${Math.floor(vp.width / ratio)}px`;
  rendered.value = 0;
  await p.render({ canvas: c, viewport: vp }).promise;
  if (doc.value === d) rendered.value = n;
}
const redraw = () => { queue = queue.then(draw).catch(fail); };

async function load(url: string) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const t = pdfjs.getDocument({ url });
  task = t;
  let d: PDFDocumentProxy;
  try { d = await t.promise; }
  catch (e) {
    if (task === t) fail(e); // handled: a superseded load was destroyed on purpose, a current one shows the failure
    return;
  }
  if (task !== t) { void d.loadingTask.destroy(); return; }
  doc.value = d; page.value = 1;
  redraw();
}
function unload() {
  const t = task; task = null; doc.value = null; rendered.value = 0;
  void t?.destroy();
}
watch(() => props.url, (url) => { unload(); void load(url).catch(fail); }, { immediate: true });
onBeforeUnmount(unload);

function turn(by: number) {
  const total = doc.value?.numPages ?? 1;
  const n = page.value + by;
  if (n < 1 || n > total) return;
  page.value = n;
  redraw();
}
</script>

<template>
  <div class="pdf-view">
    <div
      v-if="doc && doc.numPages > 1"
      class="pdf-pages"
    >
      <button
        type="button"
        class="button"
        :aria-disabled="page <= 1"
        @click="turn(-1)"
      >
        {{ $t('preview.pdfPrevious') }}
      </button>
      <span
        class="preview-position"
        aria-live="polite"
      >{{ $t('preview.pdfPage', { n: page, total: doc.numPages }) }}</span>
      <button
        type="button"
        class="button"
        :aria-disabled="page >= doc.numPages"
        @click="turn(1)"
      >
        {{ $t('preview.pdfNext') }}
      </button>
    </div>
    <p v-if="!rendered">
      {{ $t('preview.loading') }}
    </p>
    <canvas
      ref="canvas"
      role="img"
      :aria-label="$t('preview.pdfPage', { n: page, total: doc?.numPages ?? 1 })"
      :data-rendered-page="rendered || undefined"
    />
  </div>
</template>
