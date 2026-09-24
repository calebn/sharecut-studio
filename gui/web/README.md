# Sharecut Studio frontend (`gui/web`)

React + TypeScript + Vite UI for the podcast Sharecut Studio viewer and guest review app.

## Scripts

```bash
npm install
npm run dev         # Vite on :5173 (proxy /api → :8765)
npm run build
npm run storybook  # component catalog on :6006
npm run build-storybook  # static catalog under storybook-static/
npm run typecheck   # tsc -b (strict)
npm test            # vitest run (unit + component a11y)
npm run test:watch  # vitest watch mode
npm run test:e2e    # Playwright smoke (needs built dist + `podcast gui` / uv; isolated port and post-server fixture cleanup)
npm run lint        # oxlint (JS/TS + jsx-a11y + hygiene) + Stylelint (tokens, rem, no viewport-size @media; !important/@layer consent-gated)
npm run lint:css    # Stylelint only
npm run format      # Biome format + organize imports
npm run format:check
```

Repo root:

- `make test-web` — lint + format:check + typecheck + vitest + build (CI `frontend` job)
- `make test-web-e2e` — build + Playwright against `aligned_dialogue`, then the Chromium/WebKit compat matrix (CI `frontend-e2e` job)
- `npm run test:e2e:compat` — focused Chromium/WebKit compatibility matrix only (`npm run test:e2e:install` installs both engines)

Storybook uses the real `src/ui/` components and theme tokens. See
[`docs/design-system.md`](../../docs/design-system.md) for story conventions and
the GitHub Pages publishing setup. Pull requests build the catalog without
deploying it.

## Testing

| Kind | Where | Notes |
|------|-------|-------|
| Unit | `src/**/*.test.ts` | Pure utils, session dedupe, share mode, theme init/resolution |
| Component + a11y | `src/**/*.test.tsx` | React Testing Library + Deque `axe-core` via `expectNoA11yViolations` |
| E2E smoke + a11y | `e2e/*.spec.ts` | Playwright + `@axe-core/playwright` via shared `expectPageAxeClean` (dense DAW) or `expectReadingSurfaceAxeClean` (Home / marketing HTML; required for green CI) |
| Browser compatibility | `e2e-compat/*.spec.ts` | Small cross-browser matrix for the playback control, phone layout, and synthetic-media recording consent; runs Chromium and Playwright WebKit. Shared helpers: `e2e/recordRoom.ts` (record rooms, E2E flag, record links) and `e2e/syntheticMicrophone.ts` (oscillator mic stub). Set `E2E_BRANDED_CHROME=1` locally to also use installed Chrome. |
| Static a11y | oxlint `jsx-a11y` | Interaction + media rules are **errors** — fix the markup; do not add lint suppressions |
| TS hygiene | oxlint + `oxlint-tsgolint` (see `.oxlintrc.json`) | No explicit `any` / `@ts-*` escapes; `===`; `const`; no `var`; no `console` in `src/` (allowed in `scripts/`); type-aware promise + stringification hygiene (`options.typeAware`) |
| Theme tokens | Stylelint + pytest | Color, padding, margin, gap, font-size, radius outside `src/styles/theme/` must use `var(--…)`; hex only in theme files. Chrome rem (`meowtec/no-px`); canvas `px` needs `-- user-approved:`. Inline JS styles and Python-authored CSS colors: `tests/test_css_policy.py` |
| `!important` / `@layer` / viewport `@media` | Stylelint + pytest | Default-off; allowed only with `stylelint-disable` + `-- user-approved:`. `tests/test_css_policy.py` does **not** strip comments. `font-size: 62.5%` is a hard ban |
| Format | Biome | `format:check` in CI; commit hook runs lint-staged (`biome check --write` on staged files; `make hooks`). Biome linter is off (oxlint + Stylelint own lint) |

Vitest uses `jsdom` ([`vitest.config.ts`](vitest.config.ts)); setup lives in [`src/test/setup.ts`](src/test/setup.ts).

### Lint suppressions

Do **not** add `eslint-disable`, `oxlint-disable`, `biome-ignore`, or `stylelint-disable` without **explicit user approval**. Default is fix the code (or add a theme token). Stylelint exceptions must be `/* stylelint-disable-next-line RULE -- user-approved: reason */`. See [.agents/rules/gui-styling.md](../../.agents/rules/gui-styling.md).

### Adding an axe check

Component (Vitest):

```tsx
import { render } from "@testing-library/react";
import { expectNoA11yViolations } from "../test/a11y";
import { Button } from "./Button";

it("is axe-clean", async () => {
  const { container } = render(<Button>Save</Button>);
  await expectNoA11yViolations(container);
});
```

Full-page (Playwright): call `expectPageAxeClean(page)` from `e2e/axe.ts` after the dense DAW shell is visible. Reading surfaces (Home without `?project=`, static marketing HTML) use `expectReadingSurfaceAxeClean` so color-contrast and region stay on. Do not copy-paste `AxeBuilder` setup.

Store helpers for inspector/footer tests: `src/test/fixtures.ts` + `useDawStore.getState().hydrate(...)`. For typed recording models in new tests and stories, prefer `recordParticipant({ ... })` and `recordSnapshot({ ... })` from that file, overriding fields relevant to each scenario. Raw transport payloads can stay explicit.

## Theme tokens

Semantic CSS variables live under `src/styles/theme/`:

| File | Role |
|------|------|
| `brand-tokens.css` | Shared scale + brand `--color-*` (sync-copy from `deploy/brand/`; self-contained — see below) |
| `primitives.css` | **Primitive tier:** raw `--primitive-*` literals, theme-invariant; never `var()`, never consumed by components |
| `tokens.css` | Sharecut Studio-only scales (`--space-*`, `--font-size-*`, `--z-*`), layout dims, legacy aliases |
| `theme-dark.css` | **Semantic tier:** dark `--color-*` roles mapped onto primitives |
| `theme-light.css` | **Semantic tier:** light `--color-*` roles + `prefers-color-scheme` when no `data-theme` |
| `../theme.css` | Imports brand-tokens, primitives, then the three above |

Naming system (tiers, patterns, state modifiers, minting rules):
[docs/design-tokens.md](../../docs/design-tokens.md).

Root switching (same CSS contract as marketing):

- `document.documentElement.dataset.theme = "light" | "dark"` overrides OS
- No `data-theme` → follow `prefers-color-scheme` on `:root:not([data-theme])`
- Preference persisted in `localStorage` key `daw_theme` via `hooks/useTheme.ts`
- Transport bar cycles system → dark → light

### Adding a token

1. **Shared brand / scale:** edit `deploy/brand/brand-tokens.css`, copy to public dirs and `src/styles/theme/brand-tokens.css`.
2. **Sharecut Studio-only:** declare the name in `theme/tokens.css` (legacy alias only if migrating old `var(--…)` call sites). For a new **color**: add the raw value to `theme/primitives.css` (`--primitive-<family>-<step>`), then map it onto a `--color-*` semantic role in both `theme-dark.css` and `theme-light.css` using the same selectors as brand-tokens. Never put raw hex in the theme files; never consume `--primitive-*` directly from components. See [docs/design-tokens.md](../../docs/design-tokens.md).
3. Use `var(--…)` in partials / components — **never** invent one-off hex/`rgb` outside `src/styles/theme/`. Stylelint enforces this in CI.

Domain CSS is split into `@import` partials from `src/styles/daw.css` (`partials/layout.css`, `timeline.css`, `inspector.css`, `panels.css`, `review.css`, `bottom-sheet.css`, `responsive.css`).

## Responsive shells

See [`docs/gui-mobile.md`](../../docs/gui-mobile.md). Breakpoints: phone `<768`, tablet `768–1100`, desktop `>1100` (`hooks/useViewportClass.ts`). Phone uses `MobileShell` (Listen / Timeline / Text / More); tablet uses peek `BottomSheet` inspector; desktop keeps the Reaper grid with focus modes (`1`–`4`) and transport **More** overflow.

## UI library (`src/ui/`)

Sharecut Studio chrome library — see [`docs/ui-library.md`](docs/ui-library.md) for charter, command-bus bridge, and catalog. Domain folders (`inspector/`, `panels/`, `timeline/`) stay and **compose** the library.

| Export | Use for |
|--------|---------|
| `Button` | `default` / `primary` / `danger` / `link` |
| `ToggleButton` | Toolbars / mode strips (`aria-pressed` + `.active`) — not exclusive tab panels |
| `CommandButton` / `useCommand` | Pointer → `execute(commandId)` (default `skipWhen`) |
| `Menu` / `CommandMenuItem` | Popup menus (Escape, arrows, outside click) |
| `Dialog` / `useDialogModal` | Modal scrim+panel; trap + inert chrome |
| `BottomSheet` | Phone/tablet peek sheet (non-modal) |
| `Field` / `FieldRow` | Labeled control + hint; horizontal nudge row |
| `InlineError` | Non-pipeline error lines |
| `LoadingScreen` / `ErrorScreen` | App boot states |
| `DefinitionList` / `DefItem` | Inspector `<dl>` rows |
| `InspectorSeekFooter` | Seek + play-around footers |
| `FocusToggle` | Pane focus control |
| `LevelMeter` | Peak input meter (dBFS zones, peak hold, latching clip LED); drive it with `record/useInputPeakDb` (DSP in `audio/metering.ts`, loop in `audio/usePeakMeter.ts`). Not wired into the record UI yet (#174) |

Mutations: prefer `hooks/useProjectMutation()` (`busy` / `error` / `run` / `refresh`) over local try/catch boilerplate.

Comments: shared `src/comments/` (`CommentCard`, `CommentCompose`, `useCommentActions`).

## Layout constants

`utils/layout.ts` mirrors CSS layout dims (`--ruler-height`, `--marker-lane-height`, lane height). Keep them in sync when changing chrome geometry.
