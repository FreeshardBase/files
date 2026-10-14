---
type: reference
first_mentioned: 2026-05-29
---

# Freeshard web-terminal UI style — "Daylight Instrument"

Design spec for the visual style of the shard web-terminal (the daily-driver browser UI
users control their shard with; currently Vue 2 / Bootstrap-Vue). Scope is the
web-terminal only — not the controller dashboard, landing page, or docs, though the
language could extend there later.

This is the **interface** style. Distinct from [[visual-style]], which governs blog
cover **illustration** (ligne claire). The two share the brand palette, nothing else.

## One-line intent

A calm, honest, precise instrument that belongs in daylight. Futuristic through restraint
and precision — thin lines, lots of air — not through glow, grids, or sci-fi ornament.
The interface gets out of the user's way when nothing needs them.

Reference touchstone: The Expanse UI (thin bright lines, function-first, technical
register) — but inverted from dark/cinematic to light/everyday, because Freeshard's
values are honesty and clearness, not drama.

## Principles (these override aesthetics when they conflict)

1. **Every line earns its place.** Lines exist to separate, bound, or encode data.
   No decorative grids, no background circles, no ornament. Form follows function.
2. **Visuals must not lie.** Any graphic that represents a number must encode that number
   accurately. (Origin: the storage ring in the first mockup showed a near-full circle
   while reading 63/100 — a visual lie. Forbidden.) See "Correctness rules".
3. **No dark patterns.** Equal visual weight on opposing choices. Plain-language
   consequences. No pre-checked boxes, no guilt/shame copy, no manufactured urgency,
   no engagement nudges.
4. **Get out of the way.** Idle = quiet. When nothing needs the user, show status and
   little else. No badges, tips, upsells, or "did you know" cards.
5. **Calm over engagement.** Success is the user finishing and leaving, not dwell time.

## Design ethos — Nordic functionalism / democratic design

The style sits in the Scandinavian-functionalist tradition (the "this looks like IKEA"
reaction is the target, not an accident). Why it fits Freeshard:

- **Democratic design.** IKEA's stated philosophy — good design accessible to *everyone* —
  is almost word-for-word Freeshard's mission ("self-hosting as the new normal for
  everyone"). The look should feel unpretentious and for-everyone, never elite/tech-y.
- **Lagom** (just enough). Maps directly onto *get out of the way* and *calm over
  engagement*. Nothing more than needed, on screen or in the flow.
- **Flat-pack honesty.** IKEA assembly instructions — wordless, universal, step-numbered,
  zero marketing — are the purest honest-UI artifact there is. Onboarding, empty states,
  and iconography should aim for that: simple line-figures, numbered clarity, no copy.

**Material language is mood-only — the UI is never textured.** Wood / paper / textile cues
inform the *warmth of the palette* and the *BFL mood imagery*, NOT the interface itself.
Real UI surfaces stay **flat solid fills** — no wood-grain, paper-fiber, fabric, or noise
textures. Texture is visual noise; it breaks *calm* and *every line earns its place*. The
Nordic feel comes from light, proportion, warm neutrals, and restraint — not from rendering
materials.

## Theme — light-first, adaptive

Light is the primary, designed surface. Dark mode is a **warm dark** ("dusk") variant,
specified below. The language renders in both; component logic must stay theme-agnostic.

## Color tokens (light mode)

Brand palette source: `Freeshard_logo_for_dark.png` (shared with [[visual-style]]).
Cool core + single warm accent. The web-terminal uses a **warm-paper** ground rather than
white — warmer and calmer, supports "belongs in the natural world".

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#f6f4ef` | warm paper ground |
| `--surface` | `#fffefb` | raised sheets, tiles, panels |
| `--border` | `#d8d2c6` | warm separators / sheet edges |
| `--border-cool` | `#b7c7cd` | tile / control borders (cool) |
| `--ink` | `#1d3a45` | primary text (deep teal-ink, not black) |
| `--ink-muted` | `#6b7d82` | labels, secondary text |
| `--line` | `#006070` | functional strokes, glyph outlines (deep teal) |
| `--data` | `#007080` | data arcs / gauges / status dot (mid-teal) |
| `--accent` | `#c8761f` | **single forward action only** (amber, darkened for light-bg contrast) |
| `--danger` | `#b04a3a` | destructive actions |

Accent rules: amber marks **one** forward action per view (e.g. "+ add app"). It is never a
background fill and never decorative.

## Color tokens (dark mode — "warm dark / dusk")

Warm near-black ground echoing the warm paper of light mode (cozier than a cool teal-black).
Trade-off accepted: pure brand teal goes murky on warm-brown, so hairlines shift to a softer
cyan and amber brightens. This is the one place the exact brand hex is relaxed, for legibility.

| Token           | Hex                     | Use                                                                   |
| --------------- | ----------------------- | --------------------------------------------------------------------- |
| `--bg`          | `#16140f`               | warm near-black ground                                                |
| `--surface`     | `rgba(120,100,70,.10)`  | raised tiles/panels (warm lift over bg)                               |
| `--border`      | `rgba(232,200,150,.18)` | warm sheet edges                                                      |
| `--border-cool` | `rgba(200,180,150,.22)` | tile/control borders                                                  |
| `--ink`         | `#ece4d6`               | primary text (warm off-white)                                         |
| `--ink-muted`   | `#a89a82`               | labels, secondary text                                                |
| `--line`        | `#9fd8e6`               | functional strokes / glyph outlines (softened cyan — *not* `#80d0f0`) |
| `--data`        | `#9fd8e6`               | data arcs / gauges / live status dot                                  |
| `--accent`      | `#f0b35e`               | single forward action (brightened amber)                              |
| `--danger`      | `#d8665a`               | destructive actions (brightened for dark)                             |

### Glow policy (dark mode only)

Glow is a **signal, never decoration** (decision B). A subtle glow
(`box-shadow: 0 0 7px <color>`) is applied **only to elements that are actively live/changing**
— e.g. the online status dot. A static line, border, label, or idle gauge never glows. If it
glows, it means "this is live right now". Light mode has no glow at all.

## Line / stroke system

- Borders: **1px** structural (sheets), **1.5px** for glyph/icon outlines and data arcs.
- Radius: `14px` sheets/panels, `10px` tiles, `8px` controls/buttons, `7px` glyphs.
- **No shadows.** Elevation is shown by border + surface tone, not drop shadows or glow.
- Generous whitespace; sheets breathe. Air is a primary material, not leftover space.

## Typography

- **UI:** Inter (fallback IBM Plex Sans → system sans). Humanist, warm, approachable.
- **Technical:** IBM Plex Mono — shard IDs, byte counts, uptimes, anything machine-exact.
  Mono signals "this is a precise value", reinforcing honesty.
- Labels: uppercase, ~10px, letter-spacing `.14em`, `--ink-muted`.

## Core components

- **Sheet** — bordered, rounded container on the paper ground. The base building block.
- **Status row** — status dot + shard name (left), state/uptime label (right). Quiet.
- **Data gauge** — thin arc encoding a real ratio (see correctness rules).
- **App tile** — `100×88`, cool border, glyph outline + name. "Add app" tile uses a dashed
  glyph + amber label.
- **Buttons** — outline style, transparent fill. `primary` = amber outline (one per view),
  `danger` = red outline, default = cool outline. **Opposing choices render at equal weight.**
- **Confirm dialog** — title, plain-language consequence sentence, equal-weight button pair.

## Keyboard navigation

Keyboard control is a **first-class** way to drive the web-terminal, not an accessibility
afterthought. There is **one shared focus**; arrows are the universal floor for moving it, and
Tab and the `Alt` shortcuts are speed layers on top. **No on/off setting** — the chrome is
*summoned by intent* and invisible at rest, the same instinct as "glow only on live data"; a
pure-mouse user sees nothing extra. The guide presents this as two pages: *focus & arrows* and
*Alt shortcuts*.

### Focus & arrows

Three always-live ways to move the one shared focus:

1. **Tab / Shift-Tab** — jump between regions (menu bar → grid → open menu/modal).
2. **Arrow keys** — move within a region *and across region boundaries*. **Everything is
   reachable with arrows alone**; arrows are the universal floor. 2D on the grid (stop at
   edges, no wrap), linear in lists/menus. `Enter` activates the focused target, `Esc` steps
   out / closes.

**Focus chrome.** Focus appears on the first keyboard interaction (`:focus-visible`) and shows
as a **teal hairline ring** — rendered as a CSS `outline` so it never shifts layout — plus a
**slight scale-up** of the focused element (a `transform`, i.e. a compositor-only effect with
no reflow; keep ≤1.2 and only on discrete targets like tiles, buttons, and nav items — never on
full-width rows that would overflow). The ring is **never amber** (amber is reserved for the one
forward action) and **never a fill**.

### Alt shortcuts

Hold `Alt` to reveal key badges on bound targets; `Alt+<key>` jumps focus and activates in one
stroke; release to hide. Plain keys never trigger it (so typing is never captured). This is the
access-key tradition (hold-to-reveal), not a separate mode. Badges render on a **separate,
non-reflowing layer** (absolute, `pointer-events:none`) at the **top-left corner, overlapping**
the target — consistently for tiles and nav items. Mono glyphs, paper fill, teal hairline.

**Shortcut tiers:**

- **Tier 1 — core destinations (mandatory).** Stable `Alt`+letter mnemonics on the persistent
  menu-bar destinations (`Alt+H` Home, `Alt+A` Apps, …). Hand-assigned, must never collide.
- **Tier 2 — the current view's repeated elements (positional).** `Alt+1…9`, numbered by
  on-screen position (dynamic; `1` = first slot). On the grid view that's the app grid; other
  views have their own Tier-2 set. `Alt+0` is unused. The 10th+ item has no number — reach it
  by arrows.
- **Best-effort below.** Lower-priority and in-context (open menu / modal) actions get a badge
  where a clean key exists, and are skipped otherwise — but **every** target, badged or not,
  stays arrow-reachable. A shortcut is never the only path.

**Modifier = `Alt`, deliberately** (not `Ctrl`): the web-terminal runs in a normal browser
tab, where `Ctrl+1…9` is reserved for tab-switching and can't be reliably overridden. `Alt`
is the access-key modifier and is far less conflicted. (On macOS `Alt`=Option inserts special
characters in text fields; handled by suppressing the default outside text inputs.)

## Correctness rules (honest-by-construction)

- A gauge/bar/ring MUST set its filled length from the actual value. For an SVG ring of
  radius `r`, circumference `C = 2πr`; `stroke-dasharray = (value/max)*C` then `C`.
  (r=27 → C≈169.6; 63% → ~107, not 170.)
- Never round a displayed number in a direction that flatters (e.g. don't show "100%" at 99.6).
- A loading/empty/error state must say which it is — never an ambiguous spinner standing in
  for an error.

## Shard identity badge

The persistent mark that says *which shard, whose shard*. Lives in the menu/nav bar and
must also stand alone as a sticker/print. It is the identity mark, not a panel — so it is
the one element granted a distinct frame treatment (everything else obeys the plain
component rules).

**Decided:**

- **Content = brand diamond + 6-digit id, nothing else.** The crystal logomark
  (`Shard_logomark_color.png`, the single-diamond mark — *not* the full logomark with
  satellite shards) + the short shard id (`identity.id`, first 6 hex chars) in IBM Plex Mono.
- **No avatar, no name, no domain** — the avatar is mutable and names/domains add clutter;
  the id is the stable, verifiable anchor.
- **No copy button / no interactive chrome.** The badge must render identically in-app and
  as a sticker, so nothing interactive is baked into the visual.
- **Low height** (~28–30px) to sit in a menu bar; self-contained and liftable.

**Undecided — frame treatment (pick later).** Candidates still live:

1. **Corner brackets** — flat HUD-style registration marks, no full border.
2. **Double hairline** — flat concentric rules, certificate/stamp edge.
3. **Variable-thickness perimeter fingerprint** (below) — front-runner exploration.

Rejected: pill (reads as a button), single notch (too subtle), stamped/embossed and
inset/debossed (both require drop/inner shadows → break the no-shadow rule).

**Possible option — hash fingerprint via a variable-width border (stashed, NOT yet chosen):**

Revival of the parked hash-fingerprint idea, refined into a form that fits the style. No
separate outer line; the variable-thickness border *is* the whole frame. Algorithm,
deterministic from the shard hash:

1. Start thick or thin — 1 bit from the hash.
2. Generate 5–10 switch positions ∈ `[0,1]` around the perimeter — count and values from a
   PRNG seeded by the hash.
3. Thickness flips at each switch. Continuous border, corners flow through, runs are
   random-length. Two weights only (≈1.2px thin / ≈3.2px thick at 28px height).

Outer edge stays a clean rounded-rect silhouette; the **inner** edge wobbles, thickness
growing inward. Render as an even-odd ring (a duplicate seam point caused a self-crossing
spike — fixed by sampling the perimeter without repeating the endpoint). Because the border
*encodes* the id, it satisfies the honesty rule (the visual means something) and gives
at-a-glance recognizability + anti-spoofing. A bottom-underline-only variant was explored
and dropped.

## Deferred (not in this spec — later rounds)

## Parked ideas (revisit later, not now)

- **Earlier hash-fingerprint forms (rejected).** Before the variable-width border above, two
  forms were tried and shelved 2026-05-30: (a) an abstract generated glyph
  (segment-ring / dot-matrix / constellation), and (b) recoloring the four facets of the
  brand diamond from the hash (brand-locked or wide-gamut palette). Neither felt right;
  superseded by the variable-border exploration in the badge section.

## BFL mood/concept prompts

Purpose: mood/concept imagery for aligning the team and stakeholders on the *feel* — NOT
pixel-accurate UI (Flux won't render real UI text legibly). Generate text-free.

**Generator:** Black Forest Labs Playground (<https://playground.bfl.ai>), model
**Flux 1.1 Pro Ultra**, **raw mode on**, **16:9**, random seed first then lock the winner.
(Same setup as [[visual-style]].)

**No negative prompts.** Flux has no negative-prompt field and ignores "no X" phrasing
(may even add the excluded thing). Describe what you *want* instead: "matte flat surfaces,
even daylight" not "no glow"; "muted natural color" not "no neon". Text suppression is
unreliable — aim for "blank unmarked panels" and cull gens with stray lettering.

All phrased positively (Flux ignores exclusions). Surfaces described as matte/flat and
unmarked to discourage glow and stray text.

Nordic lean: the *imagery* sits in bright Scandinavian interiors with pale wood and natural
light — but the on-screen interface in the image stays flat and untextured (matte panels,
hairlines, solid fills), matching the real UI. Wood/textile belong to the *room*, not the
*screen*.

### Prompt 1 — the interface, hero concept
> A clean personal-cloud dashboard interface rendered as a calm everyday object in a bright
> Scandinavian interior, soft Nordic daylight. Warm off-white paper-toned background,
> ultra-thin deep-teal hairline strokes, rounded rectangular panels with crisp 1px borders,
> matte flat untextured surfaces, generous empty space. A thin precise teal arc gauge, a few
> minimal app tiles with simple outlined glyph icons, one small muted-amber accent element.
> Quiet, honest, unpretentious, lagom, muted natural color. Blank unmarked flat panels.
> IKEA-catalogue product-photography clarity, democratic design.

### Prompt 2 — "belongs in the natural world" mood
> A thin matte tablet showing minimal deep-teal hairline interface elements on a flat
> non-glowing untextured screen, resting on a pale birch-wood table beside a green plant in
> a bright Scandinavian room, soft morning daylight, white walls. The interface feels like a
> natural calm part of the home. Warm neutral palette, deep-teal thin lines, one small
> muted-amber detail, lots of air, muted natural color. IKEA-catalogue product photography,
> serene, honest, unpretentious, blank unmarked flat screen.

### Prompt 3 — line/precision language study
> Abstract close-up of an ultra-minimal Scandinavian-functionalist user-interface aesthetic:
> thin deep-teal hairlines, a single precise arc encoding a value, rounded-rectangle flat
> untextured panels with crisp 1px borders on a warm paper background, one muted-amber accent
> stroke, vast calm empty space, even soft Nordic daylight. Functional, honest, unpretentious,
> lagom, plain blank flat panels. Design-system mood board, democratic design.
## Related

In this folder (see [`README.md`](README.md) for the full map):

- [`tokens/`](tokens/) — exact values for agents to apply (`tokens.json`, `tokens.css`, `components.css`)
- [`DECISIONS.md`](DECISIONS.md) — why the style is the way it is; rejected & parked ideas
- [`design-guide.pdf`](design-guide.pdf) — this guide rendered visually
- [`build/build_guide.py`](build/build_guide.py) — regenerates the rendered guide

Vault:

- [[visual-style]] — blog cover illustration style (shares palette only)
- [[project-overview]]
