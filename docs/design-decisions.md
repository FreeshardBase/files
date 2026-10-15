---
type: reference
first_mentioned: 2026-05-31
---

# Design decisions & parked ideas

The reasoning behind the style — choices made, alternatives rejected, and ideas captured
but not yet adopted. The [`design-guide.md`](design-guide.md) states *what* the style is;
this file records *why*, so agents (and humans) can reason about changes without re-deriving
the trade-offs. Newest decisions roughly last within each section.

## Direction

- **"Daylight Instrument" chosen** over two other explored directions:
  - *Orbital Glass* — dark, most Expanse-literal (edge-lit glass, grids, glow). Rejected:
    too dramatic; Freeshard's values are honesty/clearness, not cinema.
  - *Living Topography* — organic contour-line motif. Rejected: pretty but decorative.
  - Reference touchstone stays The Expanse (thin bright lines, function-first), but
    **inverted** to light/everyday.
- **Decorative geometry dropped.** Early mockups had background grids and concentric
  circles; removed as form-over-function. Principle: *every line earns its place.*

## Nordic / IKEA framing (added 2026-05-31)

- A viewer read the BFL mood images as "Swedish / IKEA." Leaned in deliberately — it's the
  brief converging on **Scandinavian functionalism**.
- **Why it fits:** IKEA's "democratic design" (good design for everyone) ≈ Freeshard's "self-
  hosting as the new normal for everyone"; *lagom* (just enough) ≈ get-out-of-the-way;
  flat-pack **assembly instructions** (wordless, numbered, zero marketing) = the honest-UI
  ideal for onboarding/empty states.
- **Guard:** material language (wood/paper/textile) is **mood-only** — palette warmth + BFL
  imagery. The UI itself is **never textured** (flat solid fills); texture is noise and
  breaks calm + every-line-earns-its-place.

## Theme & color

- **Adaptive light + dark; light is primary.**
- **Dark = warm "dusk" (`#16140f`)**, chosen over a cool teal-black night. Reason: cozier,
  echoes the warm-paper light mode. **Cost accepted:** pure brand teal goes murky on warm-
  brown, so dark hairlines use a softened cyan `#9fd8e6` (not the brand `#80d0f0`) and amber
  brightens to `#f0b35e`. This is the one place brand hex is relaxed, for legibility.
- **Glow policy = "glow only on live data" (option B)**, over (A) fully flat and (C) ambient
  glow. Glow is a *signal, never decoration*: an element glows iff it is actively
  live/changing (e.g. the online status dot). Light mode has no glow at all.
- **Amber accent** marks exactly one forward action per view; never a background fill.

## Typography

- **Inter** (humanist) chosen over **Space Grotesk** (technical grotesk). Reason: warm,
  approachable — leans into "belongs in the natural world." IBM Plex Mono for IDs / exact
  values (mono signals precision → reinforces honesty).

## Shard identity badge

- **Content decided:** brand diamond logomark (`Shard_logomark_color.png`, single crystal —
  not the full logomark with satellite shards) + 6-digit short id in mono. **No** avatar
  (mutable), **no** name, **no** domain, **no** copy button. Must render identically in-app
  (menu-bar height ~28–30px) and standalone as a sticker — so no interactive chrome.
- **Frame treatment UNDECIDED.** Live candidates:
  1. Corner brackets (flat HUD registration marks)
  2. Double hairline (flat certificate/stamp edge)
  3. **Variable-width perimeter fingerprint** (hash-derived) — front-runner.
  Rejected frames: pill (reads as a button), single notch (too subtle), stamped/embossed and
  inset/debossed (require shadows → break the no-shadow rule).

### Fingerprint algorithm (the front-runner frame)

Deterministic from the shard hash; the border *is* the fingerprint (so it encodes the id →
honest, and gives at-a-glance recognizability + anti-spoofing). No separate outer line — the
variable-thickness border is the whole frame:

1. Start thick or thin — 1 bit from the hash.
2. 5–10 switch positions ∈ `[0,1]` around the perimeter — count + values from a PRNG seeded
   by the hash.
3. Thickness flips at each switch. Continuous border, corners flow through, runs are random-
   length. Two weights only (≈1.2px thin / ≈3.2px thick at 28px height).

Outer edge = clean rounded-rect silhouette; the **inner** edge wobbles (thickness grows
inward). Render as an even-odd ring — a duplicate seam sample caused a self-crossing spike,
fixed by sampling the perimeter without repeating the endpoint. Reference implementation:
`build/build_guide.py` → `badge()` / `_ring()`.

### Rejected fingerprint forms (do not revisit without new reason)

- Abstract generated glyphs: segment-ring, dot-matrix, constellation. Shelved 2026-05-30 —
  felt like decoration, weak tie to the id.
- Recoloring the diamond's four facets from the hash (brand-locked or wide-gamut palette).
  Brand-locked too subtle; wide-gamut put shards off-brand (green/violet). Shelved.
- Bottom-edge-only ("underline") variant of the variable-width border. Dropped in favor of
  full perimeter.

## Interaction components (added 2026-06-03)

- **Example screens.** Two full Home-dashboard mockups (light + dark) open the guide so the
  whole style is visible in one view before the per-component pages. Built by composing the
  existing component recipes via `screen()` — not bespoke markup — so they stay token-accurate.
- **Modal · backgrounding the page.** When a modal opens the page reads as inactive by
  **receding toward the paper ground** (`--bg` veil ~55% light / ~50% dark) **+ mild
  desaturation** (`grayscale(0.5)`) on the page layer; the modal keeps full colour and lifts
  on its border alone. Never a drop shadow. Rejected: flat ink scrim (too "covered"), frost/
  blur (least flat, heaviest), full desaturate+opacity (too dead). Reviewed on the preview
  server before committing.
- **Context menu.** Icon + label rows (Daylight glyphs), one resting highlight, hairline
  before the destructive item — the dropdown family, anchored on the target. A small
  **bordered arrow tip (beak)** points at the target tile and relocates to whichever edge
  faces the target when the menu repositions at a screen edge. Rejected: visually merging the
  menu into the tile (absorbed-header / docked-capsule) — "did not work well".
- **Sparkline.** Carries the controller-app feature set (max/0 mono labels, hairline zero
  baseline, grey blocks for missing hourly samples, dashed midnight separators, hover marker
  + value tooltip) into Daylight tokens. Stroke is a **vertical gradient mapped to value
  height — the tips (peaks) glow brightest, troughs dim** — so brightness encodes the value
  (honesty rule) and doubles as dusk "glow only on live data". 3-stop gradient for a bold,
  legible effect. A **compact / inline** form (~text height, no axis furniture, dot on the
  latest sample) is for list rows and inline mentions. Rejected as defaults: area-glow fill,
  per-peak dots, leading-edge brightness (kept as alternatives only).

## Keyboard navigation (added 2026-06-08)

- **First-class, one shared focus, three always-live inputs.** Tab between regions, arrows
  within *and across* regions (everything arrow-reachable — arrows are the floor), Alt-hold
  for key jumps. Enter activates, Esc steps out.
- **No on/off setting.** Considered a 3-state setting (mouse-only / arrows+enter / shortcuts)
  and **dropped it.** Reason: keyboard focus can't truly be turned off in a browser (Tab/a11y
  guarantee), so the setting could only gate *visible chrome* — and once keys work everywhere,
  it changed too little to justify. Chrome is summoned by intent (`:focus-visible`, `Alt`-hold)
  and invisible at rest instead — same instinct as "glow only on live data".
- **Focus chrome = teal outline + slight zoom.** Ring is a CSS `outline` (zero reflow, unlike a
  border); focused element also scales up via `transform` (compositor-only, no reflow). Settled
  on **scale 1.2** after 1.08/1.14 read as too weak. Caveats noted: clip by `overflow:hidden`
  ancestors, need `z-index` raise, raster-icon softening, don't scale full-width rows.
  **Ring is never amber** (reserved for the forward action) and never a fill.
- **Reveal modifier = `Alt`, not `Ctrl`.** The web-terminal runs in a normal browser tab where
  `Ctrl+1…9` switches browser tabs and can't be reliably `preventDefault`-ed; `Alt` is the
  access-key modifier and far less conflicted. macOS Option-inserts-glyphs handled by
  suppressing default outside text inputs.
- **Shortcut tiers, not "every item".** Relaxed the "shortcut for everything" goal: Tier 1 =
  mandatory stable `Alt`+letter mnemonics on core destinations; Tier 2 = positional `Alt+1…9`
  on the current view's repeated elements (`Alt+0` unused, dynamic by position); below that
  best-effort. Every target stays arrow-reachable regardless — a shortcut is never the only path.
- **Hint badges on a separate layer.** Mono key badges are absolutely positioned with
  `pointer-events:none` (no flow participation) at the **top-left, overlapping** the target —
  consistent for tiles and nav items. Rejected: inline badges (shifted the menu-bar layout);
  top-right placement (inconsistent with tiles).
- Playground: `build/build_keynav.py` → `keynav.html`, reviewed on the preview server; the
  chosen look (`focus ring + zoom`, `Alt` badges) ported into `build_guide.py`
  (`kn_scene()` / `_kn_*` helpers) and `tokens/components.css` (`.fs-focusable`, `.fs-keyhint`).

## Tooling learnings

- **Guide generator must stay self-contained.** Playground generators (`build_menus.py`,
  `build_sparkline.py`, `build_modals.py`, `build_keynav.py`) import from `build_guide.py`, so component code
  destined for the guide is duplicated into `build_guide.py` rather than imported back —
  importing a playground would be circular.
- **`demo(dark, body)` already prints a Light/Dark label** — don't add your own inside the body.
- **Landscape content box ≈ 688px tall; a `break-inside:avoid` block taller than the
  remaining space bumps *whole* to the next page.** A full example screen (~600px) only
  shares a page with a one-line heading; a multi-line intro pushes it over. Always rasterize
  the changed pages and check.
- **Playground review loop:** generator writes `build/<name>.html` (kept in `build/` so
  `appicons/`+`shard.png` resolve), served by `tools/preview-server.py` on the VM at
  `clayde.net:<port>/build/<name>.html?key=<secret>`; iterate there, then port the chosen
  variant into `build_guide.py`.
- **Flux has no negative prompt.** BFL playground / Flux ignores "no X" phrasing (may even
  add the excluded thing). Phrase BFL prompts positively ("matte flat surfaces" not "no
  glow"). Same fix applied to the blog [[visual-style]] note. Text suppression is unreliable
  — aim for "blank unmarked panels" and cull bad gens.
- **Guide rendering = HTML → headless Chromium `--print-to-pdf`**, chosen over stitching
  raster screenshots (sharper, real text, paginates via CSS `@page`).

## Open questions / next

- Pick the badge frame treatment (brackets / double-hairline / variable-width fingerprint).
- Dark-mode glow: confirm the live-element set beyond the status dot.
- Components not yet in the guide: tabs, tooltips, notifications/toasts, tables, sliders,
  progress, breadcrumbs/nav hierarchy.
- Decide whether tokens should be generated from a single source (json → css + build) to
  remove the manual sync rule.
