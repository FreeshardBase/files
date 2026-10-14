# DESIGN

The design guide "Daylight Instrument" (`docs/design-guide.md`) is binding. This file records only what the guide does not cover and where this app deviates.

## Tokens

`web/src/styles/tokens.css` and `web/src/styles/components.css` are copied from the guide bundle (`tokens.json` is canonical there). Do not edit values here; update the bundle and copy again. Fonts (Inter, IBM Plex Mono) come from `@fontsource` packages and are served by the shard, never from a font CDN.

## Icons

Line icons are SVG on a 24px grid with a 1.5px stroke, stored as data-URI custom properties (`--icon`) in `web/src/styles/app.css` and drawn through a CSS mask on the `.icon` class. The colour therefore comes from the theme tokens, not from the SVG. No emoji, no icon fonts.

## Deviations

None beyond this: the file list is a table (`FileList.vue`, a real `<table>`), because name, size and modified date are columns the user compares. The guide has no list recipe.
