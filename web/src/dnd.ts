// Drag & drop of list items onto folders and breadcrumbs. The payload is the dragged paths in our own MIME type,
// so files dragged in from the desktop or text from another page are never taken for a move.
const TYPE = 'application/x-files-paths';

export function startDrag(ev: DragEvent, paths: string[]): void {
  if (!ev.dataTransfer) return;
  ev.dataTransfer.setData(TYPE, JSON.stringify(paths));
  ev.dataTransfer.effectAllowed = 'move';
}

/** During dragover only the types are readable; accepting the drop needs preventDefault. */
export function acceptDrag(ev: DragEvent): boolean {
  if (!ev.dataTransfer?.types.includes(TYPE)) return false;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  return true;
}

export function droppedPaths(ev: DragEvent): string[] | null {
  const raw = ev.dataTransfer?.getData(TYPE);
  if (!raw) return null;
  ev.preventDefault();
  const paths: unknown = JSON.parse(raw);
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Error('malformed drag payload');
  return paths;
}
