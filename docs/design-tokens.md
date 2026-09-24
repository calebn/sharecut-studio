# Design tokens — naming system

How we name CSS custom properties in Sharecut Studio, so a new contributor can
tell where a token lives, what it's for, and whether they may mint a new one.

Research basis (naming conventions only — we don't use Figma; the Figma
pipeline notes in these sources don't apply to us):

- John "Ojanti" Itebu, "Color token naming: what works, what fails & the best
  approach for your design system" (Design Systems Collective, Feb 2025) —
  https://www.designsystemscollective.com/color-token-naming-what-works-what-fails-the-best-approach-for-your-design-system-50f844d25f01
- Adobe Spectrum on semantic color naming; Shopify Polaris
  element/role/prominence/state pattern; GitHub Primer's five-part convention;
  Salesforce Lightning's semantic styling hooks — surveyed for the patterns
  below, not copied wholesale. Itebu's warning stands: don't blindly copy a
  big-company system; this system is sized for a small team, two themes
  (light/dark), CSS custom properties, no design-tool pipeline.

## The three tiers

| Tier | Names look like | Lives in | Rule |
| ---- | --------------- | -------- | ---- |
| **1 · Primitive** | `--primitive-amber-400` | `gui/web/src/styles/theme/primitives.css` | Raw literals only. Never `var()`. Never consumed directly by components — only by tier 2. |
| **2 · Semantic** | `--color-text-primary` | `theme-dark.css` / `theme-light.css` (same names, per-theme values) | Roles, not appearances. This is where theming lives: the token name never contains the theme (`--color-warning`, not `--color-warning-dark`). |
| **3 · Component** | `--timeline-playhead-width` | Component CSS, sparingly | Only when a value is truly component-local *and* themeable. Prefer tier 2. |

Shared brand colors are the exception: `deploy/brand/brand-tokens.css` is both
primitive and semantic for brand values, and must stay self-contained — its
copies ship to splash/relay static contexts that never load `primitives.css`.
Studio primitives may restate a brand hex (marked `twin:` in the source);
do not "fix" this by cross-referencing.

Tier discipline is enforced by `tests/test_css_policy.py`
(`test_primitives_are_raw_values`, `test_theme_files_use_primitives_not_raw_hex`).

## Naming patterns

Dot-notation thinking, kebab-case in CSS: `color.text.primary` →
`--color-text-primary`. Segments go **category → element/role → prominence →
state**, most significant first.

**Color** — `--color-<category>-<role>[-<modifier>]`

- Categories: `bg`, `text`, `border`, `accent`, `selection`, `warning`,
  `danger`, `success`, plus domain families (`clip-*`, `presence-*`,
  `marker`, `waveform-*`, `envelope-*`).
- Prominence modifiers: `-subtle`, `-muted`, `-strong`, `-solid`, `-emphasis`
  (established set — don't invent new ones; pick the nearest).
- State modifiers as suffixes, at the **semantic** tier, from day one:
  `-hover`, `-active`, `-disabled`, `-focus`.
- Contrast pairs use `on-*`: `--color-accent-on-solid` is the pattern
  (cf. Material's `on-primary`). Any new solid/filled token needs its `on-*`
  twin, with a documented contrast target (≥4.5:1, noted in a comment).

**Space** — `--space-<step>` (`--space-0…--space-6`). Chrome geometry that
repeats becomes a layout token (`--header-width`); one-off element sizes stay
literals. Never force layout geometry (`width`, `min-height`) onto `--space-*`.

**Type** — `--font-size-<role>` (`--font-size-ui`, `--font-size-body`, …),
`--font-family-<role>`. `line-height` stays a unitless literal;
`font-weight` stays numeric — small closed sets, not theme values.

**Radius** — `--radius-<size>` (`xs`/`sm`/`md`/`lg`/`xl`).

**Elevation** — `--shadow-<role>`, `--z-<role>` (`--z-sheet`, `--z-playhead`).

**Motion** — `--motion-hover` (150ms), `--motion-toggle` (200ms),
`--motion-panel` (300ms), and `--motion-state` (400ms) with
`--motion-ease-out`. Animate only inside `prefers-reduced-motion: no-preference`;
essential state changes remain immediate with reduced motion.

## Surface ladder

Backgrounds stack in five named rungs — a fixed semantic ladder, not an open
numbered scale. The ladder lives at the **semantic** tier
(`--color-bg-<rung>`, both theme values in the theme files), following the
category-first pattern (`bg` category, rung as role).

| Rung | Token | Used for |
| ---- | ----- | -------- |
| **canvas** | `--color-bg-canvas` | App background; the bottom of the stack. |
| **base** | `--color-bg-base` | Panes, chrome, sidebars. (Replaces the old `--color-bg-surface` name — "surface" describes every rung, so it can't name one.) |
| **raised** | `--color-bg-raised` | Cards, panels, lanes that sit above base. (Replaces `--color-bg-elevated`.) |
| **overlay** | `--color-bg-overlay` | Menus, dialogs, popovers, toasts, bottom sheets — anything floating above the app. |
| **sunken** | `--color-bg-sunken` | Recessed wells, inputs, code blocks — visually *below* base. |

The #20 polish pass implements this ladder alongside the older shared brand
names. The timeline has separate `--color-timeline-*` roles: its dark well,
lane, border, text, waveform gradient, and playhead stay dark in both app
themes, while the surrounding chrome follows the selected theme. Raised,
floating, and modal objects use `--shadow-raised`, `--shadow-floating`, and
`--shadow-modal`; the modal panel also uses restrained backdrop blur.

The palette follows the DAW UX briefing: warm paper canvas and near-white
surfaces in light mode; graphite layers in dark mode; orange for actions and
teal for positive signals and dialogue. The light decorative orange
`#df4b28` is too light for small white button text, so filled controls use
`#c33b1f` with `#fff9f5` (at least 4.5:1). `--color-accent-fg` uses a darker
orange for small text on light surfaces. `tests/test_brand_color_roles.py`
checks the contrast pairs. Studio bundles IBM Plex Sans and IBM Plex Mono
locally; timecodes and numeric inspector values use the mono family and
tabular numerals. The existing display serif remains limited to prominent
titles.

Use `--accent-fg` for small accent text, including links and status labels;
`--accent` remains available for non-text decoration and focus rings. Shared
empty-state chrome lives in `.ui-empty-state`. The live playhead position comes
from the transport animation frame and changes immediately for seeks; CSS
motion applies to controls and panels, not that time coordinate.

Research basis (surface conventions only): Material Design 3's tonal surface
scale (`surface-dim` → containers → `surface-bright`, elevation as tone
shifts, not shadows); Radix's `*-aN` alpha steps that composite over any
parent; GitHub Primer / Windows Fluent's hairline-contour separation. The
industry consensus is a small fixed ladder of semantic roles backed by tonal
ramps — which is what this is.

**Stacking rules:**

1. **Named layers use absolute rungs.** A dialog is `--color-bg-overlay` no
   matter what its parent is. Never derive a layer's rung from its parent —
   the mapping is deterministic.
2. **Contextual nesting uses relative tints, not new tokens.** Card-in-card,
   hover washes, and selected rows derive from the rung beneath them with
   `color-mix(in oklch, …)` alpha tints — never hand-picked per-parent hexes.
   Example: `color-mix(in oklch, var(--color-bg-raised) 88%, white)` for a
   nested card. If a nesting pattern repeats, it becomes one named semantic
   token with both theme values — not a one-off `style`.
3. **Stacking reads via hairlines, not tint alone.** Layer boundaries get a
   1px `--color-border-subtle` contour (Primer/Fluent school). Tint steps
   compress in dark mode; borders don't.
4. **Every rung gets an `on-*` text partner.** `--color-text-on-raised`,
   etc., each documented with its contrast target (≥4.5:1 WCAG 2.2 AA —
   still the certifiable gate; APCA as design compass). The CSS-policy test
   should compute these ratios, not just assert the comments exist.

**What we have today (migration):** the pre-ladder names
`--color-bg-canvas`, `--color-bg-surface`, `--color-bg-lane`,
`--color-bg-lane-muted`, `--color-bg-elevated` (plus `--bg-app`/`--bg-panel`/
`--bg-elevated` aliases) are grandfathered per the clause below. When a
component is touched, remap: canvas → canvas, surface → base, elevated →
raised, and give floating UI the overlay rung it was missing (most dialogs
currently sit on raised/base with only a shadow). Domain-specific lanes
(`--color-bg-lane`, `--color-bg-lane-muted`) become `--color-bg-raised` /
`--color-bg-sunken` unless they're genuinely domain values, in which case
they get a `clip-*`/`lane-*` domain family name.

**Not this:** user-created themes remain future work (parked 2026-09-21).
The ladder needs no new theme machinery — another `[data-theme="…"]` block
re-points the same five rungs when that day comes.

## Do / don't

- ✅ `--color-warning-surface` — category, role, prominence; themeable.
- ✅ `--primitive-teal-400` — raw value, ordinal step, nobody consumes it directly.
- ❌ `--color-accent-1` — generic; *which* accent? Fails the newcomer test.
- ❌ `--button-primary-background-color-light-theme` — hyper-specific,
  non-reusable chain; theme goes in the value, not the name.
- ❌ `--color-warning-dark` — theme duplication; one token, two themed values.
- ❌ `--modal-overlay-bg` next to `--color-scrim` — functional redundancy;
  reuse `--color-scrim`.
- ❌ `color: var(--primitive-red-400)` in a component — primitives are
  off-limits to product code; go through a semantic role.

## Minting a new token

Every candidate must pass two tests (from the research):

1. **Can a newcomer tell where it's used?** If not, the name is wrong.
2. **Will it need a twin next month?** If yes, it's too specific — lift it a tier.

And the repo's standing rules (`.agents/rules/gui-styling.md`):

- If a themed value is missing, **add a token** — never hardcode color, space,
  type, or radius in partials or `style={{…}}`.
- **Snap to the nearest existing step** rather than minting a 1–4px rung.
- A new primitive needs a family and an ordinal step; a new semantic role
  needs both theme values; a new `solid` needs its `on-*` twin.

Grandfather clause: existing names that predate this system
(`--color-clip-dialogue-0`, `--bg-panel` aliases, `--color-overlay-white-*`
using black in the light theme) stay until their component is touched — then
rename to the system. Don't do drive-by renames across the codebase.

## Changelog

- 2026-09-21 — System established; primitive tier extracted
  (`primitives.css`, 70 values); `theme-dark.css`/`theme-light.css` rewired to
  reference primitives (all 154 tokens verified value-identical, zero visual
  change); tier checks added to `tests/test_css_policy.py`.
- 2026-09-21 — Surface ladder specced: five semantic rungs
  (`canvas/base/raised/overlay/sunken`) with stacking rules (absolute rungs
  for named layers, `color-mix()` relative tints for nesting, hairline
  contours, `on-*` contrast pairs). Implementation (renames, `on-*` partners,
  computed contrast test) is follow-up work; legacy `--color-bg-*` names
  grandfathered.
