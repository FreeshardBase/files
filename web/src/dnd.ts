// Drag & drop of list items onto folders and breadcrumbs. The payload is the dragged paths and their source in our own
// MIME type, so files dragged in from the desktop or text from another page are never taken for a move. The source
// tells a drop from the other pane (#218) apart. Files and folders dragged in from the desktop are an upload instead
// (`acceptFileDrag`, `droppedFiles`).
const TYPE = 'application/x-files-paths';

export type DraggedItems = { source: string; paths: string[] };

export function startDrag(ev: DragEvent, source: string, paths: string[]): void {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.setData(TYPE, JSON.stringify({ source, paths } satisfies DraggedItems));
  ev.dataTransfer.effectAllowed = 'move';
}

/** During dragover only the types are readable; accepting the drop needs preventDefault. */
export function acceptDrag(ev: DragEvent): boolean {
  if (!ev.dataTransfer?.types.includes(TYPE)) return false;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  return true;
}

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

export function droppedPaths(ev: DragEvent): DraggedItems | null {
  const raw = ev.dataTransfer?.getData(TYPE);
  if (!raw) return null;
  ev.preventDefault();
  const items = JSON.parse(raw) as Partial<DraggedItems> | null;
  if (typeof items?.source !== 'string' || !Array.isArray(items.paths) || !items.paths.every((p) => typeof p === 'string')) {
    throw new Error('malformed drag payload');
  }
  return { source: items.source, paths: items.paths };
}
