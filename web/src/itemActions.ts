// The selection model and item actions shared by the list and the gallery (#229): Ctrl+click and Space toggle, Shift+click
// selects a range, the item menu and the action keys (F2, Delete, Ctrl+C/X/V/A, the context menu key) act on the
// selection if the item is part of it, else on the item alone. Each view keeps its own navigation keys and layout.
import { computed, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';

export type ItemAction = 'download' | 'favourite' | 'share' | 'details' | 'rename' | 'cut' | 'copy' | 'trash'
  | 'copyToOther' | 'moveToOther' | 'moveTo' | 'copyTo';
// `toOther`: a second pane takes items (#218): copying there only reads the items, moving there also changes this source.
export type ItemProps = { entries: Entry[]; selected: string[]; editable: boolean; shareable: boolean; starred: string[];
  toOther?: boolean };
type Emits = {
  open: (e: Entry) => void; select: (paths: string[]) => void; paste: () => void;
  // `from`: the menu button the action was chosen in, for a dialog to give the focus back to (#339).
  action: (a: ItemAction, entries: Entry[], from?: HTMLElement) => void;
};

// Rename, favourite, share and details act on the item itself, never on the whole selection; a menu that acts on a
// selection of several (#340) leaves them out.
const SINGLE = new Set(['rename', 'favourite', 'share', 'details']);

/** The browser keeps its own context menu (#340) in text fields and editable content, and over selected text. */
export function wantsNativeMenu(e: MouseEvent): boolean {
  const at = e.target instanceof Element ? e.target : null;
  if (at?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  const sel = getSelection();
  return !!sel && !sel.isCollapsed && !!at && sel.containsNode(at, true);
}

export function useItemActions(props: ItemProps, emit: Emits,
  ui: { showMenu: (i: number) => void; menuButton: (i: number) => HTMLElement | undefined }) {
  const { t } = useI18n();
  let anchor = 0; // where a Shift+click range starts
  const chosen = computed(() => new Set(props.selected));
  function toggle(i: number) {
    anchor = i;
    const p = props.entries[i]!.path;
    emit.select(chosen.value.has(p) ? props.selected.filter((x) => x !== p) : [...props.selected, p]);
  }
  function selectRange(i: number) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    emit.select(props.entries.slice(a, b + 1).map((e) => e.path));
  }
  // An action on an item applies to the whole selection if the item is part of it, else to the item alone.
  const targets = (i: number): Entry[] => chosen.value.has(props.entries[i]!.path)
    ? props.entries.filter((e) => chosen.value.has(e.path)) : [props.entries[i]!];

  // The guide's dropdown order (PDF p.18, #241): what opens or looks at the item, then what changes it, then the
  // destructive action alone under a hairline.
  const menuItems = computed(() => ([
    'download', ...(props.shareable ? ['share'] as const : []), 'details',
    ...(props.editable ? ['rename', 'cut', 'copy', 'moveTo'] as const : []), 'copyTo',
    ...(props.toOther ? ['copyToOther', ...(props.editable ? ['moveToOther'] as const : [])] as const : []),
    'favourite', ...(props.editable ? ['trash'] as const : []),
  ] as const).map((id) => ({ id, label: t(`actions.${id}`), danger: id === 'trash' })));
  // The favourite entry says what choosing it does to this item (#155).
  const starredSet = computed(() => new Set(props.starred));
  const isFavourite = (e: Entry) => starredSet.value.has(e.path);
  // A menu on an item of a selection of several acts on all of them and says how many (#340).
  const selectedCount = computed(() => props.entries.filter((e) => chosen.value.has(e.path)).length);
  const several = (e: Entry) => chosen.value.has(e.path) && selectedCount.value > 1;
  const itemsFor = (e: Entry) => (several(e) ? menuItems.value.filter((m) => !SINGLE.has(m.id))
    : menuItems.value.map((m) => m.id === 'favourite'
      ? { id: m.id, label: t(isFavourite(e) ? 'favourites.remove' : 'favourites.add') } : m));
  const headingFor = (e: Entry) => (several(e) ? t('actions.menuSelection', { count: selectedCount.value }) : undefined);
  // A right-click or long-press on an item outside the selection selects only that item first (#340).
  function selectForMenu(i: number) {
    const p = props.entries[i]!.path;
    if (!chosen.value.has(p)) { anchor = i; emit.select([p]); }
  }
  function fromMenu(i: number, id: string) {
    emit.action(id as ItemAction, SINGLE.has(id) ? [props.entries[i]!] : targets(i), ui.menuButton(i));
  }

  /** The keys that select, act or open; true when the key was one of them. Navigation keys belong to each view. */
  function onActionKey(e: KeyboardEvent, i: number): boolean {
    const entry = props.entries[i]!;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => { e.preventDefault(); return true; };
    if (key === ' ' && handled()) toggle(i);
    else if (props.editable && key === 'F2' && handled()) emit.action('rename', [entry]);
    else if (props.editable && key === 'Delete' && handled()) emit.action('trash', targets(i));
    else if (props.editable && mod && key === 'c' && handled()) emit.action('copy', targets(i));
    else if (props.editable && mod && key === 'x' && handled()) emit.action('cut', targets(i));
    else if (props.editable && mod && key === 'v' && handled()) emit.paste();
    // "Move to…" and "Copy to…" (#339): the folder picker.
    else if (props.editable && e.shiftKey && !mod && !e.altKey && key === 'm' && handled()) emit.action('moveTo', targets(i));
    else if (e.shiftKey && !mod && !e.altKey && key === 'c' && handled()) emit.action('copyTo', targets(i));
    else if (mod && key === 'a' && handled()) emit.select(props.entries.map((x) => x.path));
    else if ((key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) && handled()) ui.showMenu(i);
    else if (key === 'Enter' && handled()) emit.open(entry); // a folder opens, a file opens in the preview
    else return false;
    return true;
  }
  /** Shift+click selects a range, Ctrl+click toggles; true when the click did either. */
  function onSelectClick(e: MouseEvent, i: number): boolean {
    if (e.shiftKey) selectRange(i);
    else if (e.ctrlKey || e.metaKey) toggle(i);
    else return false;
    return true;
  }

  return { chosen, toggle, targets, itemsFor, headingFor, selectForMenu, isFavourite, fromMenu, onActionKey, onSelectClick };
}

// Long-press (#160): a touch held still for half a second calls `onPress`. The click the lifted finger may still produce
// is swallowed, so the press does not also open or select the item. A finger that moves more than 10 px is a scroll, as
// is a touch the browser takes over (pointercancel). `accept` limits where a press may start (the empty area, #340).
const LONG_PRESS_MS = 500;
export function useLongPress(onPress: (i: number, at: { x: number; y: number }) => void, accept?: (e: PointerEvent) => boolean) {
  let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let pressed = false;
  function cancel() { if (press) clearTimeout(press.timer); press = null; }
  function onPointerDown(e: PointerEvent, i: number) {
    cancel();
    pressed = false;
    if (e.pointerType !== 'touch' || (e.target instanceof Element && e.target.closest('.item-menu'))) return;
    if (accept && !accept(e)) return;
    const at = { x: e.clientX, y: e.clientY };
    press = { ...at, timer: setTimeout(() => { press = null; pressed = true; onPress(i, at); }, LONG_PRESS_MS) };
  }
  function onPointerMove(e: PointerEvent) {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); // a scroll, not a press
  }
  function onClickCapture(e: MouseEvent) {
    if (!pressed) return;
    pressed = false;
    e.preventDefault(); e.stopPropagation();
  }
  onBeforeUnmount(cancel);
  /** A touch is being held or has just been held: the browser's own long-press context menu belongs to it. */
  const touching = () => press !== null || pressed;
  return { onPointerDown, onPointerMove, onPointerUp: cancel, onClickCapture, touching };
}
