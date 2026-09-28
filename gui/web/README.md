# Sharecut Studio frontend (`gui/web`)

React + TypeScript + Vite UI for the podcast Sharecut Studio viewer and guest review app.

## Scripts

```bash
npm install
npm run dev         # Vite on :5173 (proxy /api → :8765)
npm run build
npm run storybook  # component catalog on :6006
npm run build-storybook  # static catalog under storybook-static/
npm run typecheck   # tsc -b (strict; includes all e2e/ and e2e-compat/ files)
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
- `make test-web-e2e` — E2E-flagged build + Playwright against `aligned_dialogue`, then the Chromium/WebKit compat matrix (CI `frontend-e2e` job). Ordinary `npm run build` rejects emitted E2E hooks.
- `npm run test:e2e:compat` — focused Chromium/WebKit compatibility matrix only (`npm run test:e2e:install` installs both engines)

Storybook uses the real `src/ui/` components and theme tokens. See
[`docs/design-system.md`](../../docs/design-system.md) for story conventions and
the GitHub Pages publishing setup. Pull requests build the catalog without
deploying it.
The `Templates/TimelineRange` story shows the production audition and comment
selection overlays with the prop-only `PlayheadNeedle` in a 360px timeline
well. The live `Playhead` keeps the DAW store subscription and moves its needle
through a direct transform update during playback.
`Templates/TrackHeader` previews the production track gutter and mute/solo
controls with fictional track data, including stale and empty lanes, reorder
cues, and a 360px phone rail. The live adapters retain DAW state, drag
allowlisting, and command dispatch; stories pass props and action callbacks.
`Templates/TimeRuler` shows the same prop-driven ruler view used by the live
timeline at desktop and 360px widths, including comment-anchor mode. Its live
adapter supplies DAW position and visible chunks; the story supplies fixed
values and a production `PlayheadNeedle` without mounting DAW state.
`Templates/AppliedEditOverlay` previews the production applied-edit ticks in
the timeline lane with fictional visible, selected, dense, filtered and empty
records, including 360px variants. The ticks are decorative and cannot select
an edit; the live Impact panel owns selection.
`Templates/StaleInvalidationOverlay` previews the production stale-render
regions, including overlapping causes, minimum-width spans, right-edge clipping,
and filtered or empty 360px lanes. These bands are decorative; the live stale
status controls explain the render state.
`Templates/EnvelopeOverlay`, `Templates/PresenceOverlay`, and
`Templates/CommentPlaybackBubble` preview the shipped live-timeline overlays
as props-only views (`EnvelopeOverlayView`, `PresenceOverlayView`,
`CommentPlaybackBubbleView`); the live adapters keep the store, API and
timeline-metrics reads, including a fixed `nowMs` for presence instead of the
server clock. Each has a 360px story alongside its desktop ones, and a guard
test keeps the views themselves free of direct store/API imports.
`Templates/CommentCard`, `Templates/CommentCompose`, and
`Templates/GhostWordChips` show the shipped comment and transcript preview
components with fictional, local-only state, including 360px phone variants.
They do not mount the live comment panel.
`Templates/TranscriptTurn` uses the production `TranscriptTurnView` shared with
`TranscriptPanel` for mapped, selected, annotated, cut-away and 360px long-turn
examples. The panel retains DAW state, gestures, presence, and virtualization;
stories pass fixture props and local callbacks only.
`Templates/InspectorSeekFooter` shows the production `InspectorSeekFooterView`
shared by the modifier inspectors: seek and play actions, seek-only footers,
preview modes with a blocked-skip reason, and a 360px footer. The live
`InspectorSeekFooter` keeps the DAW store and audition wiring; stories pass
props and local callbacks.
`Templates/BottomTabsSplitter` shows the production `BottomTabsSplitterView`
separator with keyboard resize and a 360px band. The live `BottomTabsSplitter`
keeps the `useTabsHeight` preference (localStorage and the root
`--tabs-height`); stories use local state only.
`Templates/FollowBanner` and `Templates/GuestAttentionBanner` use the
production `FollowBannerView` and `GuestAttentionBannerView` shared with the
live `FollowBanner` and `GuestAttentionBanner` adapters, which keep the
roster/store lookups, IndexedDB polling, and share-vs-host token resolution.
Both stories share the `dawShellStoryDecorator` `.daw-shell` frame at desktop
and 360px widths.
`Templates/StatusBar`, `Templates/AvatarStack` and `Templates/OverlayLegend`
show the production `StatusBarView`, `AvatarStackView` and `OverlayLegendView`
used by the live `StatusBar`, `AvatarStack` and `OverlayLegend` adapters,
including the `PresenceStatusView` presence slot, desktop/phone/menu-hosted
variants, and stale-render, loading and overflow states built from the same
fixtures as the app.
`Templates/HostMcpDialog` and `Templates/GesturesSheet` show the shipped
agent-connection and mobile gesture dialogs. The MCP story passes a fixed
loopback URL so its preview is independent of Storybook's port; the live
dialog derives its local URL as before.
Standalone Canvas stories open their dialogs; autodocs examples start closed
with launchers so each can be inspected independently. The launcher and
play-helper live in `src/test/DialogLauncher.tsx` and `src/test/storyDialog.ts`.
The gesture callback closes its sheet and
hands off to the live shortcuts owner; the story does not render that owner.
`Templates/ToolModeToggle`, `Templates/EditingToolRail` and
`Templates/CommandPalette` show the production `ToolModeToggleView`,
`EditingToolRailView` and `CommandPaletteView`, each driven by a local-state
preview so clicking Select/Blade/Comment, confirming a blade cut, or
switching shortcut tabs and remap fields behaves like the live surface
without mounting the DAW store; the palette story uses fixed shortcut rows
rather than the live keymap registry, and `commandPaletteRows.test.ts` checks
them against the registry and catalog so the copy cannot drift; the live
`ToolModeToggle`, `EditingToolRail` and `CommandPalette` adapters keep reading
DAW state and dispatching through `execute`.

`Templates/ShareDialog` renders the production `ShareDialogView`, the same
view the live `ShareDialog` adapter renders. Stories use fictional
`hostShareRow` fixtures and local callbacks; the adapter keeps the API calls,
clipboard, `window.confirm` and the record-panel handoff.
`Templates/BounceDialog` renders `BounceDialogView`, the same view the live
`BounceDialog` adapter renders; the adapter keeps the bounce job start/follow
and DAW selection state.

`Organisms/LoadingScreen` and `Organisms/ErrorScreen` show the shared cover
screens, and `Atoms/CloseButton` shows the one close affordance `Dialog` and
`BottomSheet` both use. `Molecules/UndoToast` shows the undo/dismiss toast
with a launcher that replays it, including the disabled-Undo (paused timer)
state and a 360px phone variant; `Molecules/FocusPull` shows its initial view
and the exit/enter transition. `Templates/PipelineStatusChip`'s `Stalled`
story previews the stall copy against a fixed `nowSec` so it renders
deterministically instead of depending on a ticking clock — see
[design-system.md § Catalog boundary](../../docs/design-system.md#catalog-boundary-store-bound-components)
for which remaining components are store-bound and tracked as refactor
follow-ups instead of stories.

Full-viewport loading, error, and record entry screens share `ui/CoverScreen`.
It supplies the `main.cover` shell and centered content; callers provide an
optional heading, body content, and any existing shell classes. Keep status or
alert roles on the caller's content so each screen retains its own semantics.

## API adapters

`src/api.ts` is the stable named export facade used by components and tests. Domain adapters live in `src/api/`: project and media, waveform, document edits, pipeline and export jobs, shares and recording, bootstrap and diagnostics, comments, and session media. Internal adapters import each other directly rather than importing the facade. Document commands pass through `src/services/commandQueue.ts` and `src/api/documentTransport.ts` so host and guest queue semantics stay shared.

`src/commands/register.ts` is the stable DAW command registration facade. It calls focused registrars for navigation, editing, view, history, host operations, and project/media in the original order. Each registrar adds handlers to the one map in `src/commands/execute.ts`; `src/keymap/listener.ts` remains the only window shortcut listener. The track/clip mutation queue is shared through `src/commands/trackMutation.ts`. Keep browser actions and asynchronous guards with their owning registrar, and preserve the facade's blade runner and test reset exports.

## Testing

| Kind | Where | Notes |
|------|-------|-------|
| Unit | `src/**/*.test.ts` | Pure utils, session dedupe, share mode, theme init/resolution |
| Component + a11y | `src/**/*.test.tsx` | React Testing Library + Deque `axe-core` via `expectNoA11yViolations` |
| E2E smoke + a11y | `e2e/*.spec.ts` | Playwright + `@axe-core/playwright` via shared `expectPageAxeClean` (dense DAW) or `expectReadingSurfaceAxeClean` (Home / marketing HTML; required for green CI). Timeline helpers: `e2e/timelineZoom.ts` (`zoomTimelineIn`: focus the timeline, then bounded `=` presses; the first press must widen the ruler, optional scroll-range threshold or zoom ceiling) and `e2e/scroll.ts` (`scrollTimelineBy`). |
| Browser compatibility | `e2e-compat/*.spec.ts` | Cross-browser matrix for playback progress and stable Pause, IndexedDB comment queue persistence and command-identity replay, document update delivery after WebSocket reconnect, phone layout, synthetic-media recording consent, and deep-zoom geometry at the 15 M px content ceiling (`e2e/deepZoom.ts`); runs Chromium and Playwright WebKit with zero retries. Shared helpers: `e2e/queuedComment.ts` (comment route interception and host posting), `e2e/recordRoom.ts` (record rooms, E2E flag, record links), `e2e/syntheticMicrophone.ts` (oscillator mic stub) and `e2e/scroll.ts` (`scrollToEnd`, re-applied until the end is reachable; `scrollTimelineBy`, a clamped relative scroll). Set `E2E_BRANDED_CHROME=1` locally to also use installed Chrome. Real Safari, native microphone prompts and hardware capture, keeper audio, and upload still need separate acceptance. |
| Static a11y | oxlint `jsx-a11y` | Interaction + media rules are **errors** — fix the markup; do not add lint suppressions |
| TS hygiene | oxlint + `oxlint-tsgolint` (see `.oxlintrc.json`) | No explicit `any` / `@ts-*` escapes; `===`; `const`; no `var`; no `console` in `src/` (allowed in `scripts/`); type-aware promise + stringification hygiene (`options.typeAware`) |
| Theme tokens | Stylelint + pytest | Color, padding, margin, gap, font-size, radius outside `src/styles/theme/` must use `var(--…)`; hex only in theme files. Chrome rem (`meowtec/no-px`); canvas `px` needs `-- user-approved:`. Inline JS styles and Python-authored CSS colors: `tests/test_css_policy.py` |
| Motion | Stylelint + pytest | In partials, `transition*` / `animation*` time with `--motion-*` tokens, never a literal `ms`/`s` (`declaration-property-unit-disallowed-list`; stop motion with `none`); `tests/test_css_policy.py` also requires every one, loops included, inside `@media (prefers-reduced-motion: no-preference)` |
| `!important` / `@layer` / viewport `@media` | Stylelint + pytest | Default-off; allowed only with `stylelint-disable` + `-- user-approved:`. `tests/test_css_policy.py` does **not** strip comments. `font-size: 62.5%` is a hard ban |
| Format | Biome | `format:check` in CI; commit hook runs lint-staged (`biome check --write` on staged files; `make hooks`). Biome linter is off (oxlint + Stylelint own lint) |

Transcript word lookup and inclusive timeline ranges for clipboard, inspector, and
remote presence live in `src/utils/transcript.ts`. Ranges prefer mapped timeline
times and fall back to source times when absent; zero-length spans remain valid
for remote point selections but clipboard extraction requires a positive span.
Mix-minus sidetone uses the shared `src/utils/audio.ts` dB conversion.

Mobile transcript touch E2E should wait for an indexed word chip
(`data-transcript-word` with `data-word-index`) before measuring its box for
CDP touch events. The first unindexed chip can be a temporary turn-level
placeholder while the transcript hydrates.

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
| `tokens.css` | Sharecut Studio-only scales (`--space-*`, `--font-size-*`, `--motion-*`, `--z-*`), layout dims, legacy aliases |
| `theme-dark.css` | **Semantic tier:** dark `--color-*` roles mapped onto primitives |
| `theme-light.css` | **Semantic tier:** light `--color-*` roles + `prefers-color-scheme` when no `data-theme` |
| `../theme.css` | Imports bundled IBM Plex fonts, brand-tokens, primitives, then the three above |

Naming system (tiers, patterns, state modifiers, minting rules):
[docs/design-tokens.md](../../docs/design-tokens.md).

The timeline consumes its own `--color-timeline-*` stage roles: a dark well in
the dark theme and a light stage in the light theme (the transport strip stays
dark in both, via `theme/theme-fixed.css`). Chrome uses the five-rung semantic
surface ladder (`canvas`, `base`, `raised`, `overlay`, `sunken`, each with a
`text-on-*` partner) and named shadow levels. Press, hover, toggle, panel,
and state motion, and the three status loops, share `--motion-*` tokens and
run only when reduced motion is not requested. Playwright's `e2e/design-polish.spec.ts` checks both themes and
the reduced-motion path.

The light ladder uses a sage canvas (`#fbfdfc`), near-white pane
(`#f7f9f8`), and recessed well (`#eef1f0`); its timeline muted lane
(`#e9edeb`) has a separate semantic role. The dark palette remains warm
stone. Edit shared brand values in `deploy/brand/brand-tokens.css` and sync
its four copies; `tests/test_public_sites.py` enforces identical content.

Root switching (same CSS contract as marketing):

- `document.documentElement.dataset.theme = "light" | "dark"` overrides OS
- No `data-theme` → follow `prefers-color-scheme` on `:root:not([data-theme])`
- Preference persisted in `localStorage` key `daw_theme` via `hooks/useTheme.ts`
- Transport bar cycles system → dark → light

### Adding a token

1. **Shared brand / scale:** edit `deploy/brand/brand-tokens.css`, copy to public dirs and `src/styles/theme/brand-tokens.css`.
2. **Sharecut Studio-only:** declare the name in `theme/tokens.css` (legacy alias only if migrating old `var(--…)` call sites). For a new **color**: add the raw value to `theme/primitives.css` (`--primitive-<family>-<step>`), then map it onto a `--color-*` semantic role in both `theme-dark.css` and `theme-light.css` using the same selectors as brand-tokens. Never put raw hex in the theme files; never consume `--primitive-*` directly from components. See [docs/design-tokens.md](../../docs/design-tokens.md).
3. Use `var(--…)` in partials / components — **never** invent one-off hex/`rgb` outside `src/styles/theme/`. Stylelint enforces this in CI.

Domain CSS is split into `@import` partials from `src/styles/daw.css`, in cascade order: `partials/base.css`, `reading.css`, `layout.css` (shell grid, tabs, track headers), `timeline.css`, `inspector.css`, `panels.css`, `bottom-sheet.css`, `command-palette.css`, `ui.css` (library atoms), `transport.css` (the fixed-dark transport strip and the phone Listen card that shares its paint), `presence.css`, `ingest.css`, `record.css`, `responsive.css` (shells and breakpoints), and `stage.css` (timeline lighting and row interaction depth). `review-entry.css` and `record-entry.css` load subsets for the guest apps. Keep transport paint in `transport.css` only: it must import after `ui.css` and before `responsive.css`, so phone rules still override the strip.

## Responsive shells

See [`docs/gui-mobile.md`](../../docs/gui-mobile.md). Breakpoints: phone `<768`, tablet `768–1100`, desktop `>1100` (`hooks/useViewportClass.ts`). Phone uses `MobileShell` (Listen / Timeline / Text / More); tablet uses peek `BottomSheet` inspector; desktop keeps the Reaper grid with layouts (`Mod+1`–`4`) and transport **More** overflow.

## UI library (`src/ui/`)

Sharecut Studio chrome library — see [`docs/ui-library.md`](docs/ui-library.md) for charter, command-bus bridge, and catalog. Domain folders (`inspector/`, `panels/`, `timeline/`) stay and **compose** the library.

| Export | Use for |
|--------|---------|
| `Button` | `default` / `primary` / `danger` / `link` |
| `ToggleButton` | Toolbars / mode strips (`aria-pressed` + `.active`) — not exclusive tab panels |
| `CommandButton` / `useCommand` | Pointer → `execute(commandId)` (default `skipWhen`) |
| `Menu` / `CommandMenuItem` | Popup menus (Escape, arrows, outside click); closing returns focus to the opener unless focus already moved elsewhere (for example to a sibling menu's trigger) |
| `Dialog` / `useDialogModal` | Modal scrim+panel; trap + inert chrome |
| `BottomSheet` | Phone/tablet peek sheet (non-modal) |
| `Field` / `FieldRow` | Labeled control + hint; horizontal nudge row |
| `InlineError` | Non-pipeline error lines |
| `LoadingScreen` / `ErrorScreen` | App boot states |
| `DefinitionList` / `DefItem` | Inspector `<dl>` rows |
| `InspectorSeekFooter` | Seek + play-around footers |
| `LevelMeter` | Peak input meter (dBFS zones, peak hold, latching clip LED); drive it with `record/useInputPeakDb`. Concurrent input meters share one reference-counted metering `AudioContext` and one rAF scheduler; an individual processor stops when its meter leaves, and a failed frame reader is logged and removed without freezing other meters. The keeper capture graph retains its fixed-rate context. The silent AudioWorklet graph inspects every mic render block, including while the tab is hidden. Routine reports hold the latest level for at least two eight-block report intervals at the context's sample rate. Clip clear uses an audio-clock frame cutoff and worklet acknowledgement: a hot sample processed at or after that cutoff re-latches even if the clear command arrives later. The cutoff represents the AudioContext clock observed by the UI, not exact physical click time. The worklet is emitted as a file for CSP-compatible loading, and `audio/usePeakMeter.ts` handles visible level and peak hold. Wired into the record UI through `record/MicMeter` (#174) |
| `MicMeter` / `TakeClippingReport` | Own-mic meter with clip guidance, and the post-take clipping report (`record/`); clip regions come from the encoder path (`record/keeper/clipRegions.ts`, `takeClipping.ts`), not the meter |
| `ClipLed` | Clip indicator LED shared by `LevelMeter` and the REC indicator; sample peak only |

The command palette's **Actions** tab renders unbound catalog commands only
when `paletteRunnable` is not `false`. Mark commands that need arguments or a
timeline/transcript target as non-runnable there. This flag controls palette
visibility, not command permissions. Contextual controls perform their actions
through their own gesture or API paths; argument-taking commands can still run
through the command bus with the required input.

Store reads: read the DAW store only through `useDaw(selector)` (`state/useDaw.ts`, which wraps `useDawStore(useShallow(selector))`) or `useDawStore(selector)`. Select exactly the keys the component uses. Selectors return primitives or store references (or objects of those), never derived arrays or objects; build those with `useMemo` outside the selector, because `useShallow` compares one level deep and a fresh array re-renders every time. `state/storeGovernance.test.ts` fails on whole-store reads: `useDaw()` / `useDawStore()` with no selector, or an inline arrow identity selector such as `(s) => s` / `(s: DawState) => s` (also inside `useShallow(...)`). In tests, mock `useDaw` as `(sel) => sel(mockState)`.

Hot fields (`playheadSec`, `scrollLeft`, `sessionClients`, `pointerTrackId`, `bladeHoverSec`) change every playhead/scroll/presence frame; only a memoized leaf may select one directly (e.g. `layout/TransportTimecode.tsx`, `layout/PresenceStatus.tsx`), and a handler that only needs the value at call time reads `useDawStore.getState()` inside the callback instead. `state/storeGovernance.test.ts`'s `HOT_FIELD_ALLOWLIST` names every file allowed to select one, each with a reason; a whole-source scan fails on any other file that does (any `s.<field>` read, or a selector that reads one off its parameter under any name or destructures it, nested patterns included: an arrow or `function` (with or without a return-type annotation) passed inline to `useDaw`/`useDawStore`/`useShallow`, or a hoisted one whose parameter's type names `DawState`; brackets inside strings, template literals and comments are ignored). See `docs/gui-integration.md` § Render isolation for the full leaf list, the per-lane overlay slices (`timeline/laneOverlaySlices.ts`), and `document/reuseUnchanged.ts`.

The DAW state is one Zustand store (`state/dawStore.ts`) composed from project, transport, presence, and UI slice creators. Cross-slice actions such as `hydrate()` and `applyAgentSession()` use one store update so subscribers see a consistent snapshot. Mounted timeline and lane elements and the fixed-playhead lead pad live in `state/timelineViewportRegistry.ts`, outside reactive state; timeline mount/unmount code registers and clears them. Keep new DOM refs out of store slices, and keep `timelineViewportWidth` as the reactive measured/estimated value.

Mutations: prefer `hooks/useProjectMutation()` (`busy` / `error` / `run` / `refresh`) over local try/catch boilerplate.

For caught values, use `utils/apiError.errorMessage(error, fallback)` when the caller has a specific fallback for non-`Error` values. Omit the fallback only when showing the string form of any thrown value is intentional.

Comments: shared `src/comments/` (`CommentCard`, `CommentCompose`, `useCommentActions`).

## Layout constants

`utils/layout.ts` holds the default layout dims (`--ruler-height`, `--marker-lane-height`, lane height). At runtime `TimelineView` measures the stage and provides the live lane and marker-lane heights through `timeline/timelineMetrics.ts` (`useTimelineMetrics`), and sets `--lane-height` / `--marker-lane-height` on `.timeline-area`; overlays and headers read the context, never the constants. Presence `lane_pos` stays in lane units so viewers with different lane heights agree.
