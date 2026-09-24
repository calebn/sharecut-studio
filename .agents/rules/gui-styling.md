# GUI styling

Sharecut Studio chrome and reading surfaces use **theme tokens**, **rem**, and **named `@container` queries**. The timeline mixer is **not** maximally intrinsic — keep a Reaper-style grid with sticky headers beside the time reel.

Lint: Stylelint in `gui/web` (`meowtec/no-px`, `declaration-strict-value`, viewport-size `media-feature-name-disallowed-list`, `declaration-no-important`, `at-rule-disallowed-list: layer`, `font-size` 62.5% ban) plus `tests/test_css_policy.py`. Detail: [docs/contributing.md](../../docs/contributing.md) § Sharecut Studio frontend, [gui/web/README.md](../../gui/web/README.md) § Theme tokens, [ux/pages/brand.md](../../ux/pages/brand.md) § Units.

## Source of truth

| Token | Where |
| ----- | ----- |
| Shared type / space / brand color | `deploy/brand/brand-tokens.css` (synced to Studio theme + public dirs) |
| Primitive color values (raw literals, no `var()`) | `gui/web/src/styles/theme/primitives.css` |
| Studio density (`--space-*`, `--font-size-*`, `--radius-xs/sm/xl`, `--focus-ring-*`, `--z-*`) | `gui/web/src/styles/theme/tokens.css` |
| Light / dark functional colors (semantic roles mapped onto primitives) | `theme-dark.css` / `theme-light.css` |

Tier discipline: primitives are raw values; theme files reference primitives, never raw hex (`tests/test_css_policy.py` enforces both). `brand-tokens.css` is exempt — its copies ship to splash/relay static contexts that never load `primitives.css`, so it stays self-contained; Studio primitives may restate a brand hex (marked `twin:`) rather than cross-reference it. Full naming system: [docs/design-tokens.md](../../docs/design-tokens.md).

Partials, TSX `style={{…}}`, and marketing copies consume `var(--…)`. If a **themed** value is missing, **add a token** — do not hardcode padding, margin, gap, font-size, radius, or color. Snap to the nearest existing step rather than minting a 1–4px rung. Promote a reused a11y recipe (`--focus-ring-width` / `--focus-ring-offset`) so density tweaks cannot shrink focus rings.

Do **not** author CSS in Python strings. Relay/splash offline pages load `.css` files (`src/podcast_relay/static/offline.css`, splash `index.html`) that use `var(--…)`; hex stays in `brand-tokens.css`. `tests/test_css_policy.py` flags `color:#` / `background:#` in `src/**/*.py`.

Stylelint `declaration-strict-value` applies to Studio partials (`gui/web/src/styles/`, excluding `theme/`). `deploy/` / `ux/` / `docs-site` / relay static / splash are pytest-only for px, viewport `@media`, `!important`, `@layer`, and `62.5%` — marketing may keep raw rem/hex by design.

## Hairline allowlist (Stylelint ↔ pytest)

Keep these in lockstep. Do not invent a third engine.

| Exception | Stylelint (`gui/web/stylelint.config.js`) | Pytest (`tests/test_css_policy.py`) |
| --------- | ---------------------------------------- | ----------------------------------- |
| `1px` / `-1px` hairlines | `meowtec/no-px` `ignore: ["1px", "-1px"]` | `abs(float(px)) == 1` |
| Other `px` | `stylelint-disable` + `-- user-approved:` including rule `meowtec/no-px` | same rule ID must be in the disable on that line |

Theme files are Stylelint-ignored; pytest is the only theme/deploy/ux/docs-site enforcer.

## Token vs layout geometry

Lint **theme** properties (color, type, space, radius). Do **not** force `width` / `height` / `min-*` / `max-*` / `flex-basis` / `inline-size` / `block-size` onto `--space-*`. Those are element geometry: `%`, `auto`, `min-content`, `max-content`, `fit-content`, `100dvh`, `minmax()`, and one-off rem sizes are fine.

Promote a size to a **layout token** only when the same chrome dimension is reused (`--header-width`, `--inspector-width`, `--transport-height`, `--lane-height`). A single control’s `min-height: 1.5rem` tap target does not need a new token.

Other values lint should not swallow:

| Leave as literals / keywords | Why |
| --- | --- |
| `line-height` unitless (`1.2`, `1.4`) | Multiplier of font-size, not a spacing step ([DTCG typography](https://www.designtokens.org/TR/2025.10/format/#typography)) |
| `font-weight` (`400`/`500`/`600`/`700`) | Small closed set; not a color/space theme |
| `letter-spacing` in `em` | Relative to glyphs |
| `opacity` | Often a one-off fade; tokenize only if a named mute recipe repeats |
| `transition` / `duration` | Use `--motion-hover/toggle/panel/state` and `--motion-ease-out` for chrome; keep animation under `prefers-reduced-motion: no-preference` |
| `box-shadow` offsets | Shape, not inset; colors in the shadow still `var(--…)` |
| `z-index` | Prefer `--z-*` when stacking with the mixer; raw `0`/`auto` OK |
| Canvas `left` / `width` / `height` in TS | Time × zoom math, not chrome |

## Layout judgment (not a linter)

- Chrome and reading: wrap + `gap` (Every Layout) first. `@container` is the escape hatch when leftover-space wrap is not enough.
- Named containers: `container: app / size` on `.daw-shell`; `container: timeline / inline-size` on `.timeline-area`. Pane density (status chips, pipeline, header rail) follows those — not `window` width `@media`.
- Shell product breakpoints (phone / tablet / desktop) stay JS `useViewportClass` (`PHONE_MAX_PX` 767, `TABLET_MAX_PX` 1100) + `data-shell`. Do not duplicate that as CSS viewport-width queries.
- Do **not** make the DAW mixer a maximally intrinsic stack. Track headers stay `flex-wrap: nowrap` beside lanes.
- Capability media (`hover`, `pointer`, `prefers-*`) may stay `@media`.

## Units

- Type and chrome space: `rem` via tokens. Never `html { font-size: 62.5% }`.
- `1px` / `-1px` hairlines may stay `px`.
- Timeline canvas math stays CSS `px` (`--lane-height` and clip/overlay insets vs that token). Lane and marker-lane heights are live values from `useTimelineMetrics()` (defaults in `gui/web/src/utils/layout.ts`); `.timeline-area` sets the CSS vars. Inline `left` / `width` / `height` on canvas overlays may stay computed px — do not oxlint those.
- Box-shadow offsets may stay numeric; colors in shadows still use `var(--…)`.

## Consent-gated exceptions

Default is fix the code (or add a token). `!important` and `@layer` are useful sometimes — consider cascade first; they are **not** a hard forever-ban.

Allowed only with **explicit user approval** and:

```css
/* stylelint-disable-next-line RULE -- user-approved: reason */
```

Block form: `stylelint-disable RULE -- user-approved: reason` … `stylelint-enable RULE`.

Typical approved cases: canvas px, playhead half-width rem offset, short-viewport `@media (max-height: …)` for portaled sheets, list indent in `em` that tracks parent font-size, a documented `!important` / `@layer` after cascade review.

Do not add `stylelint-disable` / `oxlint-disable` / `biome-ignore` without that phrase and a real reason. Pytest does **not** strip comments when gating `!important` / `@layer`.
