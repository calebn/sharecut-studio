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

Paint and markup share one stack. **Chrome panes** (transport, headers, bottom tabs, inspector, status) sit on surface — lighter / “up.” The **timeline well** is recessed: `--color-bg-lane` is **darker** than surface in both themes so arranging and reading don’t share one flat slab. Elevated sheets are temporary objects above surface. Timeline `--z-*` is **paint order** on the mixer, not chrome elevation.

| Plane | Meaning | Markup | Token |
|-------|---------|--------|-------|
| Canvas | Place — the floor | `.cover`, `body` | `--color-bg-canvas` |
| Surface | Chrome panes / durable cards | `.box`, transport, tabs, inspector | `--color-bg-surface` |
| Elevated | Temporary object (form, coach, compose) | `.box.elevated` | `--color-bg-elevated` |
| Lane | Recessed work well (ruler → lanes / empty drop) | `.time-ruler`, `.marker-lane`, `.lane-row`, `.timeline-scroll` | `--color-bg-lane` |
| Accent | Act — do this | `.primary`, links, focus | `--color-accent*` |
| Function | State | `role="alert"`, `.badge`, danger / warning | `--color-danger` / `--color-warning` |

**Do not wrap identity in a box.** Wordmark + lede live on the canvas (or as the title of a sheet). Durable cards (product, platform list) are `.box`. Sheets that appear and go away are `.box.elevated`. One `.primary` act per view.

Light elevated is **above** surface (a plate in lamplight), never a darker well. Lane is the opposite: a recessed mixer pit **below** chrome panes in both themes.

## Color roles

Change hex in [`deploy/brand/brand-tokens.css`](https://github.com/calebn/sharecut-studio/blob/main/deploy/brand/brand-tokens.css), not in pages.

| Role | Use |
|------|-----|
| Canvas / surface / elevated | Linen paper (light) or smoked graphite (dark) — not icy SaaS gray, not brown cave, not `#000` / `#fff`. Copper is the only warm metal. |
| Ink / muted | Cream or ink; cooler muted for secondary copy so copper can pop |
| Accent | Copper (new penny) for links and focus |
| Accent solid | Brighter copper fill; light label ≥ **4.5:1** — not chocolate brown |
| Border strong | Plate edge on `.box` (≥ **3:1** vs the plate fill) |
| Danger / warning | Destructive vs attention only |

One accent for primary actions. Links use accent, **never** browser-default blue. Do not `@media` / `@container` to swap `font-family` or accent hue.

Light and dark are the same room with the lights up or down.

## Type

System UI or one grotesque. Optional serif on the **product wordmark** only. No display font of the year. No pill radii (`border-radius: 999px`) on marketing.

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
| Hover | Fine pointer only | Lighten ink / strengthen border. `@media (hover: hover) and (pointer: fine)` so touch does not stick hover. **Never** the only cue that something is clickable |
| Focus-visible | Keyboard (and programmatic) focus | **2.4.7** Focus Visible. 2px `outline` in `--color-accent`, offset 2px. Use `:focus-visible`, not `:focus` |
| Active (while down) | Pointer down / Space on a button | Brief darker/stronger press. Works on touch |
| Pressed / selected / current | Sticky mode (Focus, Follow, Annotate, tab, Mix/FX/Raw, M/S) | Visible without hover: accent border + `--color-accent-muted` fill. Use `aria-pressed` / `aria-current` / `aria-expanded`, not color alone |
| Disabled | Cannot run | `cursor: not-allowed`; reduced opacity is an allowed WCAG exception. Prefer remaining enabled and explaining *why* when the user might try |
| Busy | In-flight | `aria-busy` + label change (Creating… / Downloading…). Keep the control focusable |
| Open | Menus, More, sheets | `aria-expanded`; panel is the confirmation |
| Error | Failed act | `role="alert"` + danger ink |

Accent = “you can act / you are acting.” Function colors stay mute/solo/stale/danger.

## Units

`rem` / `em` / `ch` for type and space. Chrome padding, margin, gap, font-size, radius, and color come from theme tokens (`--space-*`, `--s*` for modular type, `--font-size-*`, `--radius-*`). Layout geometry (`width` / `height` / flex-basis) may use rem literals — do not force those onto `--space-*`. `px` only for `1px` hairlines, timeline canvas math (`layout.ts` lane heights), and consent-gated sentinels. Do not set `html { font-size: 62.5% }`. Do not size type with `vw` alone.

Prefer layout that wraps from leftover space (`flex-wrap` + `gap` + `flex-basis`) over width breakpoints. Named `@container` (`app` on `.daw-shell`, `timeline` on `.timeline-area`) when leftover-space wrap is not enough; any fluid type still includes a rem term. Do not use viewport-size `@media` (`min/max-width/height`) for chrome density — shell phone/tablet/desktop stays JS `useViewportClass`. Capability media (`hover`, `pointer`, `prefers-*`) may stay `@media`.

## Images

`max-inline-size: 100%`. Screenshots keep aspect ratio (`object-fit: cover` in a ratio box). Never a forced `height` that squashes.

## Do / don’t

**Do** use tokens. **Do** keep light and dark as the same room. **Do** keep reading surfaces axe-clean **including color-contrast** (do not copy the dense-DAW Playwright exemptions).

**Don’t** use full-pill radii (`999px`, huge rem, or `9999px` without `-- user-approved:`), purple SaaS gradients, coral/maroon CTAs, or copper on the playhead. **Don’t** copy Descript or Riverside. **Don’t** apply 60ch inside the timeline. **Don’t** hardcode chrome padding/type/color — add a token or snap to the nearest step. **Don’t** use `!important` or CSS `@layer` unless cascade review plus a `stylelint-disable` with `-- user-approved:` (not a third theme file).

## How to add a page

Reuse `deploy/brand/brand-tokens.css` / `marketing.css` / `cover-layout.css` or Sharecut Studio tokens; add copy; do not fork a third palette or a page-specific Cover/Stack/Box sheet. Nest primitives (`box stack tight`). Mute card copy with `.note`, not `.lede`. If you need a new value, add a token first. Query tests by role and accessible name, not CSS class names.
