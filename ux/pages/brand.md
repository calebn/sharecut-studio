# Sharecut styling guidelines

Living checklist for product pages and Sharecut Studio chrome. Change **tokens**, not one-off hex. If a new surface would look like an unstyled system-ui column with default-blue links, it is out of guideline.

## Voice

Sharecut is a studio you would send a guest into: calm, listen-first, no “AI” chrome, no magic. **Sudo Science** (parent) may stay drier. Do not brand the dense editor as a landing page.

## Two rooms, one token family

| Room | Surfaces | Type |
|------|----------|------|
| Reading | sharecut.studio, `/download/`, sudo.science, HomeScreen, ReviewApp | Body ≥ `1rem`, line-height ~1.4–1.5 |
| Mixing | Sharecut Studio with a project open | `--font-size-ui` (~0.8125rem) |

Same `--color-*` roles in both rooms. Shared scale + brand colors live in [`deploy/brand/brand-tokens.css`](https://github.com/calebn/sharecut-studio/blob/main/deploy/brand/brand-tokens.css) (synced to Sharecut Studio `gui/web/src/styles/theme/`). Light/dark: `data-theme` on `<html>` wins, else OS `prefers-color-scheme` (`:root:not([data-theme])`). Sharecut Studio preference API is [`useTheme`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/hooks/useTheme.ts). Playhead and clip hues are **functional**, not brand paint.

Sharecut Studio tokens: [`gui/web/src/styles/theme/`](https://github.com/calebn/sharecut-studio/tree/main/gui/web/src/styles/theme). Marketing CSS: [`deploy/brand/marketing.css`](https://github.com/calebn/sharecut-studio/blob/main/deploy/brand/marketing.css). Shared Cover/Stack/Box layout: [`deploy/brand/cover-layout.css`](https://github.com/calebn/sharecut-studio/blob/main/deploy/brand/cover-layout.css) (synced to [`gui/web/src/styles/partials/cover-layout.css`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/src/styles/partials/cover-layout.css); imported by `reading.css`).

## Planes (information hierarchy)

Paint and markup share one stack. Sharecut Studio uses the five-rung ladder from [design tokens](https://github.com/calebn/sharecut-studio/blob/main/docs/design-tokens.md#surface-ladder): **canvas** frames the app (status bar), **base** holds the panes (track headers, bottom panel), **raised** holds the inspector and cards, **overlay** holds menus, sheets, toasts, and dialogs, and **sunken** holds wells, meters, and code. The transport is a fixed dark focal strip in either theme. The stage (`--color-timeline-*`) is light in light mode, one recessed step below the panes so clips carry the color, and darkest in dark mode. In light mode, overlays lift with shadow and a dark scrim rather than a darker tint. Timeline `--z-*` is paint order on the mixer, not chrome elevation.

| Plane | Meaning | Markup | Token |
|-------|---------|--------|-------|
| Canvas | Place — the floor | `.cover`, `body` | `--color-bg-canvas` |
| Surface | Chrome panes / durable cards | `.box`, tabs, track headers | `--color-bg-surface` (Studio: `--color-bg-base`) |
| Elevated | Temporary object (form, coach, compose), inspector | `.box.elevated`, inspector | `--color-bg-elevated` (Studio: `--color-bg-raised`, `--color-bg-overlay`) |
| Stage | Recessed work well (ruler → lanes / empty drop) | `.time-ruler`, `.marker-lane`, `.lane-row`, `.timeline-scroll` | `--color-timeline-*` |
| Accent | Act — do this | `.primary`, links, focus | `--color-accent*` |
| Function | State | `role="alert"`, `.badge`, danger / warning | `--color-danger` / `--color-warning` |

**Do not wrap identity in a box.** Wordmark + lede live on the canvas (or as the title of a sheet). Durable cards (product, platform list) are `.box`. Sheets that appear and go away are `.box.elevated`. One `.primary` act per view.

Light elevated is **above** surface (a plate in lamplight), never a darker well. Lane is the opposite: a recessed mixer pit **below** chrome panes in both themes.

## Color roles

Change hex in [`deploy/brand/brand-tokens.css`](https://github.com/calebn/sharecut-studio/blob/main/deploy/brand/brand-tokens.css), not in pages.

| Role | Use |
|------|-----|
| Canvas / surface / elevated | Linen paper and white panes (light) or warm stone (dark) — not icy SaaS gray, not brown cave, not `#000`. One warm neutral ramp serves both themes. Copper is the only warm metal. |
| Ink / muted | Cream or ink; cooler muted for secondary copy so copper can pop |
| Accent | Copper (new penny) for links and focus |
| Accent solid | Button fill with on-color text ≥ **4.5:1**; light mode uses a darker variant of the decorative orange |
| Border strong | Plate edge on `.box` (≥ **3:1** vs the plate fill) |
| Danger / warning | Destructive vs attention only. Danger is crimson, at least 20° of hue from the accent, so a primary button never reads as destructive |

One accent for primary actions. Links use accent text (`--color-accent-text` on marketing, relay and splash pages; `--accent-fg` in Studio), both at least 4.5:1, **never** browser-default blue. Do not `@media` / `@container` to swap `font-family` or accent hue.

Light and dark are the same room with the lights up or down.

## Type

Studio bundles IBM Plex Sans for body, controls, form fields, and dialog titles, and IBM Plex Mono for labels and timecodes. Numeric readouts use tabular numerals. The display serif is reserved for cover-layout headings. No pill radii (`border-radius: 999px`) on marketing.

## Space and measure

Spacing from the scale: `--s0` = `1rem`, ratio 1.5 (`--s1`, `--s2`, …). No one-off `2.5rem` margins.

Reading lines cap at `--measure: 60ch` by default. Exceptions: wrappers (`html`, `body`, `div`, `header`, `nav`, `main`, `footer`) and the DAW mixer. Gutters from the scale, not viewport units.

## How a page is built

Layout classes are **arrangement**; plane classes are **what the thing is**:

| Layout | Plane it usually paints |
|--------|-------------------------|
| **Cover** | Canvas. Full-slot min height; principal in `.cover-center`; optional first/last header/footer |
| **Center** | Measure only — no fill |
| **Stack** | Rhythm between siblings |
| **Cluster** | Act row (`flex-wrap` + `gap`) |
| **Switcher** | Intrinsic wrap of equal-ish items (`flex-basis` threshold) |
| **Box** | Surface object; add `.elevated` when it is temporary |

Nest primitives instead of descendant layout: `.box.stack.tight` (inner rhythm via `--stack-space`), not margin on `.box h2`. `.box h2 { font-size }` is type, not layout. Card body mute is `.note`; `.lede` stays the identity lead. Sharecut Studio mixer chrome (timeline, transport grid) is not Cover/Stack — it stays in `layout.css` / `timeline.css`.

Typical reading page:

1. `.cover` — place
2. Cover `<header>` / `<footer>` — chrome on the floor (badge, parent company)
3. `<main class="cover-center">` → identity `<header class="stack">` (wordmark + lede)
4. `.cluster` → `.primary` — the act
5. `.box stack tight` or `.box.elevated stack` — objects / sheets (`.tight` for card rhythm)
6. `role="alert"` — function, not a third palette

Do not add a page-specific layout CSS file. Color and type stay on `:root`. Sibling gaps come from Stack/Cluster, not extra card padding. Buttons size to their **label**, not the full column.

## Components

One primary action per view (`Button variant="primary"` or `.primary`). Everything else secondary.

- Primary tap target ≥ `2.75rem` on marketing / home
- ≥ `1.5rem` everywhere else
- Loading and error use the same reading column, not a lone unstyled paragraph

## Mixing-room control states

Sharecut Studio chrome uses one paint primitive: **`.ui-control`** (see [`gui/web/docs/ui-library.md`](https://github.com/calebn/sharecut-studio/blob/main/gui/web/docs/ui-library.md)). Domain CSS may size padding; it must not invent a second hover/focus recipe. Timeline `--z-*` and canvas widgets (clips, fade handles, playhead) are **not** chrome states — do not copper the playhead.

| State | When it must show | How |
|-------|-------------------|-----|
| Rest | Always | Fill + border that already reads as a control (WCAG **1.4.11** non-text contrast ≥ **3:1** vs adjacent) |
| Hover | Fine pointer only | A faint ink wash (`--color-hover`) plus full-strength text / a stronger border. `@media (hover: hover) and (pointer: fine)` so touch does not stick hover. **Never** the only cue that something is clickable, and never the selected chip, so a hovered control does not look selected |
| Focus-visible | Keyboard (and programmatic) focus | **2.4.7** Focus Visible. 2px `outline` in `--color-accent`, offset 2px. Use `:focus-visible`, not `:focus` |
| Active (while down) | Pointer down / Space on a button | Brief darker/stronger press. Works on touch |
| Pressed / selected / current | Sticky mode (Focus, Follow, Annotate, tab, Mix/FX/Raw, Select/Blade, M/S) | Visible without hover: the neutral selected chip (`--color-chip-selected`) with a secondary-ink border; checked menu radios add a check mark. Never the accent, except the phone tab bar's current tab (accent top indicator, the iOS/Android convention for current location). Use `aria-pressed` / `aria-checked` / `aria-current` / `aria-expanded`, not color alone |
| Disabled | Cannot run | `cursor: not-allowed`; reduced opacity is an allowed WCAG exception. Prefer remaining enabled and explaining *why* when the user might try |
| Busy | In-flight | `aria-busy` + label change (Creating… / Downloading…). Keep the control focusable |
| Open | Menus, More, sheets | `aria-expanded`; panel is the confirmation |
| Error | Failed act | `role="alert"` + danger ink |

Accent identifies actions and focus; small links use the darker `--accent-fg` role (`--color-accent-text` on brand pages) for contrast, and running/queued badges use full-strength text on an accent tint. Function colors stay mute/solo/stale/danger. Primary controls use solid accent fill, default controls have transparent fill and a contour, and quiet toggles use text treatment. Orange belongs to the transport Play control, the playhead, and one primary action per view. Every selected toggle, segment, tab, and row uses the neutral selected chip (`--color-chip-selected`) with full-strength text. Track identity bars and waveform tints reuse lane clip colors. Empty lists and panels use the quiet `EmptyState` (muted text, no fill or border, so an empty list never reads as a disabled field); the empty timeline is a gridded drop stage. Reusable pieces (segmented control, pill, timecode, empty state, the transport frame) have Storybook entries, and `Atoms/SurfaceLadder` renders the palette from live tokens. Motion uses `--motion-*` timing under `prefers-reduced-motion: no-preference`: controls sink in fast on press and ease back, menus drop from their trigger, and dialogs rise over a scrim that fades in. Reduced-motion views change state immediately, and only status indicators loop (a running pipeline, loading lanes, the REC dot). The stage darkens faintly toward its edges (a black wash under the playhead). The playhead position follows the audio clock without a CSS transition, and the centered phone playhead uses `--color-timeline-playhead` on the stage.

## Units

`rem` / `em` / `ch` for type and space. Chrome padding, margin, gap, font-size, radius, and color come from theme tokens (`--space-*`, `--s*` for modular type, `--font-size-*`, `--radius-*`). Layout geometry (`width` / `height` / flex-basis) may use rem literals — do not force those onto `--space-*`. `px` only for `1px` hairlines, timeline canvas math (`layout.ts` lane heights), and consent-gated sentinels. Do not set `html { font-size: 62.5% }`. Do not size type with `vw` alone.

Prefer layout that wraps from leftover space (`flex-wrap` + `gap` + `flex-basis`) over width breakpoints. Named `@container` (`app` on `.daw-shell`, `timeline` on `.timeline-area`) when leftover-space wrap is not enough; any fluid type still includes a rem term. Do not use viewport-size `@media` (`min/max-width/height`) for chrome density — shell phone/tablet/desktop stays JS `useViewportClass`. Capability media (`hover`, `pointer`, `prefers-*`) may stay `@media`.

## Images

`max-inline-size: 100%`. Screenshots keep aspect ratio (`object-fit: cover` in a ratio box). Never a forced `height` that squashes.

## Do / don’t

**Do** use tokens. **Do** keep light and dark as the same room. **Do** keep reading surfaces axe-clean **including color-contrast** (do not copy the dense-DAW Playwright exemptions).

**Don’t** use full-pill radii (`999px`, huge rem, or `9999px` without `-- user-approved:`), loud gradients, or heavy glass effects. **Don’t** copy Descript or Riverside. **Don’t** apply 60ch inside the timeline. **Don’t** hardcode chrome padding/type/color — add a token or snap to the nearest step. **Don’t** use `!important` or CSS `@layer` unless cascade review plus a `stylelint-disable` with `-- user-approved:` (not a third theme file).

## How to add a page

Reuse `deploy/brand/brand-tokens.css` / `marketing.css` / `cover-layout.css` or Sharecut Studio tokens; add copy; do not fork a third palette or a page-specific Cover/Stack/Box sheet. Nest primitives (`box stack tight`). Mute card copy with `.note`, not `.lede`. If you need a new value, add a token first. Query tests by role and accessible name, not CSS class names.
