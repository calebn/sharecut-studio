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
| **2 · Semantic (fixed)** | `--color-transport-text` | `theme-fixed.css` | Roles that stay the same in both themes (the fixed-dark transport strip and the phone Listen card). Same rules as tier 2; its warning, ok and text inks restate dark-theme values on purpose, so retune both together. |
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
  `marker`, `waveform-*`, `envelope-*`). Recording clipping uses the danger family: `--clipping-marker` (marker-lane flag and the clip tint's top and bottom edges) aliases `--color-danger`; the clip tint (`--clipping-tint`) is `--clipping-hatch` (opaque danger 45deg stripes, defined in `tokens.css`) over `--clipping-region` (per-theme `--color-clipping-region`, danger at 45% dark / 40% light). An alpha tint alone blends toward grey over the teal dialogue fill, so the opaque hatch and edges carry the red.
- Prominence modifiers: `-subtle`, `-muted`, `-strong`, `-solid`, `-emphasis`
  (established set — don't invent new ones; pick the nearest).
- State modifiers as suffixes, at the **semantic** tier, from day one:
  `-hover`, `-active`, `-disabled`, `-focus`.
- Contrast pairs use `on-*`: `--color-accent-on-solid` is the pattern
  (cf. Material's `on-primary`). Any new solid/filled token needs its `on-*`
  twin, with a documented contrast target (≥4.5:1, noted in a comment).

**Space** — `--space-<step>` (`--space-0…--space-6`) on a 4px rhythm: 2, 4, 8, 12, 16, and 24px. The legacy `--space-2` / `--space-05` / `--space-45` names are gone (they duplicated space-3/4/5); use `--space-0/1/3/4/5/6`. Chrome geometry that
repeats becomes a layout token (`--header-width`); one-off element sizes stay
literals. Never force layout geometry (`width`, `min-height`) onto `--space-*`.

**Type** — `--font-size-<role>` (`--font-size-ui`, `--font-size-body`, …),
`--font-family-<role>`. `line-height` stays a unitless literal;
`font-weight` stays numeric — small closed sets, not theme values.

**Radius** — `--radius-<size>` (`xs`/`sm`/`md`/`lg`/`xl`).

**Elevation** — `--shadow-<role>`, `--z-<role>` (`--z-sheet`, `--z-playhead`).

**Motion** — `--motion-press` (80ms), `--motion-hover` (150ms),
`--motion-toggle` (200ms), `--motion-panel` (200ms), and `--motion-state`
(250ms) with `--motion-ease-out`. Pro-tool chrome stays quick. Only three
status indicators loop, each on its own slower period: `--motion-loop-pipeline`
(1.2s, a running pipeline), `--motion-loop-skeleton` (1.6s, loading lanes),
and `--motion-loop-rec` (1.8s, the REC dot). With reduced motion nothing
loops, and essential state changes are immediate.

| Token | Used for |
| --- | --- |
| `--motion-press` | Press-in on standalone `.ui-control`s (a 1px sink and 0.98 scale) and on Play, in the transport and on Listen (0.96). Menu rows (in a menu panel or not), segments and phone nav tabs keep a color-only press: a row that wide, or controls sharing an edge, would move their hit edge under the pointer. Release eases back on `--motion-toggle`. |
| `--motion-hover` | Hover and color washes; menus dropping 0.25rem from their trigger (`drop-in`); comment-card swipe; stale highlights; edit-boundary chips. |
| `--motion-toggle` | Control and track-row transforms; phone nav tab color; the pipeline progress bar. |
| `--motion-panel` | Dialog panels rising in (`fade-in` with `rise-in`); dialog and bottom-sheet scrims fading in (`fade-in`); bottom sheets; undo toasts rising 0.5rem (`rise-in`); focus-pull out. |
| `--motion-state` | Play's playing glow; track-row and empty-stage shadows; the ruler glow; focus-pull in. |
| `--motion-loop-*` | The pipeline pulse, the loading shimmer, and the REC dot. |

The shared entrances (`fade-in`, `rise-in`, `drop-in`) live in `ui.css`, and
each component opts in beside its own rules. Menus and toasts animate
transform only, so their text never renders half-faded (axe and pointer tests
measure them as they open; tests that measure their geometry wait for the
entrance to finish, `e2e/motion.ts`). Every transition and animation in a
partial, loops included, times with a `--motion-*` token and sits inside
exactly `@media (prefers-reduced-motion: no-preference)`; anywhere else,
`reduce` blocks included, motion may only stop (`none`, not `0s`). Stylelint
rejects any literal time on `transition*` and `animation*`, vendor-prefixed or
not (`declaration-property-unit-disallowed-list`), and
`tests/test_css_policy.py` checks both rules. FocusPull's timers
(`FOCUS_PULL_EXIT_MS`, `FOCUS_PULL_ENTER_MS`) mirror `--motion-panel` and
`--motion-state`, and a Vitest parity test keeps them equal.

## Surface ladder

Backgrounds stack in five named rungs — a fixed semantic ladder, not an open
numbered scale. The ladder lives at the **semantic** tier
(`--color-bg-<rung>`, both theme values in the theme files), following the
category-first pattern (`bg` category, rung as role).

| Rung | Token | Used for |
| ---- | ----- | -------- |
| **canvas** | `--color-bg-canvas` | App background; the bottom of the stack. |
| **base** | `--color-bg-base` | Panes, chrome, sidebars: track headers, bottom panel, tool rail. (Studio name for the shared `--color-bg-surface`.) |
| **raised** | `--color-bg-raised` | Inspector, cards, and badges that sit above base. (Studio name for the shared `--color-bg-elevated`.) |
| **overlay** | `--color-bg-overlay` | Menus, dialogs, popovers, toasts, bottom sheets — anything floating above the app. |
| **sunken** | `--color-bg-sunken` | Recessed wells, inputs, code blocks — visually *below* base. |

Every rung has a contrast partner, `--color-text-on-<rung>`, held at ≥4.5:1
(`tests/test_brand_color_roles.py` resolves the chains and checks each pair,
plus sunken < base and overlay ≥ raised). Studio stylesheets consume the rungs
directly; the old `--bg-app`, `--bg-panel`, `--bg-elevated`, `--bg-lane`, and
`--bg` aliases are gone (#135). The shared brand names (`--color-bg-surface`,
`--color-bg-elevated`) stay in `brand-tokens.css` because marketing, relay, and
splash pages use them without the Studio ladder.

Two roles sit beside the ladder:

- `--color-field` — form fields. White with a strong border in light mode;
  recessed below the pane in dark mode. `base.css` applies it (and the Plex
  sans family) to every input, select, and textarea at zero specificity.
- `--color-chip-selected` / `--color-chip-selected-fg` — the one selected
  state for toggles, segments, tabs, and selected rows: a neutral chip with
  full-strength text. Selection never uses the accent. `.ui-control`'s base
  pressed rule paints it (with a `--color-text-secondary` border), so
  components never restate it; checked menu radios add a check mark. One
  documented exception: the phone tab bar (`.mobile-nav`) marks the current
  location with an accent top indicator and accent label, following the iOS
  and Android tab-bar convention; it is navigation, not a selected value.
- `--color-hover` — the hover wash: a faint `--color-text-primary` tint that
  reads on every rung. Hover is a wash and selected is a chip, so a hovered
  control never looks selected.

**Palette.** One warm stone neutral ramp serves both themes (`primitives.css`,
ordered dark → light); a separate warm-charcoal ramp (`--primitive-warm-*`)
serves only the fixed-dark transport (`theme-fixed.css`). Light mode is paper and white panes with warm near-black
ink; dark mode is warm stone, never a cool reskin of light. Orange belongs to
Play, the playhead, and one primary action per context; teal marks positive
signals and dialogue. The light decorative orange `#df4b28` is too light for
small white button text, so filled controls use `#c33b1f` with `#fff9f5`
(at least 4.5:1); `--color-accent-fg` uses a darker orange for small text on
light surfaces. Danger is crimson (`--primitive-red-650` light,
`--primitive-red-350` dark), at least 20° of hue from the accent so a primary
button never reads as destructive. The modal scrim is black in both themes.
Studio bundles IBM Plex Sans and IBM Plex Mono locally; timecodes and numeric
inspector values use the mono family and tabular numerals. Dialog titles use
Plex Sans; the display serif is limited to cover-layout headings. The static
relay, splash, and marketing copies of `brand-tokens.css` name IBM Plex first
and fall back to the system UI font where Plex is not installed.

**Stage.** `--color-timeline-*` roles paint the track area. Light mode uses a
light stage: the well one recessed step below the panes and lanes near paper,
so clips carry the color and each track header reads as one row with its lane.
Dark mode keeps the stage darkest with lanes one step up. The playhead is the
accent in each theme. Waveforms take their tints from each clip's own fill
(`clipWaveformFill`), mirrored around the midline. The empty-session stage
keeps a decorative grid; lanes do not, because a grid that ignores the ruler
reads as false time divisions. The lane floor falls off toward the well's
inline edges (#387): two 1.5rem `.timeline-edge` strips
(`--bg-timeline-edge-start` and `-end`, from `--color-timeline-edge`), from
below the ruler and inside the header column and the classic scrollbars,
which TimelineView measures. The wash is black, 24% in the dark theme and 6%
in the light (`tests/test_brand_color_roles.py` caps it at 24% and 8%). The
strips sit at `--z-timeline-edge` (0), the lane floor's own level, where tree
order decides what paints on top, so TimelineView renders them after the
scroller: they darken the lane rows and the marker lane, and clips and
markers (`--z-clip`) paint over them and keep their contrast. Non-text lane
outlines, such as a drop target or a blade target, dim faintly at the edges.
`tests/test_css_policy.py`, the TimelineView tests, and an e2e pixel check
in `design-polish.spec.ts` hold this. Forced colors hide the strips. They are
not `--color-timeline-vignette`, the empty stage's inset hover shadow
(transparent in the light theme).

**Transport.** The transport is fixed dark in both themes (`--color-transport-*`,
`--bg-transport`, `--shadow-transport-*`). Play is the only orange control and
glows only while playing (static, never pulsing); selected audition segments
and tools use `--color-transport-chip` with full-strength text. Transport status
pills use their own light-on-dark warning and success inks.

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

**Migration status (#135): done.** Components read the five rungs directly.
The shared brand names `--color-bg-canvas` / `--color-bg-surface` /
`--color-bg-elevated` stay in `brand-tokens.css` (marketing, relay and splash
use them) and the Studio ladder maps onto them; the `--bg-app` / `--bg-panel`
/ `--bg-elevated` / `--bg-lane` aliases and `--color-bg-lane*` are gone, and
lanes use the timeline stage roles (`--color-timeline-*`).

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
