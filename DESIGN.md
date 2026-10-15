# DESIGN

The design guide "Daylight Instrument" (`docs/design-guide.md`) is binding. This file records only what the guide does not cover and where this app deviates.

## Tokens

`web/src/styles/tokens.css` and `web/src/styles/components.css` are copied from the guide bundle (`tokens.json` is canonical there). Do not edit values here; update the bundle and copy again. Fonts (Inter, IBM Plex Mono) come from `@fontsource` packages and are served by the shard, never from a font CDN.

## Icons

Line icons are SVG on a 24px grid with a 1.5px stroke, stored as data-URI custom properties (`--icon`) in `web/src/styles/app.css` and drawn through a CSS mask on the `.icon` class. The colour therefore comes from the theme tokens, not from the SVG. No emoji, no icon fonts.

## Dialogs

The guide has no dialog recipe. `<AppDialog>` (`web/src/components/AppDialog.vue`) is a `.fs-sheet`-like surface (surface tone, hairline border, sheet radius, no shadow) centred on a flat scrim of `--bg` at 70 %. The scrim separates the sheet by tone, not by elevation, so the "no shadows" rule holds in both themes. On phone width the sheet sits at the bottom edge and the action buttons share the row. Actions are outline buttons of equal weight: the one forward action takes the amber hairline (`.button.primary`), a destructive one the danger hairline (`.button.danger`). In the collision dialog "keep both" is the forward action and takes the initial focus, because it never loses data; "replace" is marked destructive. The "apply to all" checkbox is a native checkbox tinted with `accent-color: var(--data)` instead of the guide's custom `.fs-check`, so it keeps native keyboard and screen-reader behaviour without extra script.

## Selection, menus and drop targets

The guide has no recipe for these. A selected row takes a teal tint (`--data` at 9 %), never an amber fill, because amber is reserved for the one forward action. Row checkboxes use the native checkbox with `accent-color: var(--data)`, like the dialog checkbox. The row action menu is a sheet-like popup (surface tone, hairline border, tile radius, no shadow) behind a borderless icon button with a line "more" icon; on phone width the button is a 44 px touch target and the row is checkbox, name, menu, with size and date on a second line. A drop target (folder row or breadcrumb) gets a dashed teal hairline. While items are marked for moving or copying, "Move here"/"Copy here" is the forward action (`.button.primary`) and "Move to trash" the destructive one (`.button.danger`).

## Sidebar and trash

The guide has no navigation recipe. The source sidebar is a 200 px column on the surface tone with a hairline border; entries carry a line icon, and the current place is marked by a teal hairline at its left edge and teal text, never a fill. On phone width it becomes a row of tabs under the header with the hairline underneath. The trash view reuses the file-list table; each row has "Restore" (outline) and "Delete permanently" (danger hairline). "Empty trash" is a danger outline button, dimmed when the trash is empty. Every permanent delete asks first in `ConfirmDialog`, where "Cancel" takes the initial focus, because the safe choice should be the default.

## Deviations

None beyond this: the file list is a table (`FileList.vue`, a real `<table>`), because name, size and modified date are columns the user compares. The guide has no list recipe.
