import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

// Windowing for large folders (#225). Only the rows near the viewport are rendered; the rows above and below are one
// spacer each, as tall as the rows they stand for. The page (or any ancestor) scrolls as before: the window follows
// every scroll on the page and every change of its size. `pinned` is always rendered, wherever it is, so the roving tab
// stop keeps its element: focusing it scrolls it into view, and scrolling away does not drop the focus.

/** Pixels rendered beyond each edge of the viewport, so a fast scroll or a keypress rarely shows an empty spacer. */
const OVERSCAN = 800;
/** Folders with more entries than this are windowed; smaller ones render whole, so the browser's find still sees them. */
export const WINDOW_FROM = 200;

/** One rendered slot: a row by its index, or a spacer of `size` pixels standing for the rows it skips. */
export type Slot = { row: number; key?: undefined; size?: undefined } | { key: string; size: number; row?: undefined };

export function useWindowedRows(el: Ref<HTMLElement | undefined>, o: {
  count: () => number;
  /** The height of row `i`, measured or estimated. */
  size: (i: number) => number;
  /** The row that is always rendered (the tab stop), or -1. */
  pinned: () => number;
  /** Pixels taken off each spacer: a grid's row gap, which a spacer row is followed by like any row. */
  trim?: () => number;
  /** Called on every scroll and resize before the window is placed: a chance to measure the layout again. */
  layout?: () => void;
  /** True while every row is rendered (a folder of at most WINDOW_FROM entries). */
  whole: () => boolean;
}) {
  // The part of `el` that is near the viewport, in `el`'s own coordinates.
  const top = ref(0);
  const bottom = ref(typeof innerHeight === 'number' ? innerHeight : 0);
  function place() {
    o.layout?.();
    const box = el.value?.getBoundingClientRect();
    if (!box) return;
    top.value = -box.top - OVERSCAN;
    bottom.value = innerHeight - box.top + OVERSCAN;
  }
  // offsets[i] is where row i starts; offsets[count] is the height of all rows.
  const offsets = computed(() => {
    const n = o.count(); const at = new Array<number>(n + 1); at[0] = 0;
    for (let i = 0; i < n; i++) at[i + 1] = at[i]! + o.size(i);
    return at;
  });
  // The first row that ends below `y`.
  function rowAt(y: number) {
    const at = offsets.value; let lo = 0; let hi = at.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid + 1]! > y) hi = mid; else lo = mid + 1; }
    return lo;
  }
  const start = computed(() => (o.whole() ? 0 : rowAt(top.value)));
  const end = computed(() => (o.whole() ? o.count() : Math.max(start.value, Math.min(o.count(), rowAt(bottom.value) + 1))));
  const slots = computed<Slot[]>(() => {
    const n = o.count(); const at = offsets.value; const trim = o.trim?.() ?? 0; const pin = o.pinned();
    const rows: number[] = [];
    if (pin >= 0 && pin < start.value) rows.push(pin);
    for (let i = start.value; i < end.value; i++) rows.push(i);
    if (pin >= end.value && pin < n) rows.push(pin);
    const out: Slot[] = []; let next = 0;
    const gap = (to: number) => {
      const size = at[to]! - at[next]! - trim;
      if (to > next && size > 0) out.push({ key: `\0gap${out.length}`, size });
    };
    for (const r of rows) { gap(r); out.push({ row: r }); next = r + 1; }
    gap(n);
    return out;
  });

  let resized: ResizeObserver | undefined;
  onMounted(() => {
    place();
    addEventListener('scroll', place, { capture: true, passive: true });
    addEventListener('resize', place);
    // Content above the list (the selection bar, a failure box) moves it without a scroll.
    resized = new ResizeObserver(place);
    resized.observe(document.body);
  });
  onBeforeUnmount(() => {
    removeEventListener('scroll', place, { capture: true });
    removeEventListener('resize', place);
    resized?.disconnect();
  });
  return { slots, place };
}
