# Sharecut Studio frontend (`gui/web`)

React + TypeScript + Vite UI for the podcast Sharecut Studio viewer and guest review app.

## Scripts

```bash
npm install
npm run dev         # Vite on :5173 (proxy /api → :8765)
npm run build
npm run storybook  # component catalog on :6006
npm run build-storybook  # static catalog under storybook-static/
npm run test:e2e:storybook  # build catalog, then check Chromium geometry on :6010
npm run typecheck   # tsc -b (strict; includes e2e/, e2e-compat/, and e2e-storybook/)
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
- `make test-web-e2e` — E2E-flagged build + Playwright against `aligned_dialogue`, then the Chromium/WebKit compat matrix (CI runs the suites concurrently on separate runners behind the `frontend-e2e` gate). Ordinary `npm run build` rejects emitted E2E hooks.
- `npm run test:e2e:compat` — focused Chromium/WebKit compatibility matrix only (`npm run test:e2e:install` installs both engines)

Storybook uses the real `src/ui/` components and theme tokens. See
[`docs/design-system.md`](../../docs/design-system.md) for story conventions and
the GitHub Pages publishing setup. Pull requests build the catalog without
deploying it. The workflow runs `test:e2e:storybook` against the built catalog,
including production boundary stories with restored-word fixtures. Real mouse
trajectories cover
1440px and 360px widths in both themes, stable neighboring text and row geometry,
bounded previews, and Escape cleanup. Install Chromium with
`npx playwright install chromium` before running this focused suite locally.
The suite also checks opened menu and avatar panels in Canvas and Docs,
fixed popovers, and modal and shell isolation at desktop and phone widths.
Use `src/storybook/storyLayout.tsx` for menu spacing and isolated Docs
viewports. Fixed overlays, body portals, and viewport shells render in
separate `40rem` Docs frames that follow the Docs theme toolbar. Previews
keep a `22.5rem` minimum width, or `70rem` for desktop chrome, with horizontal
scrolling inside the Docs canvas. Ordinary components stay inline.
Use standalone Canvas Controls for isolated examples; Storybook does not
connect Docs Controls to iframe stories.
Begin with **Style guide → Start here** for live type/spacing samples,
interactive control states, and links to the component docs and design rules.
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
`Templates/PendingEditOverlay` previews the production `PendingEditOverlayView`
with fictional remove, mute and split suggestions, a selected edit, an
end-handle drag, and filtered and 360px lanes. The live adapter commits
`UpdatePendingEdit`.
`Templates/MarkerLane` previews the production `MarkerLaneView` with
fictional chapters, a social clip, comments and a clipping flag, plus
selected, read-only, empty and 360px variants. The live adapter commits
`UpdateChapter` / `UpdateSocialClip` on host projects only.
`Templates/ClipBlock` previews the production `ClipBlockView` in the shared
lane shell: an editable clip with fade ramps, corner fade handles and
regions, a selected crossfade
join, a trim preview with its ghost, a fade readout, a read-only clip and a
360px clip with its track name. The live `ClipBlock` (memo over
`ClipBlockLive`) owns the gestures and commits; the catalog omits the
store-bound waveform.
`Templates/JoinBadge` previews the production `JoinBadgeView` in the shared
lane shell: cut, fade, crossfade and a blocked crossfade, one story each plus
all four side by side, so the glyphs can be compared at lane scale. The live
`TrackLane` decides which joins draw one.
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
`Templates/TrackMix` renders the production `TrackMixView` with controlled six,
many, long-name, saved/implied mute, read-only, loading, and empty fixtures.
`TrackMix` owns one non-hot selector and projects rows outside it; the view owns
only list composition and shared control presentation. `MobileShellView` takes
a closed/Inspector/Mix discriminated sheet; `MobileShell` owns transient Mix
eligibility in the originating More hub. `MoreMix` adds a controlled shell play.

`Templates/TrackFader` uses the production `TrackFaderView` shared with the
inspector and compact Mix rows. Controlled fixtures cover Reset and focus return, read-only saved
volume, stale Balance, non-dialogue tracks, and a 360px frame. The view keeps
range drafts and their output notes together. The live `TrackFader` adapter
retains capability checks and dispatches native-change commits through
`track.setVolume`; stories use local saved dB state and callback spies.
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
`Templates/EditBoundaryMark` previews the production `EditBoundaryMarkView`
inline in a transcript row, with a roll join, a live roll drag, a
single-clip trim edge and a 360px row. The live adapter commits
`RollClipJoin` / `TrimClipEdge`.
`Templates/HostMcpDialog` and `Templates/GesturesSheet` show the shipped
agent-connection and mobile gesture dialogs. The MCP story passes a fixed
loopback URL so its preview is independent of Storybook's port; the live
dialog derives its local URL as before.
Standalone Canvas stories and isolated autodocs frames open their dialogs
through Canvas play functions, so each can be inspected independently.
Play functions share
`openDialogViaLauncher` from `src/storybook/openDialog.ts`. The gesture callback closes its sheet and
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

`Templates/MobileShell` and `Templates/StudioShell` compose the props-only
production `MobileShellView` and `StudioShellView`. The mobile frame is 360 CSS
pixels wide. Studio fixtures include desktop, tablet, guest, loading, ingest,
and inspector states. Play functions forward callbacks to `fn()` spies while
updating local state. Chromium checks in `e2e-storybook/shells.spec.ts` cover fit,
usable body height, navigation, keyboard panel resizing, and inspector portals
in both themes.

The shell views own layout, mode navigation, editor tabs, guest visibility,
More-back, ingest coach, and sheet markup. Their live adapters retain selectors,
commands, focus and presence bindings, gestures, sheet policy, and the memoized
timeline header slot. Stories use a representative `TransportFrame` with
production play and tool controls. Full `TransportBar`, Listen/More bodies,
connected panels, and the complete DAW timeline remain runtime integration scope.
Shared fictional regions live in catalog-only `layout/shellStoryFixtures.tsx`.
Their factory data lives in catalog-only `layout/shellStoryData.ts`.

Full-viewport loading, error, and record entry screens share `ui/CoverScreen`.
It supplies the `main.cover` shell and centered content; callers provide an
optional heading, body content, and any existing shell classes. Keep status or
alert roles on the caller's content so each screen retains its own semantics.

## API adapters

`src/api.ts` is the stable named export facade used by components and tests. Domain adapters live in `src/api/`: project and media, waveform, document edits, pipeline and export jobs, shares and recording, bootstrap and diagnostics, comments, and session media. Internal adapters import each other directly rather than importing the facade. Document commands pass through `src/services/commandQueue.ts` and `src/api/documentTransport.ts` so host and guest queue semantics stay shared.

`src/commands/register.ts` is the stable DAW command registration facade. It calls focused registrars for navigation, editing, view, history, host operations, and project/media in the original order. Each registrar adds handlers to the one map in `src/commands/execute.ts`; `src/keymap/listener.ts` remains the only window shortcut listener. The track/clip mutation queue is shared through `src/commands/trackMutation.ts`. `src/commands/singleFlight.ts` supplies one-slot guards for transcript ignore, Tighten mutations, and deliverables export. Each registrar keeps its own validation order and busy result. Project open/new retain their bespoke guards because they return success while busy and New holds its guard through a retry window. Tests reset the shared guards through the registration facade.

Pointer handlers use `runPointerCommand(id, args)` from `src/commands/pointer.ts`.
It dispatches without keyboard `when` gates and returns `void`.
Use `executePointerCommand(id, args)` when a pointer handler needs to await a
result or clear busy state after completion. It returns the command's original
`ExecuteResult` promise, including rejections. Both helpers share one gate policy.
`CommandButton` and `useCommand` retain their configurable gate policy.
The keymap listener evaluates keyboard gates before dispatch. DAW WebMCP play
uses `execute` through its agent adapter. DAW transport seeking uses
`src/commands/seek.ts`, which returns the pointer command result for callers
that need to await it. Listen skip math stays in `src/layout/listenSeek.ts`;
timeline callers keep their selection and blade actions after the seek
dispatch, and WebMCP awaits the shared helper.
`commands/governance.test.ts` rejects inline `skipWhen: true` outside the pointer
helper, keymap listener, and WebMCP adapter.

## Testing

| Kind | Where | Notes |
|------|-------|-------|
| Unit | `src/**/*.test.ts` | Pure utils, session dedupe, share mode, theme init/resolution |
| Component + a11y | `src/**/*.test.tsx` | React Testing Library + Deque `axe-core` via `expectNoA11yViolations` |
| E2E smoke + a11y | `e2e/*.spec.ts` | Playwright + `@axe-core/playwright` via shared `expectPageAxeClean` (dense DAW) or `expectReadingSurfaceAxeClean` (Home / marketing HTML; required for green CI). Timeline helpers: `e2e/timelineZoom.ts` (`zoomTimelineIn`: focus the timeline, then bounded `=` presses; the first press must widen the ruler, optional scroll-range threshold or zoom ceiling) and `e2e/scroll.ts` (`scrollTimelineBy`). |
| Browser compatibility | `e2e-compat/*.spec.ts` | Cross-browser matrix for playback progress and stable Pause, IndexedDB comment queue persistence and command-identity replay, document update delivery after WebSocket reconnect, phone layout, synthetic-media recording consent, deep-zoom geometry at the 15 M px content ceiling (`e2e/deepZoom.ts`; `e2e/deepZoom.test.ts` validates the stretched fixture with the episode schema and malformed clip/envelope values), and a core-flow walk on both engines (`e2e-compat/core-flow.spec.ts`: keeper capture → upload → landing with a non-silent peak, transcript hydrate and word correct/undo, Tighten empty state, viewer-share MP3 proxy playback, host Bounce (full-page axe with the dialog open) to a non-silent WAV; #704 turned WebKit on, via `e2e/keeperContexts.ts`'s `RECORDER_CONTEXT` microphone grant and `keeperContextSource`'s `launchPersistentContext("")` for WebKit's OPFS gap); runs Chromium and Playwright WebKit with zero retries. Shared helpers: `e2e/queuedComment.ts` (comment route interception and host posting), `e2e/recordRoom.ts` (record rooms, E2E flag, record links, `openHostRecordRoom`, `ensureHostRecordCommand`, `clickHostTransport`, `landParticipant`, `joinAsGuest`, `fillGuestDisplayName`, `joinAsProducer`, `fillDisplayNameField`), `e2e/keeperContexts.ts` (`RECORDER_CONTEXT`, `keeperContextSource`), `e2e/keeperOpfs.ts` (keeper OPFS inspection), `e2e/wavPeak.ts` (landed and bounced WAV peaks), `e2e/playback.ts` (`expectPlaybackAdvancesThenHolds`), `e2e/transcriptEdit.ts` (`openTranscriptPanel`, `withDocumentCommandTypes`), `e2e/exportFiles.ts` (`bouncedWavs`), `e2e/launchOptions.ts` (`withLaunchArgs` on top of the base launch options; `CHROMIUM_FAKE_MEDIA_ARGS`, the fake-media flags shared by the compat Chromium projects and the main suite's record specs), `e2e/shareNavigation.ts` (`createReviewShare` for guest review shares), `e2e/syntheticMicrophone.ts` (oscillator mic stub) and `e2e/scroll.ts` (`scrollToEnd`, re-applied until the end is reachable; `scrollTimelineBy`, a clamped relative scroll). Set `E2E_BRANDED_CHROME=1` locally to also use installed Chrome. Per-engine results (Chromium, WebKit, Firefox) and what stays manual (Apple Safari and Private Browsing, native microphone prompts, hardware capture): [docs/testing.md § Browser acceptance matrix](../../docs/testing.md#browser-acceptance-matrix), guarded by `tests/test_browser_acceptance_matrix.py`. |
| Static a11y | oxlint `jsx-a11y` | Interaction + media rules are **errors** — fix the markup; do not add lint suppressions |
| TS hygiene | oxlint + `oxlint-tsgolint` (see `.oxlintrc.json`) | No explicit `any` / `@ts-*` escapes; `===`; `const`; no `var`; no `console` in `src/` (allowed in `scripts/`); type-aware promise + stringification hygiene (`options.typeAware`) |
| Theme tokens | Stylelint + pytest | Color, padding, margin, gap, font-size, radius outside `src/styles/theme/` must use `var(--…)`; the five timeline partials also require `--z-*` roles for positive z-index values. Hex only in theme files. Chrome rem (`meowtec/no-px`); canvas `px` needs `-- user-approved:`. Inline JS styles and Python-authored CSS colors: `tests/test_css_policy.py` |
| Motion | Stylelint + pytest | In partials, `transition*` / `animation*` time with `--motion-*` tokens, never a literal `ms`/`s` (`declaration-property-unit-disallowed-list`; stop motion with `none`); `tests/test_css_policy.py` also requires every one, loops included, inside `@media (prefers-reduced-motion: no-preference)` |
| `!important` / `@layer` / viewport `@media` | Stylelint + pytest | Default-off; allowed only with `stylelint-disable` + `-- user-approved:`. `tests/test_css_policy.py` does **not** strip comments. `font-size: 62.5%` is a hard ban |
| Format | Biome | `format:check` in CI; commit hook runs lint-staged (`biome check --write` on staged files; `make hooks`). Biome linter is off (oxlint + Stylelint own lint) |

`e2e-compat/timeline-scroll-end.spec.ts` checks that short desktop lanes can
reach the horizontal end with a rem-sized classic scrollbar on Chromium and
WebKit. `e2e/scroll.ts` permits only 2 px of fractional scroll rounding.

Keep component state, validation and mocked error recovery in Vitest. Browser
specs should protect layout/native input/media/storage/network seams or complete
user outcomes. Before pruning a browser case, name its remaining coverage owner.
See [Browser test scope and runtime](../../docs/testing.md#browser-test-scope-and-runtime)
for placement rules and the CI `playwright-reports-<name>` timing artifacts
(`main-1of4` ... `main-4of4`, `compat`). Each suite's live project is shared,
so Playwright requires one worker. CI shards the main suite and runs the compat
suite on separate runners; the existing `frontend-e2e` check requires every one
to succeed.

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

`src/utils/useStableCallback.test.tsx` scans production `.ts` and `.tsx` files
and proves detection by inserting a direct call after each of the ten current
stable callback declarations in memory. The pure test helper accepts
`SourceInput` with `rel` and `text` and returns ordered `RenderCall` diagnostics
with file, one-based line and column, and callback name. Parse errors fail the
test. `src/test/stableCallbackGovernance.test.ts` contains execution-boundary
fixtures with literal diagnostics and valid deferred or shadowed uses.
Mutation discovery filters for the current hook spelling before parsing; the
separate production scan still parses and checks every production source file.

The check follows direct, unreassigned local variables initialized by the actual imported
`useStableCallback`, including import aliases and namespace imports. Babel's
typed AST and scope bindings handle lexical shadowing and TypeScript expression
wrappers, including `satisfies`. Calls during the owner's evaluation include
JSX expressions, optional calls, `.call`, `.apply`, synchronous inline IIFEs,
and React's imported `useMemo`, lazy `useState`, and `useReducer` initializers.
React default imports include the equivalent `{ default as React }` form.
Member names must be noncomputed identifiers or computed string literals.
Computed keys, class heritage, static fields, and static blocks are eager.
Creating methods, getters, or instance fields does not execute their bodies.

Parameter handling is deliberately syntactic. For synchronous inline functions,
default expressions are checked for omitted arguments, unshadowed `undefined`,
and `void` of a numeric literal. Supplied non-undefined literal arguments do not
activate those defaults. Shallow destructuring defaults are checked with empty
object or array literals, supplied directly or through a parameter default.
`useMemo` and lazy `useState` supply no arguments. A `useReducer` initializer
receives its initial argument. Dynamic arguments, spreads before the parameter,
nonempty destructuring arguments, and nested destructuring are outside this
parameter policy. There is no value evaluator or branch-reachability analysis.

The check does not enter async or generator functions, follow callback aliases,
reassignments, named helper calls, child props, or arbitrary callback APIs.
Passing the check covers these local forms only. Enforcement runs in tests and
adds no runtime guard. The executable hook and its callers remain unchanged.
The runtime suite checks stable identity, latest arguments, child layout effects,
StrictMode, a same-state render bailout, and an uncommitted Suspense transition
followed by commit.

`@babel/traverse` 7.29.8, `@babel/types` 7.29.8, and
`@types/babel__traverse` 7.28.0 are direct dev dependencies for this test helper
and its independent mutation traversal. They replace a partial custom scope
resolver and keep parser nodes typed. Production modules do not import the
policy or these test dependencies. See the [Babel traversal documentation](https://babeljs.io/docs/babel-traverse).

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

Resize tests: `stubResizeObserver()` from `src/test/resizeObserver.ts` installs the shared `FakeResizeObserver` (records `targets`, reports every watched target on `fire()`, or one with `fire(el)`, or at once on `observe()` with `{ reportOnObserve: true }`); `FakeResizeObserver.of(el)` returns the observer watching `el` or throws; do not declare a local ResizeObserver class (`ui/useResizeObserver.test.tsx` enforces this).

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

Timeline stacking roles and their layer order are documented in
[`docs/design-tokens.md`](../../docs/design-tokens.md#elevation).

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

See [`docs/gui-mobile.md`](../../docs/gui-mobile.md). Breakpoints: phone `<768`, tablet `768–1100`, desktop `>1100` (`hooks/useViewportClass.ts`). Phone uses the `MobileShell` adapter over `MobileShellView` (Listen / Timeline / Text / More); tablet uses peek `BottomSheet` inspector; desktop keeps the Reaper grid with layouts (`Mod+1`–`4`) and transport **More** overflow.

## UI library (`src/ui/`)

Sharecut Studio chrome library — see [`docs/ui-library.md`](docs/ui-library.md) for charter, command-bus bridge, and catalog. Domain folders (`inspector/`, `panels/`, `timeline/`) stay and **compose** the library.

| Export | Use for |
|--------|---------|
| `Button` | `default` / `primary` / `danger` / `link` |
| `ToggleButton` | Toolbars / mode strips (`aria-pressed` + `.active`) — not exclusive tab panels |
| `CommandButton` / `useCommand` | Pointer → `execute(commandId)` (default `skipWhen`) |
| `Menu` / `CommandMenuItem` | Popup menus (Escape, arrows, outside click); closing returns focus to the opener unless focus already moved elsewhere (for example to a sibling menu's trigger) |
| `Dialog` / `useDialogModal` | Modal scrim+panel; trap + inert chrome |
| `useResizeObserver` | Resize → callback (one observer, latest callback, `enabled`); never `new ResizeObserver` inline |
| `BottomSheet` | Phone/tablet peek sheet (non-modal) |
| `Field` / `FieldRow` | Labeled control + hint; horizontal nudge row |
| `InlineError` | Non-pipeline error lines |
| `LoadingScreen` / `ErrorScreen` | App boot states |
| `DefinitionList` / `DefItem` | Inspector `<dl>` rows |
| `InspectorSeekFooter` | Seek + play-around footers |
| `LevelMeter` | Peak input meter (dBFS zones, peak hold, latching clip LED); drive it with `record/useInputPeakDb`. Concurrent input meters share one reference-counted metering `AudioContext` and one rAF scheduler; an individual processor stops when its meter leaves, and a failed frame reader is logged and removed without freezing other meters. The keeper capture graph retains its fixed-rate context. The silent AudioWorklet graph inspects every mic render block, including while the tab is hidden. Routine reports hold the latest level for at least two eight-block report intervals at the context's sample rate. Clip clear uses an audio-clock frame cutoff and worklet acknowledgement: a hot sample processed at or after that cutoff re-latches even if the clear command arrives later. The cutoff represents the AudioContext clock observed by the UI, not exact physical click time. The worklet is emitted as a file for CSP-compatible loading, and `audio/usePeakMeter.ts` handles visible level and peak hold. Wired into the record UI through `record/MicMeter` (#174) |
| `MicMeter` / `TakeClippingReport` | Own-mic meter with clip guidance, and the post-take clipping report (`record/`); clip regions come from the encoder path (`record/keeper/clipRegions.ts`, `takeClipping.ts`), not the meter |
| `TrackPlaybackMeter` | Track-output sample peaks during local and guest proxy playback, using `LevelMeter`. Clip lights persist across transport stops until cleared. Silent host monitors preserve premix audio; proxy taps follow the track gain. Missing monitor media and premix-only guest fallback readings are unavailable. Reduced motion freezes bars and peak markers while retaining clip detection. Sampling stops when playback stops. |
| `ClipLed` | Clip indicator LED shared by `LevelMeter` and the REC indicator; sample peak only |

The command palette's **Actions** tab renders unbound catalog commands only
when `paletteRunnable` is not `false`. Mark commands that need arguments or a
timeline/transcript target as non-runnable there. This flag controls palette
visibility, not command permissions. Contextual controls perform their actions
through their own gesture or API paths; argument-taking commands can still run
through the command bus with the required input.

Store reads: read the DAW store only through `useDaw(selector)` (`state/useDaw.ts`, which wraps `useDawStore(useShallow(selector))`) or `useDawStore(selector)`. Use `pickDaw("projectPath", "isPlaying")` at module scope for plain field selectors. Pass literal key arguments; governance rejects computed arguments and checks literal hot-field keys against its allowlist. Use a custom `useDaw` selector for conditional projections of store values. Select exactly the values the component uses. Build derived arrays and objects outside the selector with `useMemo`; fresh nested values defeat the one-level `useShallow` comparison. Fresh top-level projections of unchanged store values keep their selected reference. The governance test fails on whole-store reads: `useDaw()` / `useDawStore()` with no selector, or an inline arrow identity selector such as `(s) => s` / `(s: DawState) => s` (also inside `useShallow(...)`). In tests, mock `useDaw` as `(sel) => sel(mockState)`.

Hot fields (`playheadSec`, `scrollLeft`, `sessionClients`, `pointerTrackId`, `bladeHoverSec`) change every playhead/scroll/presence frame; only a memoized leaf may select one directly (e.g. `layout/TransportTimecode.tsx`, `layout/PresenceStatus.tsx`), and a handler that only needs the value at call time reads `useDawStore.getState()` inside the callback instead. `state/storeGovernance.test.ts`'s `HOT_FIELD_ALLOWLIST` names every file allowed to select one, each with a reason; a whole-source scan fails on any other file that does (any `s.<field>` read, or a selector that reads one off its parameter under any name or destructures it, nested patterns included: an arrow or `function` (with or without a return-type annotation) passed inline to `useDaw`/`useDawStore`/`useShallow`, or a hoisted one whose parameter's type names `DawState`; brackets inside strings, template literals and comments are ignored). See `docs/gui-integration.md` § Render isolation for the full leaf list, the per-lane overlay slices (`timeline/laneOverlaySlices.ts`), and `document/reuseUnchanged.ts`.

The DAW state is one Zustand store (`state/dawStore.ts`) composed from project, transport, presence, and UI slice creators. Cross-slice actions such as `hydrate()` and `applyAgentSession()` use one store update so subscribers see a consistent snapshot. Mounted timeline and lane elements and the fixed-playhead lead pad live in `state/timelineViewportRegistry.ts`, outside reactive state; timeline mount/unmount code registers and clears them. Keep new DOM refs out of store slices, and keep `timelineViewportWidth` as the reactive measured/estimated value.

Mutations: prefer `hooks/useProjectMutation()` (`busy` / `error` / `run` / `refresh`) over local try/catch boilerplate.

Double-submit guards: use `hooks/useSingleFlight()` (`busy` / `run`) instead of a hand-written ref + state pair; it drops a second `run` before `busy` re-renders (used by `useBootstrapDownload`, keeper recovery actions and Pipeline **Re-time words**).

For caught values, use `utils/apiError.errorMessage(error, fallback)` when the caller has a specific fallback for non-`Error` values. Omit the fallback only when showing the string form of any thrown value is intentional.

Comments: shared `src/comments/` (`CommentCard`, `CommentCompose`, `useCommentActions`).

## Layout constants

`utils/layout.ts` holds the default layout dims (`--ruler-height`, `--marker-lane-height`, lane height). At runtime `TimelineView` measures the stage and provides the live lane and marker-lane heights through `timeline/timelineMetrics.ts` (`useTimelineMetrics`), and sets `--lane-height` / `--marker-lane-height` on `.timeline-area`; overlays and headers read the context, never the constants. Presence `lane_pos` stays in lane units so viewers with different lane heights agree.

The Wordbar (`transcript/TranscriptWordbar.tsx`) edits exact source-word timing through the document command bus. It uses native range/number controls, the shared waveform with an explicit local viewport, and an owned source-preview descriptor consumed by the existing audio transport. Draft pointer movement does not publish session state or write document commands.

## GUI surface verification

The [full GUI audit](../../docs/gui-surface-audit.md) separates source, catalog
and live-route coverage. `e2e/gui-surfaces.spec.ts` checks responsive panels,
long content and modal/menu keyboard behavior with contrast enabled. Recording
room and upload/recovery states are available in Storybook as prop-driven
examples. Run browser wrappers sequentially with fixture/environment unit tests
so their shared workspace-marker lifecycle does not overlap.

The live `e2e/edit-boundary-archive.spec.ts` regression cuts a disposable episode, drags the resulting transcript boundary, verifies the restored word after reload, and exercises undo/redo. Run `npm run test:e2e -- e2e/edit-boundary-archive.spec.ts` after `VITE_SHARECUT_E2E=1 npm run build`.

### Profile editor responsiveness

Part of #879. Build the production frontend with `npm run build`, then use the
[large-project browser profile](../../docs/testing.md#large-project-browser-profile)
recipe with a fresh generated project for each repetition. Set `DAW_PROFILE_OUT`
to retain `report.json` and a separate diagnostic `chrome-trace.json`. Keep the
`large-project.spec.ts` filter, disable retries, and use `--trace=off` for primary
repetitions. The separate Chrome trace covers a diagnostic action.

The report separates driver wall time, page-local rAF intervals, long tasks,
individual CDP duration counters, and post-GC heap checkpoints. It records
measurement availability, actual served asset hashes, environment, input labels,
and actual prebuilt waveform content identity. Native zoom, horizontal wheel
scroll, and ruler click retain visible outcomes; other scrolling is explicitly
programmatic. Synthetic progress remains not run because its real bar stayed
zero-height after ordinary panel resizing; no width-transition result is claimed.
Failed actions retain partial evidence and still fail the test. Traced diagnostic samples and primary samples have different phases.
Read the testing guide before comparing runs. These measurements have no timing
CI threshold and make no physical-device, audio-quality, or speedup claim.
