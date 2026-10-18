// Drag & drop of list items onto folders and breadcrumbs. The payload is the dragged paths and their source in our own
// MIME type, so files dragged in from the desktop or text from another page are never taken for a move. The source
// tells a drop from the other pane (#218) apart. Files and folders dragged in from the desktop are an upload instead
// (`acceptFileDrag`, `droppedFiles`).
//
// Across sources (#338): the drag in flight is kept here, since dragover cannot read the payload. A drop within one
// source moves (Ctrl/Alt copies), between sources it copies (Shift moves). Targets say what a drop would do in `hint`,
// which the badge at the pointer (components/DragBadge.vue) shows; a target held under the pointer for SPRING_MS opens
// (`springOver`). Esc cancels the drag: nothing opens and nothing is dropped any more.
import { reactive } from 'vue';

const TYPE = 'application/x-files-paths';
export const SPRING_MS = 800;

export type DraggedItems = { source: string; paths: string[] };
export type DropMode = 'move' | 'copy';
export type DragHint = { mode: DropMode; target: string } | { refused: true };

export const drag = reactive<{ items: DraggedItems | null; cancelled: boolean; hint: DragHint | null; x: number; y: number }>({
  items: null, cancelled: false, hint: null, x: 0, y: 0,
});
// The dragover event the hint was set for: the badge drops a hint no target set for the current event.
let hintEvent: Event | null = null;

export function startDrag(ev: DragEvent, source: string, paths: string[]): void {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.setData(TYPE, JSON.stringify({ source, paths } satisfies DraggedItems));
  ev.dataTransfer.effectAllowed = 'copyMove';
  endDrag();
  drag.items = { source, paths };
}

/** The drag is over: dropped, ended or cancelled. */
export function endDrag(): void {
  cancelSpring();
  drag.items = null; drag.cancelled = false; drag.hint = null; hintEvent = null;
}
export function cancelDrag(): void {
  cancelSpring();
  drag.cancelled = true; drag.hint = null;
}
/** Called by the badge for every dragover that reached the window: a hint no target set for it is stale. */
export function trackPointer(ev: DragEvent): void {
  drag.x = ev.clientX; drag.y = ev.clientY;
  if (hintEvent !== ev) drag.hint = null;
}

/** What a drop of our items onto source `to` does: Ctrl/Alt (Option) copies within a source, Shift moves between. */
export function dropMode(ev: DragEvent, from: string, to: string): DropMode {
  if (from === to) return ev.ctrlKey || ev.altKey ? 'copy' : 'move';
  return ev.shiftKey ? 'move' : 'copy';
}

/** Our items in flight, not cancelled, and over the page now (only the types are readable during dragover). */
function ours(ev: DragEvent): DraggedItems | null {
  return ev.dataTransfer?.types.includes(TYPE) && drag.items && !drag.cancelled ? drag.items : null;
}

/**
 * Accepts our items over a target folder of source `to` named `target` (accepting needs preventDefault), with the
 * drop effect and badge of the mode the modifier keys choose.
 */
export function acceptDrag(ev: DragEvent, to: string, target: string): boolean {
  const items = ours(ev);
  if (!items) return false;
  ev.preventDefault();
  const mode = dropMode(ev, items.source, to);
  ev.dataTransfer!.dropEffect = mode;
  drag.hint = { mode, target }; hintEvent = ev;
  return true;
}
/** A read-only target under our items: the drop is refused (no preventDefault) and the badge says so. */
export function refuseDrag(ev: DragEvent): boolean {
  if (!ours(ev)) return false;
  ev.dataTransfer!.dropEffect = 'none';
  drag.hint = { refused: true }; hintEvent = ev;
  return true;
}

// Spring-loaded targets: the first dragover over `key` starts the timer, leaving the target or ending the drag stops it.
let spring: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
export function springOver(ev: DragEvent, key: string, open: () => void): void {
  if (!ours(ev) || spring?.key === key) return;
  cancelSpring();
  spring = { key, timer: setTimeout(() => { spring = null; if (drag.items && !drag.cancelled) open(); }, SPRING_MS) };
}
/** dragleave of `key`: moving onto one of its own children is no leave. */
export function springLeave(ev: DragEvent, key: string): void {
  const el = ev.currentTarget as HTMLElement | null;
  if (el && ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget)) return;
  if (spring?.key === key) cancelSpring();
}
function cancelSpring() {
  if (spring) clearTimeout(spring.timer);
  spring = null;
}

/** A drop that a target outside a folder pane took (a sidebar source, a share): the folder pane of `to` runs it. */
export const pendingDrop = reactive<{ value: (DraggedItems & { to: string; dir: string; mode: DropMode }) | null }>({ value: null });

/** Files dragged in from the desktop (never our own list items): accepted as an upload. */
export function acceptFileDrag(ev: DragEvent): boolean {
  const types = ev.dataTransfer?.types;
  if (!types?.includes('Files') || types.includes(TYPE)) return false;
  ev.preventDefault();
  ev.dataTransfer!.dropEffect = 'copy';
  return true;
}

export type DroppedFile = { file: File; rel: string };

/**
 * The files of a desktop drop, folders walked recursively; `rel` is the path below the drop target, so a dropped
 * folder is recreated. The entries must be taken during the drop event, so this reads them synchronously and only
 * then walks them. Returns null for a drop that carries no files.
 */
export function droppedFiles(ev: DragEvent): Promise<DroppedFile[]> | null {
  const dt = ev.dataTransfer;
  if (!dt?.types.includes('Files') || dt.types.includes(TYPE)) return null;
  ev.preventDefault();
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (entries.length === 0 || entries.some((e) => e === null)) {
    // No entry API: plain files only (a browser without it cannot drop folders).
    return Promise.resolve(Array.from(dt.files, (file) => ({ file, rel: file.name })));
  }
  return walkEntries(entries as FileSystemEntry[]);
}

export async function walkEntries(entries: FileSystemEntry[], prefix = ''): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands out a folder in portions until it returns an empty list.
      for (;;) {
        const portion = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (portion.length === 0) break;
        out.push(...await walkEntries(portion, `${prefix}${entry.name}/`));
      }
    }
  }
  return out;
}

/** The items dropped onto a folder of source `to`, with the mode of the keys held at the drop; null after Esc. */
export function droppedPaths(ev: DragEvent, to: string): (DraggedItems & { mode: DropMode }) | null {
  const raw = ev.dataTransfer?.getData(TYPE);
  if (!raw) return null;
  ev.preventDefault();
  if (drag.cancelled) return null;
  const items = JSON.parse(raw) as Partial<DraggedItems> | null;
  if (typeof items?.source !== 'string' || !Array.isArray(items.paths) || !items.paths.every((p) => typeof p === 'string')) {
    throw new Error('malformed drag payload');
  }
  return { source: items.source, paths: items.paths, mode: dropMode(ev, items.source, to) };
}
